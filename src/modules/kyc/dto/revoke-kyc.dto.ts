import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString } from "class-validator";

export class RevokeKycDto {
  @ApiPropertyOptional({
    example: "Fraudulent identity document submitted.",
    description: "Optional reason shared with the instructor",
  })
  @IsOptional()
  @IsString()
  adminNotes?: string;
}
