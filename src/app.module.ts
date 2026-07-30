import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { TerminusModule } from '@nestjs/terminus';

import { PrismaModule }  from './common/prisma/prisma.module';
import { StellarModule } from './common/stellar/stellar.module';

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
import { BackupsModule }      from './modules/backups/backups.module';

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
    BackupsModule,
  ],
})
export class AppModule {}
