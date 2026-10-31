import { Controller, Get, Query, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth-guard';
import { AnalyticsService } from './analytics.service';
import { AnalyticsQueryDto } from './dto/analytics-query.dto';

// Under /users/me, like the bets routes, because nginx already forwards /users.
@UseGuards(JwtAuthGuard)
@Controller('users/me')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('analytics')
  getAnalytics(@Request() req, @Query() query: AnalyticsQueryDto) {
    return this.analyticsService.getAnalytics(req.user.id, query);
  }
}
