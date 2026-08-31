/**
 * Startup validation for the environment AlphaPulse runs under.
 *
 * Wired into ConfigModule.forRoot({ validate: validateEnv }) so a missing API
 * key or a malformed value fails the bootstrap *before* the app listens —
 * instead of surfacing later as a confusing 500 (or being silently ignored).
 *
 * @nestjs/config calls this after .env has been loaded (with process.env
 * taking precedence), and re-throws whatever this throws, so the process
 * exits non-zero on invalid configuration.
 */

/** Config values passed to ConfigModule.forRoot's `validate` option are always strings (from .env / process.env). */
export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const errors: string[] = [];

  // API keys are useless empty; fail fast rather than emit 401s at request time.
  requireNonEmpty(config, errors, 'FINNHUB_API_KEY');
  requireNonEmpty(config, errors, 'TWELVE_DATA_API_KEY');

  if (config['MARKET_PROVIDER_TIMEOUT_MS'] !== undefined && !isPositiveInt(config['MARKET_PROVIDER_TIMEOUT_MS'])) {
    errors.push('MARKET_PROVIDER_TIMEOUT_MS must be a positive integer (ms)');
  }

  if (config['PORT'] !== undefined && !isPort(config['PORT'])) {
    errors.push('PORT must be an integer between 1 and 65535');
  }

  for (const key of ['FINNHUB_BASE_URL', 'TWELVE_DATA_BASE_URL']) {
    if (config[key] !== undefined && !isHttpUrl(config[key])) {
      errors.push(`${key} must be a valid http(s) URL`);
    }
  }

  if (config['DEFAULT_SYMBOLS'] !== undefined && !isSymbolList(config['DEFAULT_SYMBOLS'])) {
    errors.push('DEFAULT_SYMBOLS must be a comma-separated list of symbols');
  }

  if (errors.length > 0) {
    throw new Error(`Invalid environment configuration:\n- ${errors.join('\n- ')}`);
  }

  return config;
}

function requireNonEmpty(
  config: Record<string, unknown>,
  errors: string[],
  key: string,
): void {
  const value = config[key];
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${key} must be a non-empty string`);
  }
}

function isPositiveInt(value: unknown): boolean {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(num) && num > 0;
}

function isPort(value: unknown): boolean {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(num) && num >= 1 && num <= 65535;
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isSymbolList(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return value.split(',').map((s) => s.trim()).filter(Boolean).length > 0;
}
