import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './login.dto';
import { RateLimiterService } from '../rate-limiter/rate-limiter.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly rateLimiter: RateLimiterService,
  ) {}

  async login(dto: LoginDto) {

    const key = `login_attempts:${dto.username}`;
    const allowed = await this.rateLimiter.checkLimit(key, 5, 1800);
    if (!allowed) {
      throw new UnauthorizedException('Too many login attempts. Please try again later.');
    }

    let user = await this.prisma.user.findUnique({
      where: {
        username: dto.username,
      },
    });

    // The login field also takes the email (the subject asks for email and
    // password authentication). Usernames cannot contain "@" (users/user-rules.ts),
    // so only an email reaches this second lookup.
    if (!user && dto.username.includes('@')) {
      user = await this.prisma.user.findUnique({
        where: {
          email: dto.username,
        },
      });
    }

    if (!user) {
      throw new UnauthorizedException('Invalid username or password');
    }

    const valid = await bcrypt.compare(
      dto.password,
      user.password,
    );

    if (!valid) {
      throw new UnauthorizedException('Invalid username or password');
    }

    await this.rateLimiter.resetLimit(key);

    const payload = {
      sub: user.id,
      username: user.username,
    };

    return {
      access_token: this.jwtService.sign(payload),
    };
  }
  
  async getMe(user: any) {
    const currentUser = await this.prisma.user.findUnique({
      where: {
        id: user.id,
      },
      select: {
        id: true,
        username: true,
        email: true,
      },
    });
  
    return currentUser;
  }
}