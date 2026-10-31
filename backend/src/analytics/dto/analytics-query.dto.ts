import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, Matches, Max, Min } from 'class-validator';

export class AnalyticsQueryDto {
  // Start and end of the period, as ISO dates (e.g. 2026-10-01T00:00:00.000Z).
  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @Matches(/^[A-Za-z]{2,10}$/, { message: 'coin must be a coin symbol such as BTC' })
  coin?: string;

  @IsOptional()
  @IsIn(['up', 'down'])
  direction?: 'up' | 'down';

  // The browser's offset from UTC in minutes (Date.getTimezoneOffset()), so
  // that bets are grouped by the user's local day.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(-840)
  @Max(840)
  tzOffset?: number;
}
