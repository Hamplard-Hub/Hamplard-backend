import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
  NotFoundException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { IsArray, IsOptional, IsString, ArrayMinSize } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import { CdnService } from './cdn.service';

export class InvalidateCacheDto {
  @ApiProperty({ type: [String], example: ['/uploads/videos/lesson-1.mp4'] })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  paths: string[];
}

export class ValidateSignedUrlDto {
  @ApiProperty({ example: 'https://cdn.hamplard.com/uploads/private/x.mp4?expires=...&signature=...' })
  @IsString()
  url: string;
}

export class ResolveMediaDto {
  @ApiProperty({ example: 'https://cdn.hamplard.com/uploads/videos/x.mp4' })
  @IsString()
  cdnUrl: string;

  @ApiPropertyOptional({ example: 'http://localhost:3000/uploads/videos/x.mp4' })
  @IsOptional()
  @IsString()
  originUrl?: string;
}

@ApiTags('cdn')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('cdn')
export class CdnController {
  constructor(private readonly cdnService: CdnService) {}

  @Post('invalidate')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Request CDN cache invalidation for asset paths' })
  invalidate(@Body() dto: InvalidateCacheDto) {
    return this.cdnService.invalidateCache(dto.paths);
  }

  @Get('invalidations')
  @ApiOperation({ summary: 'List tracked CDN cache invalidation requests' })
  listInvalidations() {
    return this.cdnService.listInvalidationRequests();
  }

  @Get('invalidations/:id')
  @ApiOperation({ summary: 'Get a CDN cache invalidation request by id' })
  getInvalidation(@Param('id') id: string) {
    const request = this.cdnService.getInvalidationRequest(id);
    if (!request) {
      throw new NotFoundException(`Invalidation request ${id} not found`);
    }
    return request;
  }

  @Post('validate-signed-url')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Validate signed CDN URL expiry and signature' })
  validateSignedUrl(@Body() dto: ValidateSignedUrlDto) {
    return this.cdnService.validateSignedUrl(dto.url);
  }

  @Post('resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resolve media URL with CDN → origin fallback' })
  resolve(@Body() dto: ResolveMediaDto) {
    return this.cdnService.resolveWithOriginFallback(dto.cdnUrl, dto.originUrl);
  }
}
