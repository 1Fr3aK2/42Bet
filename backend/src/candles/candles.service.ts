import { BadGatewayException, BadRequestException, Injectable, Logger } from '@nestjs/common';

// Kraken pair of each coin of the game: the same exchange and coins as the
// live feed (crypto/kraken.service.ts) that also settles the bets.
const PAIRS: Record<string, string> = { BTC: 'XBTEUR', ETH: 'ETHEUR' };

// Kraken's public REST API allows about one call per second per address, so
// each list of candles is kept for a few seconds and shared by every browser.
// Between two loads, the browser moves the last candle with the live price.
const CACHE_MS = 15000;

export interface Candle {
  time: number; // start of the candle, in seconds since 1970 (UTC)
  open: number;
  high: number;
  low: number;
  close: number;
}

@Injectable()
export class CandlesService {
  private readonly logger = new Logger(CandlesService.name);
  private readonly cache = new Map<string, { at: number; candles: Candle[] }>();

  // The last 720 candles of `interval` minutes (Kraken's maximum), oldest first.
  // The newest one is still open: its close is the latest price.
  async getCandles(coin: string, interval: number): Promise<Candle[]> {
    const pair = PAIRS[coin.toUpperCase()];
    if (!pair) throw new BadRequestException(`No candles for ${coin}: only BTC and ETH are traded`);

    const key = `${pair}:${interval}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.candles;

    try {
      const response = await fetch(
        `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${interval}`,
        { signal: AbortSignal.timeout(5000) },
      );
      const body = await response.json();
      if (!response.ok || body.error?.length) {
        throw new Error(body.error?.join(', ') || `HTTP ${response.status}`);
      }

      // result = { XXBTZEUR: [[time, open, high, low, close, vwap, volume, trades], ...], last: ... }
      const rows = Object.entries(body.result).find(([name]) => name !== 'last')[1] as any[];
      const candles = rows.map(([time, open, high, low, close]) => ({
        time,
        open: Number(open),
        high: Number(high),
        low: Number(low),
        close: Number(close),
      }));
      this.cache.set(key, { at: Date.now(), candles });
      return candles;
    } catch (error) {
      this.logger.warn(`Kraken candles ${key}: ${error.message}`);
      if (cached) return cached.candles; // an older copy is better than none
      throw new BadGatewayException('The price history is not available right now');
    }
  }
}
