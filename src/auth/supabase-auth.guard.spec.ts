import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { SupabaseAuthGuard } from './supabase-auth.guard';
import type { AuthenticatedRequest } from './authenticated-request';
import type { AuthUserDto } from './dto/auth-response.dto';

const safeUser: AuthUserDto = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'user@example.com',
  emailConfirmed: true,
  fullName: null,
  createdAt: '2026-09-02T10:00:00.000Z',
};

describe('SupabaseAuthGuard', () => {
  let verifyAccessToken: jest.Mock;
  let guard: SupabaseAuthGuard;

  /** Build a guard whose AuthService verifies tokens via `verifyAccessToken`. */
  function makeRequest(headers: Record<string, unknown>): AuthenticatedRequest {
    return {
      headers,
      user: undefined as never,
    } as unknown as AuthenticatedRequest;
  }

  function contextFor(request: AuthenticatedRequest): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    verifyAccessToken = jest.fn();
    const authService = { verifyAccessToken } as unknown as AuthService;
    guard = new SupabaseAuthGuard(authService);
  });

  it('rejects a request with no Authorization header', async () => {
    const request = makeRequest({});
    const attempt = guard.canActivate(contextFor(request));
    await expect(attempt).rejects.toThrow(UnauthorizedException);
    await expect(attempt).rejects.toThrow('Missing authorization header.');
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });

  it.each([
    'Basic dXNlcjpwYXNz', // non-Bearer scheme
    'Bearer', // scheme with no token
    'Bearer   ', // whitespace-only token
    'Bearer token with spaces',
  ])('rejects a malformed header %j', async (header) => {
    const request = makeRequest({ authorization: header });
    const attempt = guard.canActivate(contextFor(request));
    await expect(attempt).rejects.toThrow(UnauthorizedException);
    await expect(attempt).rejects.toThrow(
      'Invalid authorization header format.',
    );
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });

  it('attaches the verified user for a valid bearer token', async () => {
    verifyAccessToken.mockResolvedValue(safeUser);
    const request = makeRequest({ authorization: 'Bearer valid-token' });

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);

    expect(verifyAccessToken).toHaveBeenCalledWith('valid-token');
    expect(request.user).toEqual(safeUser);
  });

  it('propagates a 401 when the token is invalid or expired', async () => {
    verifyAccessToken.mockRejectedValue(
      new UnauthorizedException('Invalid or expired access token.'),
    );
    const request = makeRequest({ authorization: 'Bearer expired-token' });

    const attempt = guard.canActivate(contextFor(request));
    await expect(attempt).rejects.toThrow(UnauthorizedException);
    expect(request.user).toBeUndefined();
  });
});
