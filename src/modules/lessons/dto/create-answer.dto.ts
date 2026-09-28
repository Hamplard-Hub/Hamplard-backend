import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateAnswerDto {
  @ApiProperty({ description: 'Content of the answer', minLength: 2, maxLength: 5000 })
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(5000)
  content: string;
}
