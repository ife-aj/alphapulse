import {
  createParamDecorator,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthUserDto } from './dto/auth-response.dto';
import type { AuthenticatedRequest } from './authenticated-request';

/**
 * Injects the user attached to the request by SupabaseAuthGuard.
 *
 * Use on a guarded route: `me(@CurrentUser() user: AuthUserDto)`. If no user is
 * present (e.g. the decorator is used without the guard) it throws 401 rather
 * than returning undefined.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUserDto => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user) {
      throw new UnauthorizedException(
        'No authenticated user found on the request.',
      );
    }
    return request.user;
  },
);
