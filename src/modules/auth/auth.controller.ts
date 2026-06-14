import { Controller, Get, Post, Body, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { IsString, IsNotEmpty, IsOptional, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

class LoginDto {
  @ApiProperty() @IsString() @IsNotEmpty() stellarAddress: string;
  @ApiProperty() @IsString() @IsNotEmpty() signedNonce: string;
  @ApiProperty() @IsString() @IsNotEmpty() signature: string;
  @ApiProperty({ required: false, enum: ['STUDENT', 'INSTRUCTOR'] })
  @IsOptional() @IsIn(['STUDENT', 'INSTRUCTOR']) role?: 'STUDENT' | 'INSTRUCTOR';
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('nonce')
  @ApiOperation({ summary: 'Get challenge nonce for a Stellar address' })
  getNonce(@Query('address') address: string) {
    return { nonce: this.authService.generateNonce(address), address };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Submit signed nonce and receive JWT' })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }
}
