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
import { EmailVerificationController } from './email-verification.controller';
import { EmailVerificationService } from './email-verification.service';
import { ReferralsModule } from '../referrals/referrals.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../../common/prisma/prisma.module';
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
    NotificationsModule,
    PrismaModule,
  ],
  controllers: [
    AuthController,
    GoogleAuthController,
    EmailVerificationController,
  ],
  providers: [
    AuthService,
    JwtStrategy,
    GoogleAuthService,
    GoogleStrategy,
    GoogleAuthGuard,
    EmailVerificationService,
  ],
  exports: [AuthService],
  controllers: [AuthController, GoogleAuthController, OtpController],
  providers: [AuthService, JwtStrategy, GoogleAuthService, GoogleStrategy, GoogleAuthGuard, OtpService],
  exports: [AuthService, OtpService],
  controllers: [AuthController, GoogleAuthController, SessionsController],
  providers: [AuthService, JwtStrategy, GoogleAuthService, GoogleStrategy, GoogleAuthGuard, SessionsService],
  exports: [AuthService, SessionsService],
})
export class AuthModule {}
