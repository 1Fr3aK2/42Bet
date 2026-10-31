import {
	IsOptional,
	IsString,
	Matches,
	MaxLength,
  } from 'class-validator';
import {
	AVATAR_MAX_LENGTH,
	AVATAR_MESSAGE,
	AVATAR_PATTERN,
	USERNAME_MESSAGE,
	USERNAME_PATTERN,
  } from './user-rules';

  export class UpdateMeDto {

	@IsOptional()
	@IsString()
	@Matches(USERNAME_PATTERN, { message: USERNAME_MESSAGE })
	username?: string;

	@IsOptional()
	@IsString()
	@Matches(AVATAR_PATTERN, { message: AVATAR_MESSAGE })
	@MaxLength(AVATAR_MAX_LENGTH)
	avatar?: string;
}
