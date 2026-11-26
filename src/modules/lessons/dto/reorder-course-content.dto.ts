import { Type } from 'class-transformer';
import {
  IsArray, IsInt, IsNotEmpty, IsOptional, IsString, Min, ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ModulePositionDto {
  @ApiProperty({ description: 'Module ID', example: 'module-uuid-1' })
  @IsString()
  @IsNotEmpty()
  id: string;

  @ApiProperty({ description: 'New position within the course', example: 0 })
  @IsInt()
  @Min(0)
  position: number;
}

export class LessonPositionDto {
  @ApiProperty({ description: 'Lesson ID', example: 'lesson-uuid-1' })
  @IsString()
  @IsNotEmpty()
  id: string;

  @ApiProperty({ description: 'New position within its module', example: 0 })
  @IsInt()
  @Min(0)
  position: number;

  @ApiPropertyOptional({
    description: 'Move the lesson to another module of the same course',
    example: 'module-uuid-2',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  moduleId?: string;
}

export class ReorderCourseContentDto {
  @ApiPropertyOptional({ type: [ModulePositionDto], description: 'New module positions' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ModulePositionDto)
  modules?: ModulePositionDto[];

  @ApiPropertyOptional({ type: [LessonPositionDto], description: 'New lesson positions' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LessonPositionDto)
  lessons?: LessonPositionDto[];
}
