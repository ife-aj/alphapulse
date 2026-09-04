# AlphaPulse API

NestJS backend for AlphaPulse — a stock-market signal engine. It authenticates
users with Supabase Auth, serves market data (quotes/indicators) from Finnhub
and Twelve Data, and backs user profiles and watchlists with a Supabase
Postgres database protected by Row Level Security.

**Status of this slice:** profiles, watchlists, and watchlist items exist in the
database with full RLS. The NestJS watchlist endpoints come in a later slice —
for now the API exposes auth and market-data endpoints only.

## Architecture

- **Runtime** — NestJS 11 with a global `/api` prefix. Interactive Swagger docs
  at `GET /api/docs`.
- **Config** — `@nestjs/config` with a startup validator
  (`src/config/env.validation.ts`): a missing or malformed required variable
  fails the bootstrap instead of surfacing later as a confusing 500.
- **Auth** — Supabase Auth (`@supabase/supabase-js`). Register stores the user's
  full name as `user_metadata.full_name`; a trigger then copies it into
  `profiles.full_name`. Email confirmation is enabled, so a fresh registration
  returns a neutral `{ user: null, session: null }` and a login is required to
  obtain a session.
- **Database** — Supabase Postgres. User-owned tables are protected by Row
  Level Security (see [RLS ownership model](#rls-ownership-model)); the API
  talks to them with the **anon key plus the user's access token** and never
  uses the secret `service_role` key.

## Prerequisites

- Node.js 20+ and npm
- A [Supabase](https://supabase.com) project (free tier is fine) — for auth,
  Postgres, and RLS
- API keys for Finnhub and Twelve Data (both have free tiers)

## Setup

```bash
npm install
cp .env.example .env   # then fill in your keys (see below)
```

The app fails fast at startup if required variables are missing or malformed —
there is no silent misconfiguration.

### Environment variables

| Variable                     | Required | Description                                                                               |
| ---------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| `PORT`                       | optional | HTTP port (default 3000)                                                                  |
| `FINNHUB_API_KEY`            | yes      | Market-data provider key                                                                  |
| `FINNHUB_BASE_URL`           | optional | Defaults to `https://finnhub.io/api/v1`                                                   |
| `TWELVE_DATA_API_KEY`        | yes      | Historical-daily-candles provider key                                                     |
| `TWELVE_DATA_BASE_URL`       | optional | Defaults to `https://api.twelvedata.com`                                                  |
| `MARKET_PROVIDER_TIMEOUT_MS` | optional | Outbound provider timeout (default 5000)                                                  |
| `DEFAULT_SYMBOLS`            | optional | Symbols for `GET /api/market/quotes` when none are given                                  |
| `SUPABASE_URL`               | yes      | Supabase project URL (Project Settings > API)                                             |
| `SUPABASE_ANON_KEY`          | yes      | Supabase **anon/publishable** key — designed to be public, requests stay sandboxed by RLS |

Never put the secret `service_role` key in `.env` or anywhere client-side. The
project URL and anon key are not secrets; the values in `.env.example` are
placeholders — replace them with your own project's values.

## Available commands

| Command             | Description                                         |
| ------------------- | --------------------------------------------------- |
| `npm run start`     | Start the server                                    |
| `npm run start:dev` | Start in watch mode                                 |
| `npm run build`     | Compile to `dist/`                                  |
| `npm test`          | Unit tests (Jest)                                   |
| `npm run test:e2e`  | End-to-end tests (mock Supabase — no live services) |
| `npm run format`    | Prettier over `src/` and `test/`                    |
| `npm run lint`      | ESLint with `--fix`                                 |

## Applying the database migration

The schema lives in `supabase/migrations/` as normal SQL. Apply it once against
your Supabase project.

### Option A — Supabase SQL editor

1. Open your project in the [Supabase dashboard](https://supabase.com/dashboard).
2. Go to **SQL Editor** and create a new query.
3. Paste the entire contents of
   `supabase/migrations/20260904000000_create_profiles_watchlists.sql`.
4. Run it. Verify there are no errors in the output console.

### Option B — Supabase CLI

```bash
npx supabase init        # one-time: creates supabase/config.toml
npx supabase link --project-ref <your-project-ref>
npx supabase db push
```

`supabase db push` applies any migration files in `supabase/migrations/` that
your remote database has not seen yet.

The migration is **forward-only and intentionally non-idempotent**: if an object
already exists it fails loudly rather than silently skipping. If you have
already created these objects by hand, drop them first or start from a fresh
project.

## RLS ownership model

Every table below is user-scoped. Row Level Security is enabled on all of them,
and **no `anon` grants exist** on these tables, so the anon key alone reads and
writes nothing. All access requires a user access token (see
[Authenticated endpoint](#authenticated-endpoint)).

| Table                    | Ownership policy                                                                                                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `public.profiles`        | One row per `auth.users` id, created automatically by a trigger on registration. Users can `select` / `update` only their own row (policies `auth.uid() = user_id`). No `delete` policy — the row is removed by `ON DELETE CASCADE` when the auth user is deleted. |
| `public.watchlists`      | Users can `select` / `insert` / `update` / `delete` only their own lists (`auth.uid() = user_id`). Names are case- and whitespace-insensitive unique per user, so `Tech`, `tech`, and `Tech` are the same list.                                                    |
| `public.watchlist_items` | Ownership is inherited from the parent watchlist via an `EXISTS` subquery (`watchlists.user_id = auth.uid()`). Symbols are stored uppercase/trimmed and unique per watchlist.                                                                                      |

Profile creation trigger: `public.handle_new_user()` fires on `auth.users`
inserts and copies `raw_user_meta_data ->> 'full_name'` into
`profiles.full_name`. Both trigger functions (`handle_new_user`,
`set_updated_at`) are trigger-only — `EXECUTE` is revoked from `PUBLIC` and
granted only to the roles that need it, so they cannot be invoked through the
API.

Because requests go through the anon key **plus the user's JWT**, the RLS
policies keyed on `auth.uid()` are the authorization boundary. The server keeps
a per-user Supabase client whose `Authorization` header carries the caller's
access token.

## Authenticated endpoint

The only endpoint that returns the current user from a bearer token:

```
GET /api/auth/me
Authorization: Bearer <access_token>
```

It returns the verified user (`id`, `email`, `emailConfirmed`, `fullName`,
`createdAt`). `fullName` comes from `user_metadata.full_name` and is `null` for
accounts created before full names were collected.

Other auth endpoints:

- `POST /api/auth/register` — `{ email, password, fullName }`. With email
  confirmation enabled, the response is a neutral `{ user: null, session: null }`
  (treat it as "confirmation email sent"). A `409 Conflict` is returned only
  when Supabase explicitly reports the email as already registered.
- `POST /api/auth/login` — `{ email, password }` → user + session.

There is **no logout endpoint**. Clients discard their access and refresh
tokens locally when done.
