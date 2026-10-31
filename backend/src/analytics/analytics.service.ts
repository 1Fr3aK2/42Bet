import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Bet } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsQueryDto } from './dto/analytics-query.dto';

// Newest bets sent back for the table and the exports.
const MAX_BETS_RETURNED = 500;

const sum = (bets: Bet[], value: (bet: Bet) => number) => bets.reduce((total, bet) => total + value(bet), 0);
const round1 = (n: number) => Math.round(n * 10) / 10;
const winRate = (won: number, lost: number) => (won + lost ? round1((won / (won + lost)) * 100) : null);
// Profit of a settled bet: what came back minus the stake.
const profitOf = (bet: Bet) => bet.payout - bet.amount;

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async getAnalytics(userId: number, query: AnalyticsQueryDto) {
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    if (from && to && from > to) throw new BadRequestException('from must be before to');

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { wallet: true },
    });
    if (!user) throw new NotFoundException('User not found');

    // Every filter applies to the bets placed in the period.
    const bets = await this.prisma.bet.findMany({
      where: {
        userId,
        ...(query.coin && { coin: query.coin.toUpperCase() }),
        ...(query.direction && { direction: query.direction }),
        createdAt: { gte: from, lte: to },
      },
      orderBy: { createdAt: 'asc' },
    });
    const settled = bets
      .filter((bet) => bet.status !== 'active')
      .sort((a, b) => a.settledAt.getTime() - b.settledAt.getTime());

    const won = settled.filter((bet) => bet.status === 'won').length;
    const lost = settled.filter((bet) => bet.status === 'lost').length;
    const profits = settled.map(profitOf);
    const summary = {
      balance: user.wallet,
      bets: bets.length,
      active: bets.length - settled.length,
      won,
      lost,
      refunded: settled.length - won - lost,
      winRate: winRate(won, lost),
      wagered: sum(bets, (bet) => bet.amount),
      paidOut: sum(settled, (bet) => bet.payout),
      profit: sum(settled, profitOf),
      bestBet: profits.length ? Math.max(...profits) : null,
      worstBet: profits.length ? Math.min(...profits) : null,
    };

    // Running total of the profit, one point per settled bet.
    let running = 0;
    const profitOverTime = settled.map((bet) => {
      running += profitOf(bet);
      return { time: bet.settledAt.toISOString(), profit: running };
    });

    // Profit per day, in the user's local time.
    const offsetMs = (query.tzOffset ?? 0) * 60 * 1000;
    const days = new Map<string, { day: string; profit: number; bets: number }>();
    for (const bet of settled) {
      const day = new Date(bet.settledAt.getTime() - offsetMs).toISOString().slice(0, 10);
      const entry = days.get(day) ?? { day, profit: 0, bets: 0 };
      entry.profit += profitOf(bet);
      entry.bets += 1;
      days.set(day, entry);
    }

    return {
      summary,
      profitOverTime,
      profitByDay: [...days.values()],
      byCoin: this.groupBy(bets, (bet) => bet.coin),
      byDirection: this.groupBy(bets, (bet) => bet.direction),
      bets: bets.slice(-MAX_BETS_RETURNED).reverse(),
      betsTruncated: bets.length > MAX_BETS_RETURNED,
    };
  }

  // Counts and profit of the bets grouped by coin or by direction.
  private groupBy(bets: Bet[], key: (bet: Bet) => string) {
    const groups = new Map<string, Bet[]>();
    for (const bet of bets) groups.set(key(bet), [...(groups.get(key(bet)) ?? []), bet]);

    return [...groups].map(([name, list]) => {
      const settled = list.filter((bet) => bet.status !== 'active');
      const won = settled.filter((bet) => bet.status === 'won').length;
      const lost = settled.filter((bet) => bet.status === 'lost').length;
      return {
        name,
        bets: list.length,
        won,
        lost,
        refunded: settled.length - won - lost,
        winRate: winRate(won, lost),
        profit: sum(settled, profitOf),
      };
    });
  }
}
