// http-exception.filter.ts
import {
  ExceptionFilter, Catch, ArgumentsHost,
  HttpException, HttpStatus, Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import * as Sentry from '@sentry/node';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx      = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request  = ctx.getRequest<Request>();

    const status = exception instanceof HttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    const message = exception instanceof HttpException
      ? exception.getResponse()
      : 'Internal server error';

    if (status === HttpStatus.INTERNAL_SERVER_ERROR) {
      const endpoint = request.route?.path
        ? `${request.baseUrl}${request.route.path}`
        : request.path;

      this.logger.error(
        `${request.method} ${request.path}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
      Sentry.captureException(exception, {
        tags: {
          endpoint: endpoint || 'unknown',
          method: request.method,
        },
      });
    }

    response.status(status).json({
      success:    false,
      statusCode: status,
      timestamp:  new Date().toISOString(),
      path:       request.path,
      message:    typeof message === 'string' ? message : (message as any).message || message,
    });
  }
}
