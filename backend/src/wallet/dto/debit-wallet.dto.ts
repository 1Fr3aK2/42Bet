import { IsInt, Min } from 'class-validator';

export class DebitWalletDto {
    @IsInt()
    @Min(1)
    amount: number;
}