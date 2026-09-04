-- ============================================================================
-- AlphaPulse database slice 1: profiles, watchlists, watchlist_items
--
-- Forward-only migration. Supabase applies each *.sql under supabase/migrations/
-- once, in filename order, so this deliberately avoids IF NOT EXISTS guards: if
-- an object already exists, the migration should fail loudly rather than hide
-- behind a guard and silently leave the schema half-applied.
--
-- Model
--   profiles        1:1 to auth.users; created automatically on registration.
--   watchlists      user-owned named lists (name is case/space-insensitive unique
--                   per user).
--   watchlist_items symbols owned via their watchlist (uppercase, case-sensitive
--                   unique per watchlist).
--
-- Ownership is enforced entirely by Row Level Security keyed on auth.uid().
-- Clients talk to the API with the anon key + the user's access token, so RLS is
-- the authorization boundary. No anon grants exist on these tables.
-- ============================================================================

-- Ensure deterministic resolution of gen_random_uuid() and friends.
set search_path = public, auth;

-- ============================================================================
-- Tables
-- ============================================================================

create table public.profiles (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null unique references auth.users (id) on delete cascade,
  full_name  text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One profile per user (user_id unique above) and per-user uniqueness for
-- watchlist names. Name comparisons ignore case and surrounding whitespace:
-- "Tech", "tech", and " Tech " are the same watchlist name for one user.
create table public.watchlists (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  name       text not null check (name = btrim(name) and length(btrim(name)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Symbols are stored uppercase and trimmed; an empty symbol is rejected, and
-- duplicate symbols in one watchlist are impossible regardless of how the
-- client spells them.
create table public.watchlist_items (
  id            uuid primary key default gen_random_uuid(),
  watchlist_id  uuid not null references public.watchlists (id) on delete cascade,
  symbol        text not null check (
    symbol = btrim(symbol) and symbol = upper(symbol) and length(symbol) > 0
  ),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ============================================================================
-- Unique constraints / indexes
-- ============================================================================

create unique index uq_watchlists_user_lower_name
  on public.watchlists (user_id, lower(btrim(name)));

create unique index uq_watchlist_items_watchlist_symbol
  on public.watchlist_items (watchlist_id, symbol);

-- Per-user list ordering (newest first) for the future watchlist endpoints.
create index ix_watchlists_user_created
  on public.watchlists (user_id, created_at desc);

-- Cross-watchlist symbol lookups (e.g. "who watches AAPL") once exposed.
create index ix_watchlist_items_symbol
  on public.watchlist_items (symbol);

-- ============================================================================
-- updated_at maintenance (trigger-only functions)
-- ============================================================================

-- Sets updated_at on UPDATE. Trigger-only: EXECUTE is revoked from every role
-- below, yet the triggers still fire because PostgreSQL checks a trigger
-- function's EXECUTE privilege only at CREATE TRIGGER time — never when the
-- trigger runs. SECURITY INVOKER is sufficient: the body touches only NEW/OLD
-- and the built-in now(), so it needs no elevated privileges.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.updated_at = old.updated_at then
    new.updated_at := now();
  end if;
  return new;
end;
$$;

create trigger watchlists_set_updated_at
  before update on public.watchlists
  for each row execute function public.set_updated_at();

create trigger watchlist_items_set_updated_at
  before update on public.watchlist_items
  for each row execute function public.set_updated_at();

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- ============================================================================
-- Automatic profile creation on registration
-- ============================================================================

-- Copies the full name submitted at signup (stored by the API in
-- user_metadata.full_name) into profiles.full_name. SECURITY DEFINER: the body
-- runs as the function owner (postgres), so the profile insert bypasses RLS and
-- the firing role needs no table grant. Trigger-only: invoked by the AFTER
-- INSERT trigger below, never by client code — EXECUTE is revoked from every
-- role at the bottom of this migration.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id, full_name)
  values (new.id, new.raw_user_meta_data ->> 'full_name')
  on conflict (user_id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================================
-- Row Level Security: every user can read/write only their own rows
-- ============================================================================

alter table public.profiles enable row level security;
alter table public.watchlists enable row level security;
alter table public.watchlist_items enable row level security;

-- profiles -------------------------------------------------------------

create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = user_id);

create policy "profiles_update_own"
  on public.profiles for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- No INSERT policy: profiles are created only by the auth.users trigger
-- (public.handle_new_user), never by clients. No DELETE policy either: profiles
-- are removed by cascading on auth.users deletion.

-- watchlists ------------------------------------------------------------

create policy "watchlists_select_own"
  on public.watchlists for select
  using (auth.uid() = user_id);

create policy "watchlists_insert_own"
  on public.watchlists for insert
  with check (auth.uid() = user_id);

create policy "watchlists_update_own"
  on public.watchlists for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "watchlists_delete_own"
  on public.watchlists for delete
  using (auth.uid() = user_id);

-- watchlist_items: ownership is inherited from the parent watchlist ----------

create policy "watchlist_items_select_own"
  on public.watchlist_items for select
  using (
    exists (
      select 1 from public.watchlists w
      where w.id = watchlist_id and w.user_id = auth.uid()
    )
  );

create policy "watchlist_items_insert_own"
  on public.watchlist_items for insert
  with check (
    exists (
      select 1 from public.watchlists w
      where w.id = watchlist_id and w.user_id = auth.uid()
    )
  );

create policy "watchlist_items_update_own"
  on public.watchlist_items for update
  using (
    exists (
      select 1 from public.watchlists w
      where w.id = watchlist_id and w.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.watchlists w
      where w.id = watchlist_id and w.user_id = auth.uid()
    )
  );

create policy "watchlist_items_delete_own"
  on public.watchlist_items for delete
  using (
    exists (
      select 1 from public.watchlists w
      where w.id = watchlist_id and w.user_id = auth.uid()
    )
  );

-- ============================================================================
-- Privileges
--
-- Trigger-only functions are not reachable from the API: EXECUTE is revoked
-- from every role (PUBLIC, anon, authenticated, service_role). This does not
-- stop the triggers — PostgreSQL checks a trigger function's EXECUTE privilege
-- only when the trigger is created, never at firing time. handle_new_user()
-- still inserts the profile because it is SECURITY DEFINER and runs as its
-- owner (postgres), bypassing RLS.
--
-- Tables are granted to the authenticated role only, and only for the
-- operations the RLS policies permit. Profiles have no INSERT grant: they are
-- created solely by the auth.users trigger and removed by ON DELETE CASCADE.
-- The anon key alone reads/writes nothing here — RLS or not — so user data is
-- unreachable without a user access token. service_role keeps full access
-- (already granted by default) for future server-side admin operations;
-- AlphaPulse never ships that key.
--
-- UUID primary keys come from gen_random_uuid(), so these tables have no
-- sequences and nothing further to grant.
-- ============================================================================

revoke execute on function public.handle_new_user() from public, anon, authenticated, service_role;
revoke execute on function public.set_updated_at() from public, anon, authenticated, service_role;

grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.watchlists to authenticated;
grant select, insert, update, delete on public.watchlist_items to authenticated;
