-- ============================================================================
-- AlphaPulse database slice 3: portfolios, holdings
--
-- Forward-only migration. Supabase applies each *.sql under supabase/migrations/
-- once, in filename order, so this deliberately avoids IF NOT EXISTS guards: if
-- an object already exists, the migration should fail loudly rather than hide
-- behind a guard and silently leave the schema half-applied.
--
-- Model
--   portfolios  user-owned named trackers; users record a portfolio name.
--   holdings    a position inside one portfolio: symbol + quantity + average
--               purchase price, one row per symbol per portfolio.
--
-- This is portfolio TRACKING, not a trading simulator. The database stores only
-- what the user records manually. Current prices, cost basis, profit/loss,
-- percentage return, and portfolio totals are calculated values: they are
-- computed at request time by the API from live market data and are
-- deliberately NOT stored here. All current valuations are in USD; there is no
-- currency column.
--
-- average_purchase_price is the average cost PER SHARE in USD (not total cost):
-- cost basis = quantity x average_purchase_price is derived later by the API.
-- Both quantities and per-share prices are exact numeric(18, 6) values so money
-- math never passes through binary float rounding.
--
-- Ownership is enforced entirely by Row Level Security keyed on auth.uid().
-- holdings carry no user_id column; ownership is inherited from the parent
-- portfolio via an EXISTS subquery. Clients talk to the API with the anon key +
-- the user's access token, so RLS is the authorization boundary, and the tables
-- are additionally revoked from anon/public and granted to authenticated only.
-- ============================================================================

-- Ensure deterministic resolution of gen_random_uuid() and friends.
set search_path = public, auth;

-- ============================================================================
-- Tables
-- ============================================================================

-- Portfolio names are unique per user ignoring case and surrounding whitespace:
-- "Tech", "tech", and " Tech " are the same portfolio name for one user. The
-- CHECK forbids STORING untrimmed or empty names; the expression unique index
-- below makes comparisons case-insensitive. A user's portfolios are removed
-- with their auth.users row (cascade).
create table public.portfolios (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  name       text not null check (name = btrim(name) and length(btrim(name)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.holdings (
  id                     uuid primary key default gen_random_uuid(),
  portfolio_id           uuid not null references public.portfolios (id) on delete cascade,
  symbol                 text not null check (
    symbol = btrim(symbol) and symbol = upper(symbol) and length(symbol) > 0
  ),
  quantity               numeric(18, 6) not null check (quantity > 0),
  average_purchase_price numeric(18, 6) not null check (average_purchase_price > 0),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- Precision rationale:
--   numeric(18, 6) stores up to 18 significant digits, 6 after the decimal
--   point (12 integer digits). quantity therefore supports fractional shares
--   down to 0.000001 and up to 999,999,999,999.999999; average_purchase_price
--   supports sub-cent per-share prices up to the same magnitude. Postgres
--   numeric is exact fixed-point (never real/double precision), so a value like
--   152.3755 for a weighted average across fills is preserved exactly, and the
--   API can later compute cost basis = quantity x average_purchase_price with
--   no float error. Values above zero are required; zero and negatives are
--   rejected by the CHECKs.

-- ============================================================================
-- Unique constraints / indexes
-- ============================================================================

create unique index uq_portfolios_user_lower_name
  on public.portfolios (user_id, lower(btrim(name)));

-- Per-user portfolio ordering (newest first) for the future endpoints.
create index ix_portfolios_user_created
  on public.portfolios (user_id, created_at desc);

-- One holding per symbol per portfolio. Symbols are stored uppercase and
-- trimmed by the CHECK above, so the plain unique index also prevents a second
-- row for the same symbol regardless of how a client spells it. Its leading
-- (portfolio_id) column doubles as the foreign-key index that the ON DELETE
-- CASCADE from portfolios needs, so no separate portfolio_id index is added.
create unique index uq_holdings_portfolio_symbol
  on public.holdings (portfolio_id, symbol);

-- No symbol-only index: no query reads holdings by bare symbol yet; adding one
-- now would be speculative.

-- ============================================================================
-- updated_at maintenance (reusing public.set_updated_at from slice 1)
-- ============================================================================

-- set_updated_at() already exists (created in the profiles/watchlists
-- migration) and is NOT recreated here. Its EXECUTE was revoked from every role
-- there, yet these triggers still fire because PostgreSQL checks a trigger
-- function's EXECUTE privilege only at CREATE TRIGGER time — never when the
-- trigger runs — so no function grant is added here either.
create trigger portfolios_set_updated_at
  before update on public.portfolios
  for each row execute function public.set_updated_at();

create trigger holdings_set_updated_at
  before update on public.holdings
  for each row execute function public.set_updated_at();

-- ============================================================================
-- Row Level Security: every user can read/write only their own rows
-- ============================================================================

alter table public.portfolios enable row level security;
alter table public.holdings enable row level security;

-- portfolios -------------------------------------------------------------

create policy "portfolios_select_own"
  on public.portfolios for select
  using (auth.uid() = user_id);

create policy "portfolios_insert_own"
  on public.portfolios for insert
  with check (auth.uid() = user_id);

create policy "portfolios_update_own"
  on public.portfolios for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "portfolios_delete_own"
  on public.portfolios for delete
  using (auth.uid() = user_id);

-- The INSERT/UPDATE WITH CHECK means a user can never create a portfolio for, or
-- reassign one to, another user_id — ownership always comes from auth.uid().

-- holdings: ownership is inherited from the parent portfolio ------------------

-- A holding is visible or writable only when its portfolio belongs to the
-- caller. The UPDATE policy applies USING to the row being changed (its current
-- portfolio must be owned) AND WITH CHECK to the new row (its NEW portfolio_id
-- must still be owned) — so a holding can never be moved into another user's
-- portfolio, only among the caller's own portfolios.
create policy "holdings_select_own"
  on public.holdings for select
  using (
    exists (
      select 1 from public.portfolios p
      where p.id = portfolio_id and p.user_id = auth.uid()
    )
  );

create policy "holdings_insert_own"
  on public.holdings for insert
  with check (
    exists (
      select 1 from public.portfolios p
      where p.id = portfolio_id and p.user_id = auth.uid()
    )
  );

create policy "holdings_update_own"
  on public.holdings for update
  using (
    exists (
      select 1 from public.portfolios p
      where p.id = portfolio_id and p.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.portfolios p
      where p.id = portfolio_id and p.user_id = auth.uid()
    )
  );

create policy "holdings_delete_own"
  on public.holdings for delete
  using (
    exists (
      select 1 from public.portfolios p
      where p.id = portfolio_id and p.user_id = auth.uid()
    )
  );

-- ============================================================================
-- Privileges
--
-- An explicit ACL at the table level: revoke anon/public outright, then grant
-- authenticated exactly the operations the policies permit. This matters even
-- though RLS is the real boundary, because some database roles (the SQL Editor,
-- a future server-side operator) bypass RLS entirely — privileges are the
-- remaining line of defence there, and the anon key must hold none.
--
-- service_role is untouched: it keeps whatever Supabase granted by default and
-- AlphaPulse never ships that key. No sequence grants exist (UUID primary keys
-- come from gen_random_uuid()) and no function EXECUTE grants are added
-- (set_updated_at is trigger-only, see above).
-- ============================================================================

revoke all on table public.portfolios, public.holdings from anon, public;

grant select, insert, update, delete on public.portfolios to authenticated;
grant select, insert, update, delete on public.holdings to authenticated;
