import { DocumentBuilder, OpenAPIObject } from '@nestjs/swagger';

/**
 * Shared Swagger document config — used by main.ts and by the route smoke
 * test so both see the same tag list.
 */
export function buildSwaggerConfig(): Omit<OpenAPIObject, 'paths'> {
  return new DocumentBuilder()
    .setTitle('Hamplard API')
    .setDescription(
      'Backend API for Hamplard — Africa\'s practical skills online learning platform',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .addTag('auth',         'Stellar wallet authentication')
    .addTag('users',        'User profiles and management')
    .addTag('courses',      'Course creation, approval, and browsing')
    .addTag('lessons',      'Lesson content and progress')
    .addTag('enrollments',  'Course enrollment and payments')
    .addTag('refunds',      'Refund requests and processing')
    .addTag('bundles',      'Course bundles')
    .addTag('assignments',  'Practical assignment submission and review')
    .addTag('certificates', 'Certificate issuance and verification')
    .addTag('certificate-templates', 'Admin certificate branding, layout, and signature templates')
    .addTag('events',       'On-chain Stellar event feed')
    .addTag('notifications','User notifications')
    .addTag('sms',          'SMS alerts and delivery status')
    .addTag('reports',      'Abuse reports on courses, comments, and profiles')
    .addTag('reviews',      'Course ratings and reviews')
    .addTag('health',       'Health check')
    .addTag('coupons',      'Discount coupon creation and validation')
    .addTag('disputes',     'Course and payment dispute management')
    .addTag('kyc',          'Instructor identity verification')
    .addTag('payouts',      'Instructor payout schedules and processing')
    .addTag('tags',         'Searchable tag management for courses')
    .addTag('feature-flags','Admin feature flag management and evaluation')
    .addTag('cron-monitor', 'Admin cron job run history and monitoring')
    .addTag('admin',        'Admin operations: impersonation, audit logs')
    .addTag('revenue',      'Revenue reports and analytics')
    .addTag('moderation',   'Content moderation and abuse handling')
    .build();
}
