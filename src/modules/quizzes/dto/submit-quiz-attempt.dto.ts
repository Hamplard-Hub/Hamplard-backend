import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  Max,
  ValidateNested,
} from 'class-validator';

export class SingleAnswerDto {
  @ApiProperty({ description: 'The ID of the quiz question' })
  @IsString()
  @IsNotEmpty()
  questionId: string;

  @ApiProperty({
    description:
      'Answer submitted for the question. For choice types: array of indices e.g. [0]. For true/false: ["true"] or ["false"]. For short answer: ["answer text"].',
    example: [0],
  })
  @IsArray()
  answer: any[];
}

export class SubmitQuizAttemptDto {
  @ApiProperty({
    description: 'Array of submitted answers for questions',
    type: [SingleAnswerDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SingleAnswerDto)
  answers: SingleAnswerDto[];

  @ApiPropertyOptional({
    description: 'Optional custom passing percentage threshold (0-100). Defaults to 70%.',
    default: 70,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  passThreshold?: number;
}
