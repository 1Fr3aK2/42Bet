import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export class ListBetsDto {
  // "active": bets still running; "settled": finished bets (won, lost or refunded).
  @IsOptional()
  @IsIn(['active', 'settled'])
  status?: 'active' | 'settled';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
