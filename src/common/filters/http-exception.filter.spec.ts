import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { HttpExceptionFilter } from './http-exception.filter';
import { initializeSentry, scrubSentryEvent } from '../logging/sentry';

jest.mock('@sentry/node', () => ({
  captureException: jest.fn(),
  init: jest.fn(),
}));

describe('HttpExceptionFilter', () => {
  const filter = new HttpExceptionFilter();
  const response = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
  const request = {
    method: 'POST',
    url: '/api/v1/users?token=private',
    path: '/api/v1/users',
    baseUrl: '/api/v1',
    route: { path: '/users' },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.SENTRY_DSN;
    delete process.env.SENTRY_ENVIRONMENT;
    delete process.env.SENTRY_RELEASE;
  });

  it('captures server errors with stable endpoint and method tags', () => {
    const error = new Error('unexpected failure');

    filter.catch(error, host);

    expect(Sentry.captureException).toHaveBeenCalledWith(error, {
      tags: { endpoint: '/api/v1/users', method: 'POST' },
    });
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      path: '/api/v1/users',
    }));
  });

  it('does not report expected client errors to Sentry', () => {
    filter.catch(new HttpException('Not found', HttpStatus.NOT_FOUND), host);

    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('scrubs secrets and query strings from events before sending', () => {
    const event = scrubSentryEvent({
      request: {
        url: 'https://api.example.test/users?token=private#section',
        headers: { authorization: 'Bearer private', 'content-type': 'application/json' },
        data: { email: 'private@example.test', displayName: 'Learner' },
      },
      extra: { apiKey: 'private-key', detail: 'useful error context' },
    });

    expect(JSON.stringify(event)).not.toMatch(/private/);
    expect(event).toEqual({
      request: {
        url: 'https://api.example.test/users',
        headers: { authorization: '[Filtered]', 'content-type': 'application/json' },
        data: { email: '[Filtered]', displayName: 'Learner' },
      },
      extra: { apiKey: '[Filtered]', detail: 'useful error context' },
    });
  });

  it('configures Sentry environment and release from deployment settings', () => {
    process.env.SENTRY_DSN = 'https://public@example.test/1';
    process.env.SENTRY_ENVIRONMENT = 'production';
    process.env.SENTRY_RELEASE = 'hamplard-backend@abc123';

    initializeSentry();

    expect(Sentry.init).toHaveBeenCalledWith(expect.objectContaining({
      dsn: process.env.SENTRY_DSN,
      environment: 'production',
      release: 'hamplard-backend@abc123',
      beforeSend: expect.any(Function),
    }));
  });
});