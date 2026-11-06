import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Max,
  Min,
  Matches,
} from 'class-validator';

export class SearchPostsDto {
  @IsOptional()                   // Skips validation if the value is null or undefined (class-validator)
  @IsString()
  @MaxLength(100)                 // Limits the search term to a maximum of 100 characters
  search?: string;                // ? indicates that the property is optional in TypeScript

  @IsOptional()
  @Type(() => Number)             // class-transformer: converts the incoming value to a number
  @IsInt()
  @IsPositive()
  authorId?: number;

  @IsOptional()
  @IsDateString()                 // Validates that the provided value is a valid ISO 8601 date string
  @Matches(/^\d{4}-\d{2}-\d{2}$/) // Requires YYYY-MM-DD format (exactly 4-digit year, 2-digit month and 2-digit day, with no time)
  dateFrom?: string;

  @IsOptional()
  @IsDateString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/) // Requires YYYY-MM-DD format (exactly 4-digit year, 2-digit month and 2-digit day, with no time)
  dateTo?: string;

  @IsOptional()
  @IsIn(['createdAt', 'updatedAt', 'title'])
  sortBy?: 'createdAt' | 'updatedAt' | 'title';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)                         // Ensures the page number is an integer greater than or equal to 1
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)                       // Ensures the value is less than or equal to 100
  limit?: number;
}

/*
  Regular expression: /^\d{4}-\d{2}-\d{2}$/

  Symbol     Meaning
  -------    --------------------------------------------------
  / ... /    JavaScript regular expression delimiters
  ^          Start of the string
  \d         A digit from 0 to 9
  {4}        Exactly 4 repetitions of the preceding element
  -          A literal hyphen
  {2}        Exactly 2 repetitions of the preceding element
  $          End of the string

  The regex checks the YYYY-MM-DD format, while @IsDateString()
  validates that the value is a valid ISO 8601 date.
*/

/*
  Three distinct mechanisms used in this DTO:

  1. TypeScript typing (page?: number)
     - Static type checking during development/compilation.

  2. Transformation (@Type(() => Number))
     - Converts incoming values to the expected type.

  3. Validation (@IsInt(), @Min(1))
     - Checks whether the values satisfy the defined rules.

  TypeScript checks types at compile time, while transformation
  and validation operate at runtime.
*/
