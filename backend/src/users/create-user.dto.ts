import { IsEmail, IsNumber, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import {
  AVATAR_MAX_LENGTH,
  AVATAR_MESSAGE,
  AVATAR_PATTERN,
  USERNAME_MESSAGE,
  USERNAME_PATTERN,
} from './user-rules';

export class CreateUserDto {
  @IsString()
  @Matches(USERNAME_PATTERN, { message: USERNAME_MESSAGE })
  username: string;

  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;

  // Ignored: the server sets the starting balance (see users.service.ts).
  // Still accepted because the current registration form sends it.
  @IsOptional()
  @IsNumber()
  wallet?: number;

  @IsOptional()
  @IsString()
  @Matches(AVATAR_PATTERN, { message: AVATAR_MESSAGE })
  @MaxLength(AVATAR_MAX_LENGTH)
  avatar?: string;
}