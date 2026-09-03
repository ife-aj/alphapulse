import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import type { AuthUserDto } from './dto/auth-response.dto';
import type { AuthenticatedRequest } from './authenticated-request';

/**
 * Reusable guard that authenticates a request from its bearer token.
 *
 * Reads `Authorization: Bearer <access_token>`, verifies the token with Supabase
 * Auth via AuthService, and attaches the verified user to the request so
 * downstream handlers can read `request.user` (or `@CurrentUser()`). Any guard
 * failure — missing/malformed header or an invalid/expired token — is a 401.
 *
 * The guard is stateless and request-scoped in behaviour: every request gets its
 * own fresh Supabase client inside AuthService, so no session state is shared.
 */
@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const accessToken = this.extractBearerToken(request.headers.authorization);

    const user: AuthUserDto =
      await this.authService.verifyAccessToken(accessToken);
    request.user = user;
    return true;
  }

  /** Extract a bearer token, or throw a 401 for a missing/malformed header. */
  private extractBearerToken(header: unknown): string {
    if (header === undefined || header === '') {
      throw new UnauthorizedException('Missing authorization header.');
    }
    if (typeof header !== 'string') {
      throw new UnauthorizedException('Invalid authorization header format.');
    }

    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) {
      throw new UnauthorizedException('Invalid authorization header format.');
    }
    return match[1];
  }
}
