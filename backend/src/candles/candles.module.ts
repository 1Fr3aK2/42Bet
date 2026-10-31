import { Module } from '@nestjs/common';
import { CandlesController } from './candles.controller';
import { CandlesService } from './candles.service';

@Module({
  controllers: [CandlesController],
  providers: [CandlesService],
})
export class CandlesModule {}
