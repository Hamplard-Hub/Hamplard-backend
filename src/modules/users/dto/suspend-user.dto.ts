import { IsString, IsNotEmpty, IsOptional, IsDateString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SuspendUserDto {
    @ApiProperty({
        description: 'Reason for suspending the user',
        example: 'Temporary suspension pending investigation',
    })
    @IsString()
    @IsNotEmpty()
    reason: string;

    @ApiProperty({
        description: 'Date and time when suspension should end (ISO 8601 format)',
        example: '2026-08-15T00:00:00Z',
    })
    @IsDateString()
    @IsNotEmpty()
    suspendedUntil: string;

    @ApiProperty({
        description: 'Additional notes about the suspension (optional)',
        required: false,
        example: 'User appealed, case under review',
    })
    @IsString()
    @IsOptional()
    notes?: string;
}
