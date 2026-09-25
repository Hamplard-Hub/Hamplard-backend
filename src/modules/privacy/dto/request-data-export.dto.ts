import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsIn } from 'class-validator';

export class RequestDataExportDto {
  @ApiProperty({
    description:
      'Optional confirmation. The export is always compiled for the authenticated user; ' +
      'the requester identity comes from the verified JWT, never from the body.',
    required: false,
    enum: ['self'],
  })
  @IsOptional()
  @IsIn(['self'], { message: 'Data exports can only be requested for yourself' })
  scope?: 'self';
}
