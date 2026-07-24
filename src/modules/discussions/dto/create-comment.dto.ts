import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class CreateCommentDto {
  @ApiProperty({ description: 'Discussion thread or entity identifier' })
  @IsString()
  @IsNotEmpty()
  discussionId: string;

  @ApiProperty({ description: 'Comment content to be scanned for banned terms' })
  @IsString()
  @IsNotEmpty()
  content: string;
}
