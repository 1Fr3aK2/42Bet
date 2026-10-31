import { IsIn, IsInt, IsString, Matches, Max, Min } from 'class-validator';

export class CreateBetDto {
  // Coin symbol, e.g. "BTC". The server only accepts coins that have a live
  // price in the Kraken feed (BTC and ETH).
  @IsString()
  @Matches(/^[A-Za-z]{2,10}$/, { message: 'coin must be a coin symbol such as BTC' })
  coin: string;

  @IsIn(['up', 'down'])
  direction: 'up' | 'down';

  // Stake in T$. The real limit is the user's balance, checked when the bet
  // is placed; the maximum only rejects absurd values.
  @IsInt()
  @Min(1)
  @Max(1000000)
  amount: number;
}
