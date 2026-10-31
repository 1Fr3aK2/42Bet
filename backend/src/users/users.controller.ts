import {
	Body,
	Controller,
	Get,
	Param,
	Patch,
	Post,
	Request,
	UseGuards,
  } from '@nestjs/common';
  
  import { UsersService } from './users.service';
  import { CreateUserDto } from './create-user.dto';
  import { JwtAuthGuard } from '../auth/jwt-auth-guard';
  import { Role } from '@prisma/client';
  import { Roles } from '../auth/roles.decorator';
  import { RolesGuard } from '../auth/roles.guard';
  import { UpdateUserRoleDto } from './update-user-role.dto';
  import { UpdateMeDto } from './update-me.dto';
  import { UpdatePasswordDto } from './update-password.dto';
  
  @Controller('users')
  export class UsersController {
  
	constructor(private readonly usersService: UsersService) {}
  
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@Get()
	findAll() {
	  return this.usersService.findAll();
	}
  
	@Post()
	create(@Body() createUserDto: CreateUserDto) {
	  return this.usersService.create(createUserDto);
	}
  
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@Patch(':id/role')
	updateRole(
	  @Param('id') id: string,
	  @Body() updateUserRoleDto: UpdateUserRoleDto,
	) {
	  return this.usersService.updateRole(
		Number(id),
		updateUserRoleDto.role,
	  );
	}
  
	@UseGuards(JwtAuthGuard)
	@Get('me')
	getMe(@Request() req) {
	  return this.usersService.findMe(req.user.id);
	}
  
	@UseGuards(JwtAuthGuard)
	@Patch('me')
	updateMe(
	  @Request() req,
	  @Body() updateMeDto: UpdateMeDto,
	) {
	  return this.usersService.updateMe(
		req.user.id,
		updateMeDto,
	  );
	}
  
	@UseGuards(JwtAuthGuard)
	@Patch('password')
	updatePassword(
	  @Request() req,
	  @Body() updatePasswordDto: UpdatePasswordDto,
	) {
	  return this.usersService.updatePassword(
		req.user.id,
		updatePasswordDto,
	  );
	}
  }