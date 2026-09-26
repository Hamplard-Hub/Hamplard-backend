import * as Sentry from '@sentry/node';

const SENSITIVE_FIELD = /authorization|cookie|password|secret|token|api[-_]?key|otp|email|phone/i;

export function scrubSentryEvent<T>(event: T): T {
  return scrubValue(event) as T;
}

function scrubValue(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_FIELD.test(key)) {
    return '[Filtered]';
  }

  if (key === 'query_string') {
    return undefined;
  }

  if (key === 'url' && typeof value === 'string') {
    return value.replace(/[?#].*$/, '');
  }

  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).flatMap(([entryKey, entryValue]) => {
        const scrubbedValue = scrubValue(entryValue, entryKey);
        return scrubbedValue === undefined ? [] : [[entryKey, scrubbedValue]];
      }),
    );
  }

  return value;
}

export function initializeSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
    release: process.env.SENTRY_RELEASE || `hamplard-backend@${process.env.npm_package_version || '0.1.0'}`,
    beforeSend: (event) => scrubSentryEvent(event),
  });
}