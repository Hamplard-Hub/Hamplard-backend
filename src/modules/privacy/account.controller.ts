import { Body, Controller, Delete, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AllowDeactivated } from '../../common/decorators/allow-deactivated.decorator';
import { AccountService } from './account.service';
import { DeactivateAccountDto, DeleteAccountDto } from './dto/account-confirmation.dto';

@ApiTags('privacy')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('privacy/account')
export class AccountController {
  constructor(private readonly accountService: AccountService) {}

  /** Identity always comes from the verified JWT, never the body. */
  @Post('deactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Deactivate your account',
    description:
      'Requires {"confirmation":"DEACTIVATE"}. Revokes all sessions and refresh tokens. ' +
      'Log in again and call /reactivate to restore the account.',
  })
  deactivate(@CurrentUser('id') userId: string, @Body() dto: DeactivateAccountDto) {
    void dto; // validated by DeactivateAccountDto
    return this.accountService.deactivate(userId);
  }

  @Post('reactivate')
  @AllowDeactivated()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reactivate a deactivated account' })
  reactivate(@CurrentUser('id') userId: string) {
    return this.accountService.reactivate(userId);
  }

  @Delete()
  @AllowDeactivated()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Permanently delete and anonymise your account (GDPR erasure)',
    description:
      'Requires {"confirmation":"DELETE"}. Irreversible. Personal data is removed; financial ' +
      'and audit records are retained with anonymised references.',
  })
  deleteAccount(@CurrentUser('id') userId: string, @Body() dto: DeleteAccountDto) {
    void dto; // validated by DeleteAccountDto
    return this.accountService.deleteAccount(userId);
  }
}
