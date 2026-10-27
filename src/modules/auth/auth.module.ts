// auth.module.ts
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CaptchaService } from './captcha.service';
import { JwtStrategy } from './jwt.strategy';
import { GoogleAuthController } from './google-auth.controller';
import { GoogleAuthService } from './google-auth.service';
import { GoogleStrategy } from './google.strategy';
import { GoogleAuthGuard } from './google-auth.guard';
import { OtpController } from './otp.controller';
import { OtpService } from './otp.service';
import { ReferralsModule } from '../referrals/referrals.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RefreshTokenService } from './refresh-token.service';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { TwoFactorController } from './two-factor.controller';
import { TwoFactorService } from './two-factor.service';
import { CacheService } from '../../common/cache/cache.service';

import { ThrottlerModule } from '@nestjs/throttler';

@Module({
  imports: [
    PassportModule,
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret:      config.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: config.get<string>('JWT_EXPIRES_IN', '7d') },
      }),
    }),
    ReferralsModule,
    NotificationsModule,
  ],
  controllers: [
    AuthController,
    GoogleAuthController,
    OtpController,
    SessionsController,
    TwoFactorController,
  ],
  providers: [
    AuthService,
    CaptchaService,
    JwtStrategy,
    GoogleAuthService,
    {
      // Only register the Passport 'google' strategy when credentials exist;
      // passport-google-oauth20 throws on a missing clientID.
      provide: GoogleStrategy,
      inject: [ConfigService, GoogleAuthService],
      useFactory: (config: ConfigService, googleAuth: GoogleAuthService) =>
        googleAuth.enabled ? new GoogleStrategy(config, googleAuth) : null,
    },
    GoogleAuthGuard,
    OtpService,
    SessionsService,
    RefreshTokenService,
    TwoFactorService,
    CacheService,
  ],
  exports: [AuthService, OtpService, SessionsService],
})
export class AuthModule {}
