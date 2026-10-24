import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { NextFunction, Response } from 'express';
import { WebhookSignatureMiddleware } from './webhook-signature.middleware';

const SECRET = 'whsec_test_secret';
const BODY = Buffer.from('{"id":"evt_1"}', 'utf8');

function mockConfig(values: Record<string, unknown> = {}) {
  const merged = { WEBHOOK_SECRET: SECRET, ...values };
  return {
    get: jest.fn((key: string) => merged[key]),
  } as unknown as ConfigService;
}

function stripeSig(secret: string, timestamp: number, body: Buffer, extraV1?: string): string {
  const v1 = createHmac('sha256', secret)
    .update(String(timestamp))
    .update('.')
    .update(body)
    .digest('hex');
  return extraV1
    ? `t=${timestamp},v1=${extraV1},v1=${v1}`
    : `t=${timestamp},v1=${v1}`;
}

function genericBodySig(secret: string, body: Buffer): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function genericTimedSig(secret: string, timestamp: number, body: Buffer): string {
  const hex = createHmac('sha256', secret)
    .update(String(timestamp))
    .update('.')
    .update(body)
    .digest('hex');
  return `t=${timestamp},sha256=${hex}`;
}

describe('WebhookSignatureMiddleware', () => {
  const next: NextFunction = jest.fn();
  const res = {} as Response;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  function run(
    middleware: WebhookSignatureMiddleware,
    headers: Record<string, string>,
    extras: { url?: string; rawBody?: Buffer } = {},
  ) {
    return middleware.use(
      {
        headers,
        method: 'POST',
        originalUrl: extras.url ?? '/api/v1/webhooks/stripe',
        rawBody: extras.rawBody ?? BODY,
      } as any,
      res,
      next,
    );
  }

  it('accepts a valid Stripe signature within the tolerance window', () => {
    const now = 1_700_000_000;
    jest.useFakeTimers().setSystemTime(now * 1000);
    const middleware = new WebhookSignatureMiddleware(mockConfig());

    run(middleware, { 'stripe-signature': stripeSig(SECRET, now, BODY) });

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects a Stripe payload older than the configured tolerance', () => {
    const now = 1_700_000_000;
    jest.useFakeTimers().setSystemTime(now * 1000);
    const middleware = new WebhookSignatureMiddleware(
      mockConfig({ WEBHOOK_STRIPE_TOLERANCE_SECONDS: 60 }),
    );

    expect(() =>
      run(middleware, { 'stripe-signature': stripeSig(SECRET, now - 120, BODY) }),
    ).toThrow(ForbiddenException);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects an invalid Stripe signature', () => {
    const now = 1_700_000_000;
    jest.useFakeTimers().setSystemTime(now * 1000);
    const middleware = new WebhookSignatureMiddleware(mockConfig());

    expect(() =>
      run(middleware, { 'stripe-signature': `t=${now},v1=${'ab'.repeat(32)}` }),
    ).toThrow(ForbiddenException);
  });

  it('accepts when any of multiple v1 signatures matches', () => {
    const now = 1_700_000_000;
    jest.useFakeTimers().setSystemTime(now * 1000);
    const middleware = new WebhookSignatureMiddleware(mockConfig());

    run(middleware, {
      'stripe-signature': stripeSig(SECRET, now, BODY, 'ff'.repeat(32)),
    });

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed Stripe signature header', () => {
    const middleware = new WebhookSignatureMiddleware(mockConfig());

    expect(() =>
      run(middleware, { 'stripe-signature': 'not-a-valid-header' }),
    ).toThrow(ForbiddenException);
  });

  it('enforces generic timestamp tolerance', () => {
    const now = 1_700_000_000;
    jest.useFakeTimers().setSystemTime(now * 1000);
    const middleware = new WebhookSignatureMiddleware(
      mockConfig({ WEBHOOK_TOLERANCE_SECONDS: 30 }),
    );

    expect(() =>
      run(
        middleware,
        { 'x-webhook-signature': genericTimedSig(SECRET, now - 90, BODY) },
        { url: '/api/v1/webhooks/custom' },
      ),
    ).toThrow(ForbiddenException);

    run(
      middleware,
      { 'x-webhook-signature': genericTimedSig(SECRET, now, BODY) },
      { url: '/api/v1/webhooks/custom' },
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('verifies generic sha256 signatures against the exact raw body', () => {
    const middleware = new WebhookSignatureMiddleware(mockConfig());
    const raw = Buffer.from('{ "id": "evt_1" }', 'utf8');
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(raw.toString())));

    run(
      middleware,
      { 'x-webhook-signature': genericBodySig(SECRET, raw) },
      { url: '/api/v1/webhooks/github', rawBody: raw },
    );
    expect(next).toHaveBeenCalledTimes(1);

    expect(() =>
      run(
        middleware,
        { 'x-webhook-signature': genericBodySig(SECRET, reserialized) },
        { url: '/api/v1/webhooks/github', rawBody: raw },
      ),
    ).toThrow(ForbiddenException);
  });

  it('skips verification for excluded routes at the middleware layer', () => {
    const middleware = new WebhookSignatureMiddleware(mockConfig());

    run(middleware, {}, { url: '/api/v1/webhooks/ping' });

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects missing signatures on protected routes', () => {
    const middleware = new WebhookSignatureMiddleware(mockConfig());

    expect(() => run(middleware, {}, { url: '/api/v1/webhooks/stripe' })).toThrow(
      UnauthorizedException,
    );
  });

  it('does not disable verification when tolerance config is invalid', () => {
    const now = 1_700_000_000;
    jest.useFakeTimers().setSystemTime(now * 1000);
    const middleware = new WebhookSignatureMiddleware(
      mockConfig({ WEBHOOK_TOLERANCE_SECONDS: 'not-a-number' }),
    );

    run(middleware, { 'stripe-signature': stripeSig(SECRET, now, BODY) });
    expect(next).toHaveBeenCalledTimes(1);

    expect(() =>
      run(middleware, { 'stripe-signature': stripeSig(SECRET, now - 400, BODY) }),
    ).toThrow(ForbiddenException);
  });
});
