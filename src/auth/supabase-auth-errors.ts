import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

/**
 * AlphaPulse-facing error translation for Supabase Auth.
 *
 * Clients of /api/auth should understand AlphaPulse errors, never raw Supabase
 * messages or provider internals. Every function here maps a Supabase auth
 * error to a Nest HttpException with a neutral message and a deliberate HTTP
 * status, using the built-in exception subclasses so every body keeps the same
 * `{ statusCode, message, error }` shape the rest of the API uses.
 *
 * Supabase errors are recognized structurally (message + status / __isAuthError
 * / error-name), not by class identity, so the mapping keeps working across
 * supabase-js versions.
 */

/** The minimal slice of a Supabase auth error we rely on. */
interface AuthErrorLike {
  message?: string;
  status?: number;
  name?: string;
}

const AUTH_ERROR_NAME_HINTS = [
  'AuthApiError',
  'AuthRetryableFetchError',
  'AuthWeakPasswordError',
  'AuthSessionMissingError',
];

/** True when `error` looks like an error thrown by Supabase Auth. */
export function isAuthError(error: unknown): error is AuthErrorLike {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    message?: unknown;
    status?: unknown;
    name?: unknown;
    __isAuthError?: unknown;
  };
  const hasMessage =
    typeof candidate.message === 'string' && candidate.message !== '';
  const hasNumericStatus = typeof candidate.status === 'number';
  // Property narrowing does not survive into the .some() closure, so bind the
  // name to a local first. An empty name simply never matches a hint.
  const candidateName =
    typeof candidate.name === 'string' ? candidate.name : '';
  const hasHintName = AUTH_ERROR_NAME_HINTS.some((hint) =>
    candidateName.includes(hint),
  );
  const looksLikeAuth =
    candidate.__isAuthError === true || hasHintName || hasNumericStatus;
  return hasMessage && looksLikeAuth;
}

/**
 * True when the failure looks like Supabase being unreachable (rather than a
 * rejected credential). Used to distinguish "the auth service is down" from
 * "this token/credentials are wrong".
 */
export function isRetryableAuthError(error: unknown): boolean {
  if (!isAuthError(error)) return false;
  if (error.name === 'AuthRetryableFetchError') return true;
  const message = (error.message ?? '').toLowerCase();
  return /fetch failed|network|econnrefused|econnreset|socket|timed? ?out|unavailable/i.test(
    message,
  );
}

/**
 * Map any thrown Supabase auth error to a client-safe Nest HttpException.
 *
 * Classification is deliberately conservative: only messages we are confident
 * about are special-cased; everything else collapses to a small set of generic
 * 4xx/5xx responses so AlphaPulse never echoes Supabase internals back.
 */
export function toAuthHttpException(error: unknown): HttpException {
  if (!isAuthError(error)) {
    // Not a Supabase auth error — most likely an AlphaPulse bug. Do not leak it.
    return new InternalServerErrorException(
      'Unexpected error during authentication.',
    );
  }

  if (isRetryableAuthError(error)) {
    return new ServiceUnavailableException(
      'Authentication service is currently unavailable.',
    );
  }

  const message = (error.message ?? '').toLowerCase();

  // Reached only when Supabase returns an *explicit* conflict. When email
  // confirmation is enabled a duplicate arrives as an obfuscated success (no
  // session) instead — AuthService.register answers that with the same neutral
  // confirmation-required body as a new signup, never a 409.
  if (
    message.includes('already registered') ||
    message.includes('already been registered')
  ) {
    return new ConflictException('An account with this email already exists.');
  }
  if (message.includes('invalid login credentials')) {
    return new UnauthorizedException('Email or password is incorrect.');
  }
  if (message.includes('email not confirmed')) {
    return new ForbiddenException(
      'Please confirm your email address before signing in.',
    );
  }
  if (
    message.includes('password should be at least') ||
    message.includes('weak password')
  ) {
    return new BadRequestException(
      'Password does not meet the minimum requirements.',
    );
  }

  const status = error.status;
  if (typeof status === 'number' && status >= 500) {
    return new BadGatewayException('Authentication service returned an error.');
  }
  // Any other 4xx is a client-side problem; keep the message generic.
  return new BadRequestException(
    'Authentication request could not be completed.',
  );
}
