import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { CryptoModule } from '../crypto/crypto.module';
import { BetsController } from './bets.controller';
import { BetsGateway } from './bets.gateway';
import { BetsService } from './bets.service';

@Module({
  // JwtModule has no options here: BetsGateway passes the secret when it
  // verifies a token, because JWT_SECRET is only loaded from Vault at startup.
  imports: [PrismaModule, AuthModule, CryptoModule, JwtModule.register({})],
  controllers: [BetsController],
  providers: [BetsService, BetsGateway],
})
export class BetsModule {}
