import { IsBoolean, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpsertTaxRateDto {
  @ApiProperty({ example: 7.5, description: 'Tax rate as a percentage (0–100)' })
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100)
  ratePercent: number;

  @ApiPropertyOptional({ example: 'Nigeria VAT' })
  @IsOptional() @IsString()
  description?: string;

  @ApiPropertyOptional({ description: 'Inactive rates are ignored and the DEFAULT rate is used instead' })
  @IsOptional() @IsBoolean()
  isActive?: boolean;
}
