import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { Role } from '@prisma/client';

export class UpdateUserRoleDto {
  @ApiProperty({                        // Documents the property in Swagger, specifying allowed values and an example
    enum: [Role.USER, Role.MODERATOR],
    example: Role.MODERATOR,
  })
  @IsIn([Role.USER, Role.MODERATOR])
  role: Role;
}
