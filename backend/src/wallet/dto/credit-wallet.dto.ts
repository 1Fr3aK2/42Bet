import { IsInt, Min } from 'class-validator';

export class CreditWalletDto {
    @IsInt()
    @Min(1)
    amount: number;
}