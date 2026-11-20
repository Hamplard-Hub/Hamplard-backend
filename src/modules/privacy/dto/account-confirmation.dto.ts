import { ApiProperty } from '@nestjs/swagger';
import { Equals } from 'class-validator';

export const DEACTIVATE_CONFIRMATION = 'DEACTIVATE';
export const DELETE_CONFIRMATION = 'DELETE';

export class DeactivateAccountDto {
  @ApiProperty({
    enum: [DEACTIVATE_CONFIRMATION],
    description: `Must be exactly "${DEACTIVATE_CONFIRMATION}" to confirm deactivation`,
  })
  @Equals(DEACTIVATE_CONFIRMATION, {
    message: `confirmation must be exactly "${DEACTIVATE_CONFIRMATION}"`,
  })
  confirmation: string;
}

export class DeleteAccountDto {
  @ApiProperty({
    enum: [DELETE_CONFIRMATION],
    description: `Must be exactly "${DELETE_CONFIRMATION}" to confirm permanent deletion`,
  })
  @Equals(DELETE_CONFIRMATION, {
    message: `confirmation must be exactly "${DELETE_CONFIRMATION}"`,
  })
  confirmation: string;
}
