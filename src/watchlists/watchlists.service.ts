import {
  HttpException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { toDatabaseHttpException } from './database-errors';
import {
  WatchlistDto,
  WatchlistItemDto,
  WatchlistsResponseDto,
} from './dto/watchlist-response.dto';
import type { WatchlistItemRow, WatchlistRow } from './watchlist.types';

const WATCHLISTS_UNEXPECTED = 'Unexpected error while accessing watchlists.';
const WATCHLIST_NOT_FOUND = 'Watchlist not found.';

function toWatchlistItemDto(row: WatchlistItemRow): WatchlistItemDto {
  return {
    id: row.id,
    symbol: row.symbol,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toWatchlistDto(row: WatchlistRow): WatchlistDto {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Watchlist database operations, scoped per authenticated user.
 *
 * Every operation runs on a *fresh* client from
 * `SupabaseService.createUserClient(accessToken)` whose requests carry the
 * user's JWT. Row Level Security is the ownership boundary: rows that are not
 * the caller's are either filtered out (reads) or rejected/filtered by RLS
 * (writes), and any RLS-hidden or nonexistent resource answers the same neutral
 * 404. The shared singleton client is never mutated with per-user headers, and
 * no service-role key is used anywhere.
 *
 * Insert operations use `.insert(...).select().single()` (supabase-js adds
 * `Prefer: return=representation` automatically) and treat a successful call
 * that returns no row as an unexpected service failure. Update/delete use
 * `.select().maybeSingle()` so a zero-row result (not found or RLS-hidden) is a
 * clean `data: null` that maps to 404.
 */
@Injectable()
export class WatchlistsService {
  constructor(private readonly supabase: SupabaseService) {}

  async create(
    userId: string,
    accessToken: string,
    name: string,
  ): Promise<WatchlistDto> {
    const client = this.supabase.createUserClient(accessToken);
    try {
      const { data, error } = await client
        .from('watchlists')
        .insert({ user_id: userId, name })
        .select()
        .single();
      if (error) throw toDatabaseHttpException(error, 'create-watchlist');
      if (data === null) throw new InternalServerErrorException(WATCHLISTS_UNEXPECTED);
      return toWatchlistDto(data as WatchlistRow);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw toDatabaseHttpException(error, 'create-watchlist');
    }
  }

  async list(
    userId: string,
    accessToken: string,
  ): Promise<WatchlistsResponseDto> {
    const client = this.supabase.createUserClient(accessToken);
    try {
      const { data, error } = await client
        .from('watchlists')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .order('id');
      if (error) throw toDatabaseHttpException(error, 'list-watchlists');

      const watchlists = (data ?? []) as WatchlistRow[];
      if (watchlists.length === 0) {
        return { watchlists: [] };
      }

      const ids = watchlists.map((watchlist) => watchlist.id);
      const { data: itemRows, error: itemError } = await client
        .from('watchlist_items')
        .select('*')
        .in('watchlist_id', ids)
        .order('created_at')
        .order('id');
      if (itemError) throw toDatabaseHttpException(itemError, 'list-items');

      const itemsByWatchlist = new Map<string, WatchlistItemDto[]>();
      for (const row of (itemRows ?? []) as WatchlistItemRow[]) {
        const items = itemsByWatchlist.get(row.watchlist_id) ?? [];
        items.push(toWatchlistItemDto(row));
        itemsByWatchlist.set(row.watchlist_id, items);
      }

      return {
        watchlists: watchlists.map((watchlist) => ({
          ...toWatchlistDto(watchlist),
          items: itemsByWatchlist.get(watchlist.id) ?? [],
        })),
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw toDatabaseHttpException(error, 'list-watchlists');
    }
  }

  async rename(
    userId: string,
    accessToken: string,
    id: string,
    name: string,
  ): Promise<WatchlistDto> {
    const client = this.supabase.createUserClient(accessToken);
    try {
      const { data, error } = await client
        .from('watchlists')
        .update({ name })
        .eq('id', id)
        .eq('user_id', userId)
        .select()
        .maybeSingle();
      if (error) throw toDatabaseHttpException(error, 'rename-watchlist');
      if (data === null) throw new NotFoundException(WATCHLIST_NOT_FOUND);
      return toWatchlistDto(data as WatchlistRow);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw toDatabaseHttpException(error, 'rename-watchlist');
    }
  }

  async remove(userId: string, accessToken: string, id: string): Promise<void> {
    const client = this.supabase.createUserClient(accessToken);
    try {
      const { data, error } = await client
        .from('watchlists')
        .delete()
        .eq('id', id)
        .eq('user_id', userId)
        .select()
        .maybeSingle();
      if (error) throw toDatabaseHttpException(error, 'delete-watchlist');
      if (data === null) throw new NotFoundException(WATCHLIST_NOT_FOUND);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw toDatabaseHttpException(error, 'delete-watchlist');
    }
  }

  async addItem(
    accessToken: string,
    watchlistId: string,
    symbol: string,
  ): Promise<WatchlistItemDto> {
    const client = this.supabase.createUserClient(accessToken);
    try {
      const { data, error } = await client
        .from('watchlist_items')
        .insert({ watchlist_id: watchlistId, symbol })
        .select()
        .single();
      if (error) throw toDatabaseHttpException(error, 'add-item');
      if (data === null) throw new InternalServerErrorException(WATCHLISTS_UNEXPECTED);
      return toWatchlistItemDto(data as WatchlistItemRow);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw toDatabaseHttpException(error, 'add-item');
    }
  }

  async removeItem(
    accessToken: string,
    watchlistId: string,
    symbol: string,
  ): Promise<void> {
    const client = this.supabase.createUserClient(accessToken);
    try {
      const { data, error } = await client
        .from('watchlist_items')
        .delete()
        .eq('watchlist_id', watchlistId)
        .eq('symbol', symbol)
        .select()
        .maybeSingle();
      if (error) throw toDatabaseHttpException(error, 'delete-item');
      if (data === null) throw new NotFoundException(WATCHLIST_NOT_FOUND);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw toDatabaseHttpException(error, 'delete-item');
    }
  }
}
