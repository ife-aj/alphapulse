import {
  createParamDecorator,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthenticatedRequest } from './authenticated-request';

/**
 * Injects the raw bearer access token attached to the request by
 * SupabaseAuthGuard.
 *
 * Use on a guarded route to build a per-user Supabase client:
 * `createWatchlist(@CurrentToken() token: string)`. Normal missing/invalid
 * tokens are rejected by the guard with a 401 before this ever runs; the 401
 * here is purely defensive for misconfiguration (a guarded route with no token
 * attached).
 */
export const CurrentToken = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.accessToken) {
      throw new UnauthorizedException(
        'No authenticated session found on the request.',
      );
    }
    return request.accessToken;
  },
);
