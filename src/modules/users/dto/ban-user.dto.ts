import { IsString, IsNotEmpty, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class BanUserDto {
    @ApiProperty({
        description: 'Reason for banning the user',
        example: 'Violation of community guidelines - repeated harassment',
    })
    @IsString()
    @IsNotEmpty()
    reason: string;

    @ApiProperty({
        description: 'Additional notes about the ban (optional)',
        required: false,
        example: 'User was warned 3 times before ban',
    })
    @IsString()
    @IsOptional()
    notes?: string;
}
