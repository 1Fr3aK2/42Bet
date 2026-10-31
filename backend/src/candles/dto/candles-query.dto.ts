import { Type } from 'class-transformer';
import { IsIn, IsOptional } from 'class-validator';

export class CandlesQueryDto {
  // Minutes per candle: the sizes offered by the chart (default 1).
  @IsOptional()
  @Type(() => Number)
  @IsIn([1, 5, 15, 60], { message: 'interval must be 1, 5, 15 or 60 (minutes)' })
  interval?: number;
}
