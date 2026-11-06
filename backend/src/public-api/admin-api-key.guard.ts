import {
  CanActivate,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';

@Injectable()
export class AdminApiKeyGuard implements CanActivate {

  // Automatically called by NestJS to determine whether the request is authorized
  canActivate(context: ExecutionContext): boolean {           // CanActivate is a NestJS interface that defines the guard contract, requiring the canActivate() method
    const expectedKey = process.env.ADMIN_API_KEY;            // Reads the expected API key from environment variables

    if (!expectedKey) {
      throw new InternalServerErrorException(                 // HTTP 500: required configuration is missing
        'Admin API key is not configured',
      );
    }

    const request = context.switchToHttp().getRequest();      // Gets the current HTTP request
    const providedKey = request.headers['x-api-key'];         // Extracts the API key from the request header

    if (providedKey !== expectedKey) {
      throw new UnauthorizedException('Invalid API key');
    }

    return true;                                              // API key is valid: allows the request to proceed
  }
}
