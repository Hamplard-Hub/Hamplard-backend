import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateQuestionDto {
  @ApiProperty({ description: 'Title of the question', minLength: 3, maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(200)
  title: string;

  @ApiProperty({ description: 'Detailed content of the question', minLength: 5, maxLength: 5000 })
  @IsString()
  @IsNotEmpty()
  @MinLength(5)
  @MaxLength(5000)
  content: string;
}
