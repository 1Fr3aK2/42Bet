import {
    Injectable,
    NotFoundException,
    BadRequestException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class WalletService {
    constructor(private readonly prisma: PrismaService) {}

    // Get the authenticated user's wallet
    async getMyWallet(userId: number) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                username: true,
                wallet: true,
            },
        });

        if (!user) {
            throw new NotFoundException('User not found');
        }

        return user;
    }

    // Get all users' wallets (ADMIN)
    async getAllWallets() {
        return this.prisma.user.findMany({
            select: {
                id: true,
                username: true,
                wallet: true,
            },
            orderBy: {
                id: 'asc',
            },
        });
    }

    // Get a specific user's wallet (ADMIN)
    async getWalletByUserId(userId: number) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                username: true,
                wallet: true,
            },
        });

        if (!user) {
            throw new NotFoundException('User not found');
        }

        return user;
    }

    // Credit a user's wallet (ADMIN)
    async creditWallet(userId: number, amount: number) {
        this.validateAmount(amount);

        try {
            return await this.prisma.user.update({
                where: { id: userId },
                data: {
                    wallet: {
                        increment: amount,
                    },
                },
                select: {
                    id: true,
                    username: true,
                    wallet: true,
                },
            });
        } catch (error) {
            if (error.code === 'P2025') {
                throw new NotFoundException('User not found');
            }

            throw error;
        }
    }

    // Debit a user's wallet (ADMIN)
    async debitWallet(userId: number, amount: number) {
        this.validateAmount(amount);

        // Atomic update: prevents the balance from becoming negative
        const result = await this.prisma.user.updateMany({
            where: {
                id: userId,
                wallet: {
                    gte: amount,
                },
            },
            data: {
                wallet: {
                    decrement: amount,
                },
            },
        });

        if (result.count === 0) {
            const user = await this.prisma.user.findUnique({
                where: { id: userId },
                select: { id: true },
            });

            if (!user) {
                throw new NotFoundException('User not found');
            }

            throw new BadRequestException('Insufficient wallet balance');
        }

        return this.getWalletByUserId(userId);
    }

    // Validate wallet amount
    private validateAmount(amount: number) {
        if (!Number.isSafeInteger(amount) || amount <= 0) {
            throw new BadRequestException(
                'Amount must be a positive integer',
            );
        }
    }
}