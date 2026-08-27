import { IsString, IsOptional, IsObject, IsNotEmpty, IsInt, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AutosaveCourseDto {
  @ApiProperty({ required: false, description: 'ID of existing course if autosaving an existing course', example: 'COURSE-TAILORING-001' })
  @IsOptional()
  @IsString()
  courseId?: string;

  @ApiProperty({ required: false, description: 'ID of draft session if continuing an existing draft', example: 'draft-uuid-123' })
  @IsOptional()
  @IsString()
  draftId?: string;

  @ApiProperty({ required: false, description: 'Working title for course draft', example: 'Advanced Tailoring & Pattern Making' })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiProperty({ description: 'JSON data object containing current state of course edits', example: { title: 'Advanced Tailoring', category: 'Tailoring', modules: [] } })
  @IsObject()
  @IsNotEmpty()
  data: Record<string, any>;

  @ApiProperty({ required: false, description: 'Client draft version for optimistic locking conflict detection', example: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}
