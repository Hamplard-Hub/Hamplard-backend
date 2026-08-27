import { IsString, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UnsuspendUserDto {
    @ApiProperty({
        description: 'Reason for lifting the suspension early',
        example: 'Investigation concluded, no violation found',
        required: false,
    })
    @IsString()
    @IsOptional()
    reason?: string;
}
