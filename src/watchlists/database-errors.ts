import {
  BadRequestException,
  ConflictException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

/**
 * AlphaPulse-facing error translation for watchlist database operations.
 *
 * Maps PostgREST errors and thrown/network failures onto Nest HttpExceptions with
 * neutral messages and deliberate HTTP statuses, so clients never see raw
 * database messages or constraint names. RLS-hidden and nonexistent resources
 * deliberately collapse to the same 404, so a resource that belongs to another
 * user is indistinguishable from one that does not exist.
 *
 * The unique-violation mapping is context-driven: a 23505 during watchlist
 * create/rename means a duplicate name, and during item add it means a duplicate
 * symbol. Constraint names are never parsed out of the error text.
 */

/** The minimal slice of a PostgREST error we rely on. */
export interface PostgrestErrorLike {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

/** Which operation the failure came from, used to disambiguate 23505. */
export type WatchlistDatabaseOp =
  | 'create-watchlist'
  | 'rename-watchlist'
  | 'delete-watchlist'
  | 'add-item'
  | 'delete-item'
  | 'list-watchlists'
  | 'list-items';

const WATCHLISTS_UNAVAILABLE = 'Watchlist service is currently unavailable.';
const WATCHLISTS_UNEXPECTED = 'Unexpected error while accessing watchlists.';
const WATCHLIST_NOT_FOUND = 'Watchlist not found.';
const DUPLICATE_NAME = 'A watchlist with this name already exists.';
const DUPLICATE_SYMBOL = 'This symbol is already in the watchlist.';

/** True when `error` looks like a PostgREST error (has a code + message). */
export function isPostgrestError(error: unknown): error is PostgrestErrorLike {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    typeof candidate.code === 'string' &&
    typeof candidate.message === 'string'
  );
}

/** True when a non-PostgREST error looks like Supabase being unreachable. */
function isNetworkError(message: string): boolean {
  return /fetch failed|network|econnrefused|econnreset|socket|timed? ?out|unavailable/i.test(
    message,
  );
}

/** Map any watchlist database failure to a client-safe Nest HttpException. */
export function toDatabaseHttpException(
  error: unknown,
  op: WatchlistDatabaseOp,
): HttpException {
  if (error instanceof HttpException) return error;

  if (!isPostgrestError(error)) {
    const message =
      error &&
      typeof error === 'object' &&
      typeof (error as { message?: unknown }).message === 'string'
        ? ((error as { message: string }).message as string).toLowerCase()
        : '';
    if (isNetworkError(message)) {
      return new ServiceUnavailableException(WATCHLISTS_UNAVAILABLE);
    }
    return new InternalServerErrorException(WATCHLISTS_UNEXPECTED);
  }

  switch (error.code) {
    case '23505':
      if (op === 'create-watchlist' || op === 'rename-watchlist') {
        return new ConflictException(DUPLICATE_NAME);
      }
      if (op === 'add-item') {
        return new ConflictException(DUPLICATE_SYMBOL);
      }
      return new ServiceUnavailableException(WATCHLISTS_UNAVAILABLE);
    // Foreign-key violation (item insert whose parent watchlist is missing or
    // inaccessible) and RLS policy rejection both mean: not yours / not there.
    case '23503':
    case '42501':
      return new NotFoundException(WATCHLIST_NOT_FOUND);
    case '22P02': // invalid UUID (route pipes should prevent this)
      return new BadRequestException('Invalid watchlist identifier.');
    case '23514': // CHECK constraint (symbol/name format; DTO pipes prevent it)
      return new BadRequestException('Invalid input value.');
    case '23502': // NOT NULL violation (user_id) — a server-side bug
      return new InternalServerErrorException(WATCHLISTS_UNEXPECTED);
    default:
      // Unknown PostgREST code — assume a database-side availability/consistency
      // problem rather than something a client can fix.
      return new ServiceUnavailableException(WATCHLISTS_UNAVAILABLE);
  }
}
