import { IsInt, IsOptional, IsArray, ValidateNested, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SingleAnswerDto } from './submit-quiz-attempt.dto';

export class StartQuizSessionDto {
  @ApiPropertyOptional({
    description: 'Session duration in minutes (1 to 180)',
    default: 15,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(180)
  durationMinutes?: number;
}

export class SubmitSessionAnswersDto {
  @ApiProperty({ type: [SingleAnswerDto], description: 'List of submitted answers' })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SingleAnswerDto)
  answers: SingleAnswerDto[];

  @ApiPropertyOptional({
    description: 'Passing score percentage threshold',
    default: 70,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  passThreshold?: number;
}
