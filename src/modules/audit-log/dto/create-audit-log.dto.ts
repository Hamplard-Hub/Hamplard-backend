import { IsEnum, IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';
import { AuditAction, AuditTargetType } from '@prisma/client';

export class CreateAuditLogDto {
  @IsNotEmpty()
  @IsEnum(AuditAction)
  action: AuditAction;

  @IsNotEmpty()
  @IsEnum(AuditTargetType)
  targetType: AuditTargetType;

  @IsNotEmpty()
  @IsString()
  targetId: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;

  @IsOptional()
  @IsString()
  ipAddress?: string;
}
