// auth.module.ts
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { GoogleAuthController } from './google-auth.controller';
import { GoogleAuthService } from './google-auth.service';
import { GoogleStrategy } from './google.strategy';
import { GoogleAuthGuard } from './google-auth.guard';
import { OtpController } from './otp.controller';
import { OtpService } from './otp.service';
import { ReferralsModule } from '../referrals/referrals.module';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret:      config.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: config.get<string>('JWT_EXPIRES_IN', '7d') },
      }),
    }),
    ReferralsModule,
  ],
  controllers: [AuthController, GoogleAuthController, OtpController],
  providers: [AuthService, JwtStrategy, GoogleAuthService, GoogleStrategy, GoogleAuthGuard, OtpService],
  exports: [AuthService, OtpService],
  controllers: [AuthController, GoogleAuthController, SessionsController],
  providers: [AuthService, JwtStrategy, GoogleAuthService, GoogleStrategy, GoogleAuthGuard, SessionsService],
  exports: [AuthService, SessionsService],
})
export class AuthModule {}
