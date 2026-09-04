import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { toDatabaseHttpException } from './database-errors';

/** Minimal PostgREST-shaped error. */
function pgError(code: string, message = 'database message', details = '') {
  return { code, message, details };
}

describe('toDatabaseHttpException', () => {
  describe('unique violations (23505) are disambiguated by operation context', () => {
    it('maps 23505 on create watchlist to a duplicate-name 409', () => {
      const e = toDatabaseHttpException(pgError('23505'), 'create-watchlist');
      expect(e).toBeInstanceOf(ConflictException);
      expect(e.getStatus()).toBe(409);
      expect(e.getResponse()).toEqual(
        expect.objectContaining({
          message: 'A watchlist with this name already exists.',
        }),
      );
    });

    it('maps 23505 on rename watchlist to a duplicate-name 409', () => {
      const e = toDatabaseHttpException(pgError('23505'), 'rename-watchlist');
      expect(e).toBeInstanceOf(ConflictException);
      expect(e.getStatus()).toBe(409);
    });

    it('maps 23505 on add item to a duplicate-symbol 409', () => {
      const e = toDatabaseHttpException(pgError('23505'), 'add-item');
      expect(e).toBeInstanceOf(ConflictException);
      expect(e.getStatus()).toBe(409);
      expect(e.getResponse()).toEqual(
        expect.objectContaining({
          message: 'This symbol is already in the watchlist.',
        }),
      );
    });

    it('never echoes the raw database message or constraint name', () => {
      const e = toDatabaseHttpException(
        pgError(
          '23505',
          'duplicate key value violates unique constraint "uq_watchlists_user_lower_name"',
          'Key (user_id, lower(btrim(name)))=(…, tech) already exists.',
        ),
        'create-watchlist',
      );
      const body = JSON.stringify(e.getResponse());
      expect(body).not.toContain('uq_watchlists_user_lower_name');
      expect(body).not.toContain('lower(btrim(name))');
      expect(body).not.toContain('duplicate key');
    });
  });

  it('maps FK (23503) and RLS (42501) violations to a neutral 404', () => {
    for (const code of ['23503', '42501']) {
      const e = toDatabaseHttpException(pgError(code), 'add-item');
      expect(e).toBeInstanceOf(NotFoundException);
      expect(e.getStatus()).toBe(404);
      expect(e.getResponse()).toEqual(
        expect.objectContaining({ message: 'Watchlist not found.' }),
      );
    }
  });

  it('maps invalid-UUID (22P02) and CHECK (23514) violations to 400', () => {
    expect(toDatabaseHttpException(pgError('22P02'), 'delete-watchlist')).toBeInstanceOf(
      BadRequestException,
    );
    expect(toDatabaseHttpException(pgError('23514'), 'add-item')).toBeInstanceOf(
      BadRequestException,
    );
  });

  it('maps a NOT NULL (23502) violation to a neutral 500', () => {
    const e = toDatabaseHttpException(
      pgError('23502', 'null value in column "user_id"'),
      'create-watchlist',
    );
    expect(e).toBeInstanceOf(InternalServerErrorException);
    expect(e.getStatus()).toBe(500);
    expect(JSON.stringify(e.getResponse())).not.toContain('user_id');
  });

  it('maps unknown PostgREST codes to a 503', () => {
    const e = toDatabaseHttpException(pgError('XX000'), 'list-watchlists');
    expect(e).toBeInstanceOf(ServiceUnavailableException);
    expect(e.getStatus()).toBe(503);
  });

  it('maps thrown network failures to a 503', () => {
    for (const message of [
      'fetch failed',
      'connect ECONNREFUSED 127.0.0.1:5432',
      'socket hang up',
      'request timed out',
    ]) {
      const e = toDatabaseHttpException(new Error(message), 'list-watchlists');
      expect(e).toBeInstanceOf(ServiceUnavailableException);
    }
  });

  it('maps unexpected non-network throws to a neutral 500', () => {
    const e = toDatabaseHttpException(
      new TypeError('x is not a function'),
      'list-watchlists',
    );
    expect(e).toBeInstanceOf(InternalServerErrorException);
    expect(JSON.stringify(e.getResponse())).not.toContain('x is not a function');
  });

  it('passes an HttpException through unchanged', () => {
    const original = new NotFoundException('Watchlist not found.');
    expect(toDatabaseHttpException(original, 'delete-watchlist')).toBe(original);
  });
});
