import { Module } from '@nestjs/common';
import { PublicApiController } from './public-api.controller';
import { ForumModule } from '../forum/forum.module';
import { UsersModule } from '../users/users.module';
import { ModerationModule } from '../moderation/moderation.module';
import { RateLimiterModule } from '../rate-limiter/rate-limiter.module';
import { AdminApiKeyGuard } from './admin-api-key.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminIdentityService } from './admin-identity.service';
import { AdminApiRateLimitGuard } from './admin-api-rate-limit.guard';

@Module({
  imports: [
    ForumModule,
    UsersModule,
    RateLimiterModule,
    PrismaModule,
    ModerationModule,
  ],
  controllers: [PublicApiController],
  providers: [          // Registers three components in NestJS's dependency injection system
    AdminApiKeyGuard,           // Controls access using an API key
    AdminIdentityService,       // Manages the administrative identity used in API operations
    AdminApiRateLimitGuard,     // Controls the frequency of API requests
  ],
})
export class PublicApiModule {}
