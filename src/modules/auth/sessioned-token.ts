import { JwtService } from '@nestjs/jwt';
import { RefreshTokenService, TokenPair, TokenUser } from './refresh-token.service';
import { DeviceMetadata, SessionsService } from './sessions.service';

/**
 * Fallback session lifetime used only when an access token has no `exp` claim.
 * Keeps the historical 7-day behaviour of every login path.
 */
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type AccessTokenDecoder = Pick<JwtService, 'decode'>;
type TokenPairIssuer = Pick<RefreshTokenService, 'issueTokenPair'>;
type SessionCreator = Pick<SessionsService, 'createSession'>;

interface DecodedAccessToken {
  exp?: number;
  jti?: string;
  sub?: string;
}

/**
 * Create the session row for an access token.
 *
 * This is the single implementation used by every token-issuing path
 * (wallet login, Google login, Google + TOTP login and refresh), so session
 * rules — `jti`/`sub` validation, expiry, ban checks, refresh-family linking —
 * only ever need to be added or changed here.
 */
export async function trackAccessTokenSession(
  jwt: AccessTokenDecoder,
  sessions: SessionCreator,
  accessToken: string,
  deviceMeta?: DeviceMetadata,
  familyId?: string,
): Promise<void> {
  const decoded = jwt.decode(accessToken) as DecodedAccessToken | null;
  if (!decoded?.jti || !decoded.sub) return;

  const expiresAt = decoded.exp
    ? new Date(decoded.exp * 1000)
    : new Date(Date.now() + DEFAULT_SESSION_TTL_MS);

  const sessionParams: {
    userId: string;
    jti: string;
    expiresAt: Date;
    meta?: DeviceMetadata;
    familyId?: string;
  } = {
    userId: decoded.sub,
    jti: decoded.jti,
    expiresAt,
    meta: deviceMeta,
  };
  if (familyId) {
    sessionParams.familyId = familyId;
  }

  await sessions.createSession(sessionParams);
}

/**
 * Issue a rotating refresh pair and track its access-token session in one step.
 *
 * Shared by all login paths so the token issuance + session creation sequence
 * cannot drift between wallet and Google authentication.
 */
export async function issueSessionedTokenPair(
  refreshTokens: TokenPairIssuer,
  jwt: AccessTokenDecoder,
  sessions: SessionCreator,
  user: TokenUser,
  deviceMeta?: DeviceMetadata,
): Promise<TokenPair> {
  const tokens = await refreshTokens.issueTokenPair(user);
  let familyId = (tokens as any).familyId;
  if (!familyId && tokens.refreshToken) {
    const decodedRefresh = jwt.decode(tokens.refreshToken) as { familyId?: string } | null;
    familyId = decodedRefresh?.familyId;
  }
  await trackAccessTokenSession(jwt, sessions, tokens.accessToken, deviceMeta, familyId);
  return tokens;
}
