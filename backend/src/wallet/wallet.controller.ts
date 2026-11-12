import {
    Controller,
    Get,
    Post,
    Param,
    ParseIntPipe,
    Body,
    Request,
    UseGuards,
} from '@nestjs/common';

import { WalletService } from './wallet.service';

import { JwtAuthGuard } from '../auth/jwt-auth-guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

import { Role } from '@prisma/client';

import { CreditWalletDto } from './dto/credit-wallet.dto';
import { DebitWalletDto } from './dto/debit-wallet.dto';

@Controller('wallet')
export class WalletController {
    constructor(private readonly walletService: WalletService) {}

    // Get authenticated user's wallet
    @UseGuards(JwtAuthGuard)
    @Get('me')
    getMyWallet(@Request() req) {
        return this.walletService.getMyWallet(req.user.id);
    }

    // Get all wallets (ADMIN)
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(Role.ADMIN)
    @Get()
    getAllWallets() {
        return this.walletService.getAllWallets();
    }

    // Get a specific user's wallet (ADMIN)
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(Role.ADMIN)
    @Get(':userId')
    getWalletByUserId(
        @Param('userId', ParseIntPipe) userId: number,
    ) {
        return this.walletService.getWalletByUserId(userId);
    }

    // Credit wallet (ADMIN)
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(Role.ADMIN)
    @Post(':userId/credit')
    creditWallet(
        @Param('userId', ParseIntPipe) userId: number,
        @Body() dto: CreditWalletDto,
    ) {
        return this.walletService.creditWallet(
            userId,
            dto.amount,
        );
    }

    // Debit wallet (ADMIN)
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(Role.ADMIN)
    @Post(':userId/debit')
    debitWallet(
        @Param('userId', ParseIntPipe) userId: number,
        @Body() dto: DebitWalletDto,
    ) {
        return this.walletService.debitWallet(
            userId,
            dto.amount,
        );
    }
}