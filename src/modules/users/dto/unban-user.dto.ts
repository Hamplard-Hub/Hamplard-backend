import { IsString, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UnbanUserDto {
    @ApiProperty({
        description: 'Reason for unbanning the user',
        example: 'Appeal successful, user has acknowledged community guidelines',
        required: false,
    })
    @IsString()
    @IsOptional()
    reason?: string;
}
