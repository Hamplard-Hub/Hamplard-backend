import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class AddToWishlistDto {
  @ApiProperty({
    description: 'Course ID to add to the wishlist',
    example: 'course-uuid',
  })
  @IsString()
  @IsNotEmpty()
  courseId: string;
}
