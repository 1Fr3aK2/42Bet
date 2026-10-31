import { Body, Controller, Get, Post, Query, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth-guard';
import { BetsService } from './bets.service';
import { CreateBetDto } from './dto/create-bet.dto';
import { ListBetsDto } from './dto/list-bets.dto';

// The routes live under /users/me because nginx already forwards /users to
// the backend, so the nginx configuration does not need to change.
@UseGuards(JwtAuthGuard)
@Controller('users/me')
export class BetsController {
  constructor(private readonly betsService: BetsService) {}

  @Get('balance')
  getBalance(@Request() req) {
    return this.betsService.getBalance(req.user.id);
  }

  @Post('bets')
  placeBet(@Request() req, @Body() dto: CreateBetDto) {
    return this.betsService.placeBet(req.user.id, dto);
  }

  @Get('bets')
  listBets(@Request() req, @Query() query: ListBetsDto) {
    return this.betsService.listBets(req.user.id, query);
  }
}
