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
