# Render deployment

Create a Node web service linked to this repository.

- Build command: `npm ci && npm run build`
- Start command: `npm run start:prod`
- Health check: `/api/health`
- Node version: 24 (declared in `.node-version`)
- Start with one service instance: realtime subscriptions are stored in memory.

Set these environment variables in Render using your existing local values:
`FINNHUB_API_KEY`, `TWELVE_DATA_API_KEY`, `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
Set `NODE_ENV=production` and `REALTIME_REFRESH_INTERVAL_MS=60000`.
Render supplies `PORT`.

After Netlify gives you the frontend URL, set `CORS_ORIGINS` to that exact
origin, such as `https://your-site.netlify.app`, with no trailing slash.
Additional origins may be comma-separated. Never use a wildcard.
Keep all API keys on Render, never in frontend environment variables.

Verify `/api/health` and then test authentication and portfolio realtime updates
from the deployed frontend. Ensure your Supabase project is active and your
existing migrations have been applied. If using email confirmation, check its
Site URL and redirect URLs against the deployed frontend.
