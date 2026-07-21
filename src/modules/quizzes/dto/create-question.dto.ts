import {
  IsString,
  IsNotEmpty,
  IsEnum,
  IsOptional,
  IsArray,
  IsInt,
  Min,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { QuestionType } from '@prisma/client';

export class CreateQuestionDto {
  @ApiProperty({ description: 'The question text' })
  @IsString()
  @IsNotEmpty()
  question: string;

  @ApiProperty({
    enum: QuestionType,
    enumName: 'QuestionType',
    description: 'Type of the question',
  })
  @IsEnum(QuestionType)
  type: QuestionType;

  @ApiPropertyOptional({
    description: 'Array of option strings for multiple choice/single choice',
    example: ['Option A', 'Option B', 'Option C', 'Option D'],
  })
  @ValidateIf(
    (o) =>
      o.type === QuestionType.MULTIPLE_CHOICE ||
      o.type === QuestionType.SINGLE_CHOICE,
  )
  @IsArray()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  options?: string[];

  @ApiProperty({
    description:
      'Correct answer data. For SINGLE_CHOICE/MULTIPLE_CHOICE: array of 0-based option indices e.g. [0] or [0, 2]. For TRUE_FALSE: ["true"] or ["false"]. For SHORT_ANSWER: array of acceptable string answers.',
    example: [0],
  })
  @IsArray()
  @IsNotEmpty()
  correctAnswer: any[];

  @ApiPropertyOptional({ description: 'Explanation for the answer' })
  @IsOptional()
  @IsString()
  explanation?: string;

  @ApiPropertyOptional({ description: 'Points assigned for this question', default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  points?: number;

  @ApiProperty({ description: 'Ordering position of question in lesson' })
  @IsInt()
  @Min(1)
  position: number;
}

export class UpdateQuestionDto {
  @ApiPropertyOptional({ description: 'The question text' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  question?: string;

  @ApiPropertyOptional({
    enum: QuestionType,
    enumName: 'QuestionType',
    description: 'Type of the question',
  })
  @IsOptional()
  @IsEnum(QuestionType)
  type?: QuestionType;

  @ApiPropertyOptional({
    description: 'Array of option strings',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  options?: string[];

  @ApiPropertyOptional({
    description: 'Correct answer data',
  })
  @IsOptional()
  @IsArray()
  @IsNotEmpty()
  correctAnswer?: any[];

  @ApiPropertyOptional({ description: 'Explanation for the answer' })
  @IsOptional()
  @IsString()
  explanation?: string;

  @ApiPropertyOptional({ description: 'Points assigned for this question' })
  @IsOptional()
  @IsInt()
  @Min(1)
  points?: number;

  @ApiPropertyOptional({ description: 'Ordering position of question in lesson' })
  @IsOptional()
  @IsInt()
  @Min(1)
  position?: number;
}

export class ReorderQuestionsDto {
  @ApiProperty({
    description: 'Array of question order specifications',
    example: [{ id: 'uuid-1', position: 1 }, { id: 'uuid-2', position: 2 }],
  })
  @IsArray()
  questionOrders: { id: string; position: number }[];
}
