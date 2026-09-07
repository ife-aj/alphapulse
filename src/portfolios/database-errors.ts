import {
  BadRequestException,
  ConflictException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

/**
 * AlphaPulse-facing error translation for portfolio database operations.
 *
 * Mirrors the watchlist mapper: PostgREST errors and thrown/network failures are
 * mapped onto Nest HttpExceptions with neutral messages and deliberate statuses,
 * so clients never see raw database messages or constraint names. RLS-hidden and
 * nonexistent resources collapse to the same 404, making another user's data
 * indistinguishable from data that does not exist.
 *
 * The unique-violation mapping is context-driven: a 23505 during portfolio
 * create/rename means a duplicate name; during holding insert it means a
 * duplicate symbol. Constraint names are never parsed out of the error text.
 */

/** The minimal slice of a PostgREST error we rely on. */
export interface PostgrestErrorLike {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

/** Which operation the failure came from, used to disambiguate 23505. */
export type PortfolioDatabaseOp =
  | 'create-portfolio'
  | 'list-portfolios'
  | 'get-portfolio'
  | 'get-holdings'
  | 'rename-portfolio'
  | 'delete-portfolio'
  | 'add-holding'
  | 'update-holding'
  | 'delete-holding'
  | 'list-holdings';

const PORTFOLIOS_UNAVAILABLE = 'Portfolio service is currently unavailable.';
const PORTFOLIOS_UNEXPECTED = 'Unexpected error while accessing portfolios.';
const PORTFOLIO_NOT_FOUND = 'Portfolio not found.';
const DUPLICATE_NAME = 'A portfolio with this name already exists.';
const DUPLICATE_SYMBOL = 'This symbol is already held in the portfolio.';

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

/** Map any portfolio database failure to a client-safe Nest HttpException. */
export function toDatabaseHttpException(
  error: unknown,
  op: PortfolioDatabaseOp,
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
      return new ServiceUnavailableException(PORTFOLIOS_UNAVAILABLE);
    }
    return new InternalServerErrorException(PORTFOLIOS_UNEXPECTED);
  }

  switch (error.code) {
    case '23505':
      if (op === 'create-portfolio' || op === 'rename-portfolio') {
        return new ConflictException(DUPLICATE_NAME);
      }
      if (op === 'add-holding') {
        return new ConflictException(DUPLICATE_SYMBOL);
      }
      return new ServiceUnavailableException(PORTFOLIOS_UNAVAILABLE);
    // Foreign-key violation (holding insert whose parent portfolio is missing or
    // inaccessible) and RLS policy rejection both mean: not yours / not there.
    case '23503':
    case '42501':
      return new NotFoundException(PORTFOLIO_NOT_FOUND);
    case '22P02': // invalid UUID (route pipes should prevent this)
      return new BadRequestException('Invalid portfolio identifier.');
    case '23514': // CHECK constraint (symbol/quantity format; DTOs prevent it)
      return new BadRequestException('Invalid input value.');
    case '23502': // NOT NULL violation (user_id / quantity) — a server-side bug
      return new InternalServerErrorException(PORTFOLIOS_UNEXPECTED);
    default:
      // Unknown PostgREST code — assume a database-side availability/consistency
      // problem rather than something a client can fix.
      return new ServiceUnavailableException(PORTFOLIOS_UNAVAILABLE);
  }
}
