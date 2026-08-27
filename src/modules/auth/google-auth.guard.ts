import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ExecutionContext } from '@nestjs/common';
import { Response } from 'express';
import { GoogleAuthService } from './google-auth.service';

@Injectable()
export class GoogleAuthGuard extends AuthGuard('google') {
  constructor(private readonly googleAuth: GoogleAuthService) {
    super();
  }

  getAuthenticateOptions(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    if (request.path.endsWith('/callback')) return {};

    const response = context.switchToHttp().getResponse<Response>();
    const state = this.googleAuth.createOAuthState();
    response.cookie('google_oauth_state', state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: request.secure,
      maxAge: 5 * 60 * 1000,
    });
    return { state };
  }

  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    if (request.path.endsWith('/callback')) {
      const state = request.query?.state;
      const cookies = this.parseCookies(request.headers.cookie);
      if (
        typeof state !== 'string' ||
        cookies.google_oauth_state !== state ||
        !this.googleAuth.consumeOAuthState(state)
      ) {
        throw new UnauthorizedException('Invalid or expired Google OAuth state');
      }
      context.switchToHttp().getResponse<Response>().clearCookie('google_oauth_state');
    }

    return super.canActivate(context);
  }

  private parseCookies(header?: string): Record<string, string> {
    return (header ?? '').split(';').reduce((cookies, part) => {
      const separator = part.indexOf('=');
      if (separator === -1) return cookies;
      const name = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      if (name) cookies[name] = decodeURIComponent(value);
      return cookies;
    }, {} as Record<string, string>);
  }
}