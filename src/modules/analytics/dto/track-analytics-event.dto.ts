import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/** Allowed high-level analytics event types */
export const ANALYTICS_EVENT_TYPES = [
  'page_view',
  'click',
  'course_view',
  'lesson_start',
  'lesson_complete',
  'enrollment_start',
  'search',
  'video_play',
  'video_pause',
  'custom',
] as const;

export type AnalyticsEventType = (typeof ANALYTICS_EVENT_TYPES)[number] | string;

export class TrackAnalyticsEventDto {
  @ApiProperty({
    example: 'page_view',
    description: 'Event type (e.g. page_view, click, course_view)',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  eventType: string;

  @ApiPropertyOptional({ description: 'Authenticated user id when known' })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({ example: 'sess_abc123' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  sessionId?: string;

  @ApiPropertyOptional({ example: '/courses/tailoring' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  path?: string;

  @ApiPropertyOptional({
    example: { buttonId: 'enroll-cta', courseId: 'COURSE-1' },
  })
  @IsOptional()
  @IsObject()
  properties?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Client-side event timestamp (ISO)' })
  @IsOptional()
  @IsDateString()
  occurredAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(512)
  userAgent?: string;
}

export class BatchTrackAnalyticsEventsDto {
  @ApiProperty({ type: [TrackAnalyticsEventDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => TrackAnalyticsEventDto)
  events: TrackAnalyticsEventDto[];
}

export class QueryAnalyticsEventsDto {
  @ApiPropertyOptional({ example: 'page_view' })
  @IsOptional()
  @IsString()
  eventType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sessionId?: string;

  @ApiPropertyOptional({ description: 'ISO start datetime filter' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'ISO end datetime filter' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  page?: number;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  limit?: number;
}
