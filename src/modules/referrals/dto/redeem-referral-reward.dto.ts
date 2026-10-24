import { IsNotEmpty, IsString, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RedeemReferralRewardDto {
  @ApiProperty({ description: 'ID of the referral reward being redeemed' })
  @IsString()
  @IsNotEmpty()
  @IsUUID()
  rewardId: string;

  @ApiProperty({
    description:
      "ID of the authenticated user's enrollment the reward discount was applied to",
  })
  @IsString()
  @IsNotEmpty()
  @IsUUID()
  enrollmentId: string;
}
