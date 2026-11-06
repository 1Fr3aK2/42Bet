import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { RateLimiterService } from '../rate-limiter/rate-limiter.service';

@Injectable()
export class AdminApiRateLimitGuard implements CanActivate {
  constructor(
    private readonly rateLimiterService: RateLimiterService,      // Injects the rate limiter service through NestJS dependency injection
  ) {}

  // Checks whether the client has exceeded the API request limit
  async canActivate(context: ExecutionContext): Promise<boolean> {

    const request = context.switchToHttp().getRequest();          // Gets the current HTTP request

    // Gets the client's real IP from the X-Real-IP header set by NGINX, falling back to request.ip
    const clientIp =
      (request.headers['x-real-ip'] as string) || request.ip;

    // Checks whether the client is allowed to make another request
    const allowed =
      await this.rateLimiterService.checkLimit(
        `admin_api_requests:${clientIp}`,           // Unique rate limit key for each client IP
        100,                                        // Maximum 100 requests
        60,                                         // Time window: 60 seconds
      );

    if (!allowed) {
      throw new HttpException(
        'API rate limit exceeded',
        HttpStatus.TOO_MANY_REQUESTS,       // HTTP 429: Too Many Requests
      );
    }

    return true;        // Request is within the rate limit: allows access
  }
}