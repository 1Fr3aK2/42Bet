import { Controller, Get, Param, Query } from '@nestjs/common';
import { CandlesService } from './candles.service';
import { CandlesQueryDto } from './dto/candles-query.dto';

// Under /crypto, next to the live price routes of CryptoController, because
// nginx already forwards /crypto to the backend. Public, like the live price.
@Controller('crypto')
export class CandlesController {
  constructor(private readonly candlesService: CandlesService) {}

  // GET /crypto/BTC/candles?interval=5 -> the last 720 candles of 5 minutes
  @Get(':coin/candles')
  getCandles(@Param('coin') coin: string, @Query() query: CandlesQueryDto) {
    return this.candlesService.getCandles(coin, query.interval ?? 1);
  }
}
