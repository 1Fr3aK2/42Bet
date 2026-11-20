import { Injectable, ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './create-user.dto';
import * as bcrypt from 'bcrypt';
import { Prisma, Role } from '@prisma/client';
import { UpdateMeDto } from './update-me.dto';
import { UpdatePasswordDto } from './update-password.dto';
import { STARTING_BALANCE } from '../bets/bets.constants';
import { normalizeAvatar } from './avatar.util';


//@UseGuards(JwtAuthGuard)
@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
  return this.prisma.user.findMany({
    select: {
      id: true,
      username: true,
      email: true,
	  role: true,
      avatar: true,
      wallet: true,
      wins: true,
      losses: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

  
	async create(createUserDto: CreateUserDto) {
		const hash = await bcrypt.hash(createUserDto.password, 10);
		const avatar = await normalizeAvatar(createUserDto.avatar);
		try {
	 
			return await this.prisma.user.create({
				data: {
		  			username: createUserDto.username,
		  			email: createUserDto.email,
					password: hash,
					avatar,
		  			wallet: STARTING_BALANCE,
				},
				select: {
		  			id: true,
		  			username: true,
		  			email: true,
		  			role: true,
		 			avatar: true,
		  			wallet: true,
		  			wins: true,
		  			losses: true,
		  			createdAt: true,
		  			updatedAt: true,
				},
			});
		} catch (error) {
	 		 if (error instanceof Prisma.PrismaClientKnownRequestError &&
				error.code === 'P2002')
				throw new ConflictException('Username or email already exists');
	 		throw error;
	}
}
  

  async updateRole(
    userId: number,
    role: Role,
  ) {
    const user = await this.prisma.user.findUnique({
      where: {
        id: userId,
      },
    });

    if (!user) {
      throw new NotFoundException(
        `User with id ${userId} not found`,
      );
    }

    if (user.role === Role.ADMIN) {
      throw new BadRequestException(
        'Admin role cannot be changed through this endpoint',
      );
    }

    if (role !== Role.USER && role !== Role.MODERATOR) {
      throw new BadRequestException(
        'Role must be USER or MODERATOR',
      );
    }

    return this.prisma.user.update({
      where: {
        id: userId,
      },
      data: {
        role,
      },
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
      },
    });
  }
  async findMe(userId: number) {
	const user = await this.prisma.user.findUnique({
	  where: {
		id: userId,
	  },
	  select: {
		id: true,
		username: true,
		email: true,
		role: true,
		avatar: true,
		wallet: true,
		wins: true,
		losses: true,
		createdAt: true,
		updatedAt: true,
	  },
	});

	if (!user) {
	  throw new NotFoundException(
		`User with id ${userId} not found`,
	  );
	}

	return user;
  }

  
async updateMe(
	userId: number,
	updateMeDto: UpdateMeDto,
  ) {
	const user = await this.prisma.user.findUnique({
	  where: {
		id: userId,
	  },
	});
  
	if (!user) {
	  throw new NotFoundException(
		`User with id ${userId} not found`,
	  );
	}
  
	// Validate and normalize the avatar on the server.
	const avatar = await normalizeAvatar(updateMeDto.avatar);
  
	try {
	  return await this.prisma.user.update({
		where: {
		  id: userId,
		},
		data: {
		  username: updateMeDto.username,
		  avatar,
		},
		select: {
		  id: true,
		  username: true,
		  email: true,
		  role: true,
		  avatar: true,
		  wallet: true,
		  wins: true,
		  losses: true,
		  createdAt: true,
		  updatedAt: true,
		},
	  });
	} catch (error) {
	  if (
		error instanceof Prisma.PrismaClientKnownRequestError &&
		error.code === 'P2002'
	  ) {
		throw new ConflictException('Username already exists');
	  }
  
	  throw error;
	}
  }

  async deleteUser(userId: number, requesterId: number) {
    if (userId === requesterId) {
      throw new BadRequestException('You cannot delete your own account');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.role === Role.ADMIN) {
      throw new BadRequestException('Admin accounts cannot be deleted');
    }

    try {
      await this.prisma.user.delete({
        where: { id: userId },
      });

      return { message: 'User deleted successfully' };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2025') {
          throw new NotFoundException('User not found');
        }

        // The user's posts, comments, reports and moderation logs are deleted with
        // them (onDelete: Cascade in schema.prisma). This only happens if some
        // other table still points at the user and has no such rule.
        if (error.code === 'P2003') {
          throw new ConflictException(
            'This user is still referenced by other data and cannot be deleted',
          );
        }
      }

      throw error;
    }
  }
  async updatePassword(
	userId: number,
	updatePasswordDto: UpdatePasswordDto,
  ) {
	const user = await this.prisma.user.findUnique({
	  where: {
		id: userId,
	  },
	});
  
	if (!user) {
	  throw new NotFoundException(
		`User with id ${userId} not found`,
	  );
	}
  
	const passwordValid = await bcrypt.compare(
	  updatePasswordDto.currentPassword,
	  user.password,
	);
  
	if (!passwordValid) {
	  throw new BadRequestException(
		'Current password is incorrect',
	  );
	}
  
	const hash = await bcrypt.hash(
	  updatePasswordDto.newPassword,
	  10,
	);
  
	await this.prisma.user.update({
	  where: {
		id: userId,
	  },
	  data: {
		password: hash,
	  },
	});
  
	return {
	  message: 'Password updated successfully',
	};
  }
}