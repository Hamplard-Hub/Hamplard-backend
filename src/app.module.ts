import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { TerminusModule } from '@nestjs/terminus';

import { PrismaModule }  from './common/prisma/prisma.module';
import { StellarModule } from './common/stellar/stellar.module';
import { CacheModule }   from './common/cache/cache.module';
import { RateLimitMiddleware } from './common/middleware/rate-limit.middleware';
import { WebhookSignatureMiddleware } from './common/middleware/webhook-signature.middleware';
import { RoleThrottlerGuard } from './common/guards/role-throttler.guard';

import { AuthModule }         from './modules/auth/auth.module';
import { UsersModule }        from './modules/users/users.module';
import { CoursesModule }      from './modules/courses/courses.module';
import { LessonsModule }      from './modules/lessons/lessons.module';
import { EnrollmentsModule }  from './modules/enrollments/enrollments.module';
import { AssignmentsModule }  from './modules/assignments/assignments.module';
import { CertificatesModule } from './modules/certificates/certificates.module';
import { EventsModule }       from './modules/events/events.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { DiscussionsModule }  from './modules/discussions/discussions.module';
import { HealthModule }       from './modules/health/health.module';
import { QuizzesModule }      from './modules/quizzes/quizzes.module';
import { ExamsModule }        from './modules/exams/exams.module';
import { LiveSessionsModule } from './modules/live-sessions/live-sessions.module';
import { PayoutsModule }      from './modules/payouts/payouts.module';
import { ReportsModule }      from './modules/reports/reports.module';
import { ReviewsModule }      from './modules/reviews/reviews.module';
import { AdminModule }        from './modules/admin/admin.module';
import { ModerationModule }   from './modules/moderation/moderation.module';
import { GamificationModule } from './modules/gamification/gamification.module';
import { ReferralsModule }    from './modules/referrals/referrals.module';
import { AuditLogModule }     from './modules/audit-log/audit-log.module';
import { AnalyticsModule }    from './modules/analytics/analytics.module';
import { BackupsModule }      from './modules/backups/backups.module';
import { UploadsModule }      from './modules/uploads/uploads.module';
import { TagsModule }         from './modules/tags/tags.module';
import { LearningPathsModule } from './modules/learning-paths/learning-paths.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),

    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [
        {
          ttl:   config.get<number>('THROTTLE_TTL', 60) * 1000,
          limit: config.get<number>('THROTTLE_LIMIT', 100),
        },
      ],
    }),

    ScheduleModule.forRoot(),
    TerminusModule,
    PrismaModule,
    StellarModule,
    CacheModule,

    AuthModule,
    UsersModule,
    CoursesModule,
    LessonsModule,
    EnrollmentsModule,
    AssignmentsModule,
    CertificatesModule,
    EventsModule,
    NotificationsModule,
    DiscussionsModule,
    HealthModule,
    QuizzesModule,
    ExamsModule,
    LiveSessionsModule,
    PayoutsModule,
    ReportsModule,
    ReviewsModule,
    AdminModule,
    ModerationModule,
    GamificationModule,
    ReferralsModule,
    AuditLogModule,
    AnalyticsModule,
    BackupsModule,
    UploadsModule,
    TagsModule,
    LearningPathsModule,
  ],
  providers: [
    // Issue #72 — role-based throttling runs before every route's own guards
    { provide: APP_GUARD, useClass: RoleThrottlerGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Issue #71 — global per-IP rate limiting (runs before all guards)
    consumer.apply(RateLimitMiddleware).forRoutes('*');

    // Webhook HMAC-SHA256 signature verification.
    // Applied only to /webhooks/* routes so legitimate API traffic is unaffected.
    // Add .exclude({ path: 'webhooks/ping', method: RequestMethod.GET }) for
    // unsigned health-check endpoints from specific providers.
    consumer
      .apply(WebhookSignatureMiddleware)
      .forRoutes('webhooks');
  }
}
