/**
 * Seeds dummy provider configuration before any e2e spec boots AppModule.
 *
 * ConfigModule validates the environment at startup (validate: validateEnv)
 * and process.env takes precedence over the .env file — so these values keep
 * the e2e suite independent of the developer's real .env. The keys are never
 * used against live providers: the specs that hit /api/market override both
 * HTTP clients with mocks, and the remaining specs never reach a provider.
 */
process.env.FINNHUB_API_KEY = 'e2e-dummy-finnhub-key';
process.env.TWELVE_DATA_API_KEY = 'e2e-dummy-twelve-data-key';
process.env.MARKET_PROVIDER_TIMEOUT_MS = '5000';
// Supabase keys are now required by validateEnv. The app only *constructs* the
// client at boot (no network call), so a dummy URL/key keep the suite
// independent of the developer's real .env. No spec hits live Supabase.
process.env.SUPABASE_URL = 'https://e2e-dummy.supabase.co';
process.env.SUPABASE_ANON_KEY = 'e2e-dummy-supabase-anon-key';
