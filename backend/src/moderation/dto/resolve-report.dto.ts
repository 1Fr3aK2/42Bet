import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ResolveReportDto {
  @ApiProperty({                  // Documents the property in Swagger, specifying possible values and an example
    enum: ['dismiss', 'remove'],
    example: 'dismiss',
  })
  @IsString()
  @IsIn(['dismiss', 'remove'])
  action: string;

  @ApiPropertyOptional({          // Documents an optional property in Swagger, specifying an example and maximum length
    example: 'Report reviewed.',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
