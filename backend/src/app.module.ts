import { Module } from '@nestjs/common';
import { UsersModule } from './users/users.module';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { ForumModule } from './forum/forum.module';
import { ModerationModule } from './moderation/moderation.module';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './metrics/metrics.module';
import { CryptoModule } from './crypto/crypto.module';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { PublicApiModule } from './public-api/public-api.module';
import { BetsModule } from './bets/bets.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { CandlesModule } from './candles/candles.module';

@Module({
  imports: [
    PrismaModule,
    UsersModule,
    ForumModule,
    ModerationModule,
	  AuthModule,
	  HealthModule,
    MetricsModule,
	  CryptoModule,
	  EventEmitterModule.forRoot(),
    PublicApiModule,
    BetsModule,
    AnalyticsModule,
    CandlesModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
