/**
 * Raw PostgREST row shapes for the watchlists schema (snake_case wire format).
 * The service maps these onto the camelCase DTOs before they reach a response.
 */
export interface WatchlistRow {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface WatchlistItemRow {
  id: string;
  watchlist_id: string;
  symbol: string;
  created_at: string;
  updated_at: string;
}
