import {
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AdminIdentityService {
  constructor(private readonly prisma: PrismaService) {}

  async getAdminId(): Promise<number> {                  // Returns the configured admin user's ID

    const adminEmail = process.env.ADMIN_EMAIL;          // Reads the admin email from the environment variables

    if (!adminEmail) {
      throw new InternalServerErrorException(            // HTTP 500: required configuration is missing
        'Admin email is not configured',
      );
    }

    const admin = await this.prisma.user.findUnique({    // Finds the user with the configured admin email
      where: {
        email: adminEmail,
      },
    });

    if (!admin || admin.role !== Role.ADMIN) {           // Ensures the user exists and has the ADMIN role
      throw new InternalServerErrorException(
        'Configured admin user was not found',
      );
    }

    return admin.id;                                     // Returns the validated admin user's ID
  }
}
