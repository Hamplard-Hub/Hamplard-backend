import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';
import { ToOptionalBool } from '../../../common/pipes/parse-optional-bool';

export class QueryNotificationsDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Only return unread notifications ("true"/"false"/"1"/"0")' })
  @IsOptional()
  @ToOptionalBool()
  @IsBoolean()
  unreadOnly?: boolean;
}
