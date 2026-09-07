# AlphaPulse API

NestJS backend for AlphaPulse — a stock-market signal engine. It authenticates
users with Supabase Auth, serves market data (quotes/indicators) from Finnhub
and Twelve Data, and backs user profiles, watchlists, and portfolio holdings
with a Supabase Postgres database protected by Row Level Security.

**Status of this slice:** profiles, watchlists, and watchlist items exist in the
database with full RLS, and the API exposes authenticated watchlist endpoints
(create, list, rename, delete, add/remove symbols) alongside auth and
market-data endpoints. The `portfolios` and `holdings` tables are in the database
too, and their endpoints are now live: portfolio and holding CRUD plus a
read-only, request-time **valuation** (positions are still recorded manually, and
prices and performance are computed on demand — see
[Portfolio tracking](#portfolio-tracking)). An authenticated Socket.IO gateway
delivers that same valuation live per subscription — see
[Live portfolio valuation](#live-portfolio-valuation-socketio).

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
   `supabase/migrations/20260904000000_create_profiles_watchlists.sql` and run
   it — skip this step if it is already applied, because the migration is
   non-idempotent and will fail loudly on a second run.
4. In a new query, paste the entire contents of
   `supabase/migrations/20260904000001_create_portfolios_holdings.sql` and run
   it. Verify there are no errors in the output console.

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

### Inspecting the applied schema

The SQL Editor runs with an elevated database role that **bypasses Row Level
Security**, so it can prove structure but never RLS isolation. To inspect
columns, types, checks, indexes, triggers, policies, and grants, use the
dashboard's **Table Editor** and **Database → Tables / Database → Policies**
views, or query `information_schema` / `pg_catalog`. Real ownership isolation
(user A cannot reach user B's data) is exercised through the API with actual
user access tokens, not from the SQL Editor.

## RLS ownership model

Every table below is user-scoped. Row Level Security is enabled on all of them,
and `anon` has no access to any of them: the `portfolios` and `holdings` tables
are explicitly revoked from `anon`/`public`, and every table's policies require
a real `auth.uid()`. The anon key alone reads and writes nothing; all access
requires a user access token (see [Authenticated endpoints](#authenticated-endpoints)).

| Table                    | Ownership policy                                                                                                                                                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `public.profiles`        | One row per `auth.users` id, created automatically by a trigger on registration. Users can `select` / `update` only their own row (policies `auth.uid() = user_id`). No `delete` policy — the row is removed by `ON DELETE CASCADE` when the auth user is deleted.                                                       |
| `public.watchlists`      | Users can `select` / `insert` / `update` / `delete` only their own lists (`auth.uid() = user_id`). Names are case- and whitespace-insensitive unique per user, so `Tech`, `tech`, and `Tech` are the same list.                                                                                                          |
| `public.watchlist_items` | Ownership is inherited from the parent watchlist via an `EXISTS` subquery (`watchlists.user_id = auth.uid()`). Symbols are stored uppercase/trimmed and unique per watchlist.                                                                                                                                            |
| `public.portfolios`      | Users can `select` / `insert` / `update` / `delete` only their own portfolios (`auth.uid() = user_id`). Names are case- and whitespace-insensitive unique per user. The `UPDATE … WITH CHECK` prevents reassigning a portfolio to another `user_id`.                                                                     |
| `public.holdings`        | Ownership is inherited from the parent portfolio via an `EXISTS` subquery (`portfolios.user_id = auth.uid()`). The `UPDATE … WITH CHECK` also prevents moving a holding into another user's portfolio. One row per symbol per portfolio; quantity and average purchase price are exact positive `numeric(18, 6)` values. |

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

## Portfolio tracking

Users track their own positions by hand. The database stores only what they
record:

- a portfolio `name`, owned by one user;
- for each holding inside it, the `symbol`, the `quantity` owned, and the
  `average_purchase_price` — the average cost **per share**.

Holdings belong to a portfolio, and a portfolio belongs to a user; nothing else
about a position is persisted.

All current valuations are **USD**; there is no currency conversion yet.

Market prices, cost basis, profit/loss, percentage return, and portfolio totals
are **calculated values**. They are computed at request time from live market
data and are **never stored** — the schema has no columns for current price or
performance. `GET /api/portfolios/:id/valuation` computes them, read-only: it
never writes to the database, makes **no** market calls for an empty portfolio,
and fetches quotes for multiple holdings with bounded concurrency. If any
holding cannot be valued the whole request fails with `422` (a symbol with no
market data) or the provider's own error.

### Exact-decimal response contract

Every financial decimal in a portfolio response is a **JSON string**, never a JS
number, so no value ever round-trips through a binary float on the wire:

- `quantity` and `averagePurchasePrice` echo the stored `numeric(18,6)` cells as
  **canonical** strings with no trailing zeros (e.g. `"12.5"`, `"152.3755"`).
- `currentPrice` is the **exact provider price**, echoed back as a canonical
  string with no trailing zeros and **never rounded** (e.g. `"182.7465"`), so
  `quantity × currentPrice` reproduces the calculated `currentValue` exactly.
- Calculated money fields (`investedValue`, `currentValue`, `profitLoss`, and the
  `total*` aggregates) are rounded to **two decimal places** only when the
  response is serialized (e.g. `"2284.33"`), from exact decimal arithmetic.
- `returnPercentage` / `totalReturnPercentage` are percentages rounded to two
  decimal places (e.g. `"19.93"`).
- Valuation totals are the exact sum of the exact per-holding values, rounded
  once — not the sum of the already-rounded rows — so a total may differ from
  naively adding the rounded rows by a cent; the totals are authoritative.

Request bodies for this slice still send JSON **numbers** for `quantity` and
`averagePurchasePrice`, within a documented double-safe realistic range (at most
12 integer digits and 6 decimal places, greater than zero, finite). They are
validated and canonicalized to exact decimal strings immediately after
validation and before they are sent to Supabase, so `numeric(18,6)` never
receives a binary float. `null`, `NaN`, `Infinity`, zero, negatives, over-large
magnitudes, and more than six decimal places are all rejected with `400`.

## Live portfolio valuation (Socket.IO)

An authenticated Socket.IO gateway (`RealtimeModule`) runs on the same HTTP
server and port as the REST API. In this slice it serves one thing: when a
socket subscribes to a portfolio it owns, the server values it through the exact
same read-only path as `GET /api/portfolios/:id/valuation` and pushes **one**
`portfolio:valuation` event to that socket. There is no recurring polling yet —
later slices will add live updates on a schedule.

### Connecting and authenticating

Connect to the root namespace and pass the Supabase access token in the
handshake `auth` object. Do **not** send the token as an emitted payload.

```js
import { io } from 'socket.io-client';

const socket = io('https://your-api.example.com', {
  auth: { token: '<access_token>' }, // verified by AuthService before connecting
  transports: ['websocket'],
});
```

A missing or invalid token rejects the connection _before_ it is established:
the client receives `connect_error` with a neutral message and a single error
code, and the database is never touched.

```json
{ "message": "Authentication failed.", "data": { "code": "UNAUTHORIZED" } }
```

### Events

| Direction       | Event                   | Payload                                 | Reply (ack)                 |
| --------------- | ----------------------- | --------------------------------------- | --------------------------- |
| client → server | `portfolio:subscribe`   | `{ portfolioId: "<uuid>" }`             | see below                   |
| client → server | `portfolio:unsubscribe` | `{ portfolioId: "<uuid>" }`             | `{ ok: true, portfolioId }` |
| server → client | `portfolio:valuation`   | `{ portfolioId, emittedAt, valuation }` | —                           |
| server → client | `portfolio:error`       | `{ code, message }`                     | —                           |

Subscribe, then wait for the initial valuation:

```js
socket.emit('portfolio:subscribe', { portfolioId }, (ack) => {
  console.log(ack); // { ok: true, portfolioId, subscribed: true }
});

socket.on('portfolio:valuation', ({ portfolioId, emittedAt, valuation }) => {
  console.log(valuation); // identical to the REST valuation response
});
```

`ack` shapes for `portfolio:subscribe`:

- `{ ok: true, portfolioId, subscribed: true }` — newly subscribed; a
  `portfolio:valuation` follows.
- `{ ok: true, portfolioId, subscribed: false }` — already subscribed (idempotent
  duplicate); no second valuation is sent.
- `{ ok: false, error: { code, message } }` — see error codes below.

Both `portfolio:subscribe` and `portfolio:unsubscribe` are idempotent.
Unsubscribing from a portfolio the socket was never subscribed to still
acknowledges `{ ok: true, portfolioId }` and reveals nothing. Disconnecting a
socket automatically removes all of its subscriptions and room memberships.

### Error codes

Errors are returned on the subscribe/unsubscribe **acknowledgement** (or as a
`connect_error` for `UNAUTHORIZED`), never on `portfolio:error` — which is a
typed, post-connection error channel reserved for server-pushed problems.
Messages are neutral and never expose Supabase, Finnhub, or provider internals.

| Code                  | Meaning                                                                          |
| --------------------- | -------------------------------------------------------------------------------- |
| `UNAUTHORIZED`        | Connection refused during the handshake (missing/invalid token).                 |
| `VALIDATION_ERROR`    | `portfolioId` is missing or not a UUID.                                          |
| `PORTFOLIO_NOT_FOUND` | The portfolio does not exist or belongs to another user (identical, so no leak). |
| `MARKET_UNAVAILABLE`  | The initial valuation failed on the market/provider side — retry later.          |
| `INTERNAL_ERROR`      | An unexpected server error.                                                      |

The `valuation` payload is the exact `PortfolioValuationDto` from the REST
contract — every financial decimal is a string and the figures match
`GET /api/portfolios/:id/valuation` byte-for-byte (see
[Exact-decimal response contract](#exact-decimal-response-contract)). No user id
is ever accepted from a payload: ownership is always derived from the verified
token, and each subscription is authorized through the same ownership check as
the REST route. Like the HTTP API, the gateway enables **no CORS** — the socket
serves same-origin and non-browser clients only.

## Authenticated endpoints

Every endpoint below requires the same header:

```
Authorization: Bearer <access_token>
```

Ownership is always derived from the verified token — the API never accepts a
`user_id` from request bodies or route parameters — and Row Level Security is
the final boundary. A resource that does not exist and one that belongs to
another user are both reported as `404`, so the API reveals nothing about other
users' data.

### Watchlists

All routes are under the `watchlists` prefix and return camelCase JSON. Names
are trimmed before storage; symbols are trimmed and uppercased (e.g. `aapl` →
`AAPL`).

| Method   | Path                                | Body         | Description                                       |
| -------- | ----------------------------------- | ------------ | ------------------------------------------------- |
| `POST`   | `/api/watchlists`                   | `{ name }`   | Create a watchlist (`201`)                        |
| `GET`    | `/api/watchlists`                   | —            | List the user's watchlists with their items       |
| `PATCH`  | `/api/watchlists/:id`               | `{ name }`   | Rename a watchlist                                |
| `DELETE` | `/api/watchlists/:id`               | —            | Delete a watchlist and its items (`204`, no body) |
| `POST`   | `/api/watchlists/:id/items`         | `{ symbol }` | Add a symbol to a watchlist (`201`)               |
| `DELETE` | `/api/watchlists/:id/items/:symbol` | —            | Remove a symbol from a watchlist (`204`, no body) |

Example — create a watchlist and add a symbol:

```
POST /api/watchlists
Authorization: Bearer <access_token>

{ "name": "Tech Stocks" }
```

```
POST /api/watchlists/9f1c2c20-1a2b-4c3d-8e4f-5a6b7c8d9e0f/items
Authorization: Bearer <access_token>

{ "symbol": "aapl" }
```

Status codes:

- `201` — created (returns the created watchlist / item)
- `200` — listed or renamed
- `204` — deleted (no response body)
- `400` — invalid name, symbol, or `:id` (must be a UUID)
- `401` — missing/invalid bearer token
- `404` — watchlist or item not found (or inaccessible)
- `409` — duplicate watchlist name / duplicate symbol in the same watchlist

### Portfolios

All routes are under the `portfolios` prefix and return camelCase JSON. Names
are trimmed before storage; symbols are trimmed and uppercased. Financial
decimal fields in every response are strings (see
[Exact-decimal response contract](#exact-decimal-response-contract)).

| Method   | Path                                   | Body                                         | Description                                          |
| -------- | -------------------------------------- | -------------------------------------------- | ---------------------------------------------------- |
| `POST`   | `/api/portfolios`                      | `{ name }`                                   | Create a portfolio (`201`)                           |
| `GET`    | `/api/portfolios`                      | —                                            | List the user's portfolios                           |
| `GET`    | `/api/portfolios/:id`                  | —                                            | Get a portfolio with its holdings                    |
| `PATCH`  | `/api/portfolios/:id`                  | `{ name }`                                   | Rename a portfolio                                   |
| `DELETE` | `/api/portfolios/:id`                  | —                                            | Delete a portfolio and its holdings (`204`, no body) |
| `POST`   | `/api/portfolios/:id/holdings`         | `{ symbol, quantity, averagePurchasePrice }` | Add a holding (`201`)                                |
| `PATCH`  | `/api/portfolios/:id/holdings/:symbol` | `{ quantity?, averagePurchasePrice? }`       | Update a holding (at least one field required)       |
| `DELETE` | `/api/portfolios/:id/holdings/:symbol` | —                                            | Remove a holding (`204`, no body)                    |
| `GET`    | `/api/portfolios/:id/valuation`        | —                                            | Live valuation of the portfolio (read-only)          |

Example — create a portfolio, add a holding, and value it:

```
POST /api/portfolios
Authorization: Bearer <access_token>

{ "name": "Tech Holdings" }
```

```
POST /api/portfolios/9f1c2c20-1a2b-4c3d-8e4f-5a6b7c8d9e0f/holdings
Authorization: Bearer <access_token>

{ "symbol": "aapl", "quantity": 12.5, "averagePurchasePrice": 152.3755 }
```

```
GET /api/portfolios/9f1c2c20-1a2b-4c3d-8e4f-5a6b7c8d9e0f/valuation
Authorization: Bearer <access_token>
```

A valuation response looks like:

```json
{
  "portfolioId": "9f1c2c20-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
  "totalInvestedValue": "1904.69",
  "totalCurrentValue": "2284.33",
  "totalProfitLoss": "379.64",
  "totalReturnPercentage": "19.93",
  "holdings": [
    {
      "symbol": "AAPL",
      "quantity": "12.5",
      "averagePurchasePrice": "152.3755",
      "currentPrice": "182.7465",
      "investedValue": "1904.69",
      "currentValue": "2284.33",
      "profitLoss": "379.64",
      "returnPercentage": "19.93"
    }
  ]
}
```

Note the two forms: `currentPrice` is the exact provider value (`"182.7465"`, not
rounded to cents) — `12.5 × 182.7465 = "2284.33"` — while `currentValue`,
`investedValue`, `profitLoss`, and the totals are calculated outputs rounded to
two decimal places.

Status codes:

- `201` — created (returns the created portfolio / holding)
- `200` — listed, fetched, renamed, updated, or valued
- `204` — deleted (no response body)
- `400` — invalid name, symbol, `quantity`/`averagePurchasePrice`, empty holding
  patch body, or malformed `:id` (must be a UUID)
- `401` — missing/invalid bearer token
- `404` — portfolio or holding not found (or inaccessible)
- `409` — duplicate portfolio name / duplicate symbol in the same portfolio
- `422` — a held symbol has no market data, so the portfolio cannot be valued

> **Verifying RLS ownership.** The automated e2e tests mock Supabase, so their
> `404`s verify only the API's _neutral_ contract, not live isolation. To verify
> ownership end to end, register two real users. With user B's token, create a
> portfolio and add a holding to it. Then, with user A's token, confirm that A
> cannot reach B's data — `GET /api/portfolios/:id` (which returns the
> portfolio's holdings), `PATCH`/`DELETE /api/portfolios/:id`, the holding
> routes, and `GET /api/portfolios/:id/valuation` must each return `404`,
> identical to a missing resource — and that `GET /api/portfolios` never
> includes B's rows.

### Current user

The endpoint that returns the current user from a bearer token:

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
