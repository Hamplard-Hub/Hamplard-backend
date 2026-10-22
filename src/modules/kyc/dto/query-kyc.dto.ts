import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { KycStatus } from '@prisma/client';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

export class QueryKycDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: KycStatus, description: 'Filter by KYC status' })
  @IsOptional()
  @IsEnum(KycStatus)
  status?: KycStatus;
}
