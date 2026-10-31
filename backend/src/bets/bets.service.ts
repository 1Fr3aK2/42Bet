import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Bet } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { KrakenService } from '../crypto/kraken.service';
import { CreateBetDto } from './dto/create-bet.dto';
import { ListBetsDto } from './dto/list-bets.dto';
import {
  BET_DURATION_SECONDS,
  LATE_SETTLEMENT_MS,
  PAYOUT_MULTIPLIER,
  SETTLEMENT_INTERVAL_MS,
} from './bets.constants';

@Injectable()
export class BetsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BetsService.name);
  private timer: NodeJS.Timeout | null = null;
  private settling = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly kraken: KrakenService,
    private readonly events: EventEmitter2,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => this.settleDueBets(), SETTLEMENT_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async getBalance(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { wallet: true },
    });
    if (!user) throw new NotFoundException('User not found');

    return { balance: user.wallet };
  }

  async placeBet(userId: number, dto: CreateBetDto) {
    const coin = dto.coin.toUpperCase();

    // The entry price comes from the server's live Kraken feed, never from the client.
    const ticker = this.kraken.getTicker(`${coin}/EUR`);
    if (!ticker) throw new BadRequestException(`No live price for ${coin}`);

    const result = await this.prisma.$transaction(async (tx) => {
      // Debit the stake only if the balance covers it. This single
      // "UPDATE ... WHERE wallet >= amount" is atomic in PostgreSQL, so bets
      // sent at the same time can never take the balance below zero.
      const debited = await tx.user.updateMany({
        where: { id: userId, wallet: { gte: dto.amount } },
        data: { wallet: { decrement: dto.amount } },
      });
      if (debited.count === 0) {
        const exists = await tx.user.count({ where: { id: userId } });
        if (!exists) throw new NotFoundException('User not found');
        throw new BadRequestException('Insufficient balance');
      }

      const bet = await tx.bet.create({
        data: {
          userId,
          coin,
          direction: dto.direction,
          amount: dto.amount,
          entryPrice: ticker.last,
          expiresAt: new Date(Date.now() + BET_DURATION_SECONDS * 1000),
        },
      });
      const user = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { wallet: true },
      });

      return { bet, balance: user.wallet };
    });

    // Tells the user's open pages (BetsGateway) that their bets changed.
    this.events.emit('bets.changed', { userId });
    return result;
  }

  listBets(userId: number, query: ListBetsDto) {
    return this.prisma.bet.findMany({
      where: {
        userId,
        ...(query.status === 'active' && { status: 'active' }),
        ...(query.status === 'settled' && { status: { not: 'active' } }),
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit ?? 20,
    });
  }

  // Runs every SETTLEMENT_INTERVAL_MS and settles every bet whose time is up.
  private async settleDueBets() {
    if (this.settling) return; // the previous run is still working
    this.settling = true;

    try {
      const due = await this.prisma.bet.findMany({
        where: { status: 'active', expiresAt: { lte: new Date() } },
        orderBy: { expiresAt: 'asc' },
        take: 100,
      });
      for (const bet of due) {
        await this.settle(bet);
      }
    } catch (error) {
      this.logger.error(`Bet settlement failed: ${error.message}`);
    } finally {
      this.settling = false;
    }
  }

  private async settle(bet: Bet) {
    const late = Date.now() - bet.expiresAt.getTime() > LATE_SETTLEMENT_MS;
    const exitPrice = late ? null : this.kraken.getTicker(`${bet.coin}/EUR`)?.last ?? null;
    if (exitPrice === null && !late) return; // no live price yet: try again on the next run

    // Same price (or settled too late to know the real end price): stake refunded.
    let status: 'won' | 'lost' | 'refunded';
    if (exitPrice === null || exitPrice === bet.entryPrice) {
      status = 'refunded';
    } else {
      const wentUp = exitPrice > bet.entryPrice;
      status = wentUp === (bet.direction === 'up') ? 'won' : 'lost';
    }

    let payout = 0;
    if (status === 'won') payout = Math.floor(bet.amount * PAYOUT_MULTIPLIER);
    if (status === 'refunded') payout = bet.amount;

    const settled = await this.prisma.$transaction(async (tx) => {
      // Only the run that moves the bet out of "active" pays it, so a bet can
      // never be paid twice.
      const updated = await tx.bet.updateMany({
        where: { id: bet.id, status: 'active' },
        data: { status, exitPrice, payout, settledAt: new Date() },
      });
      if (updated.count === 0) return false;

      await tx.user.update({
        where: { id: bet.userId },
        data: {
          wallet: { increment: payout },
          ...(status === 'won' && { wins: { increment: 1 } }),
          ...(status === 'lost' && { losses: { increment: 1 } }),
        },
      });
      return true;
    });
    if (!settled) return;

    this.events.emit('bets.changed', { userId: bet.userId });

    this.logger.log(
      `Bet ${bet.id} ${status}: ${bet.coin} ${bet.direction} ${bet.amount} T$, ` +
        `${bet.entryPrice} -> ${exitPrice ?? 'n/a'}, payout ${payout} T$`,
    );
  }
}
