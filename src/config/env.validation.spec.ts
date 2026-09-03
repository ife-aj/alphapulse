import { validateEnv } from './env.validation';

/** A config that satisfies every rule; individual tests break one field at a time. */
const validConfig: Record<string, unknown> = {
  FINNHUB_API_KEY: 'finnhub-key',
  TWELVE_DATA_API_KEY: 'twelve-data-key',
  PORT: '3000',
  MARKET_PROVIDER_TIMEOUT_MS: '5000',
  FINNHUB_BASE_URL: 'https://finnhub.io/api/v1',
  TWELVE_DATA_BASE_URL: 'https://api.twelvedata.com',
  SUPABASE_URL: 'https://abcdefghijk.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.dummy-signature',
  DEFAULT_SYMBOLS: 'AAPL,MSFT,NVDA',
};

describe('validateEnv', () => {
  it('accepts a complete, valid configuration', () => {
    expect(() => validateEnv(validConfig)).not.toThrow();
  });

  it('returns the configuration unchanged when valid', () => {
    expect(validateEnv(validConfig)).toEqual(validConfig);
  });

  it('accepts the required keys without any optional variable', () => {
    const minimal: Record<string, unknown> = {
      FINNHUB_API_KEY: 'finnhub-key',
      TWELVE_DATA_API_KEY: 'twelve-data-key',
      SUPABASE_URL: 'https://abcdefghijk.supabase.co',
      SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.dummy-signature',
    };
    expect(() => validateEnv(minimal)).not.toThrow();
  });

  it('throws when FINNHUB_API_KEY is missing', () => {
    const broken = { ...validConfig };
    delete broken.FINNHUB_API_KEY;
    expect(() => validateEnv(broken)).toThrow(/FINNHUB_API_KEY/);
  });

  it('throws when TWELVE_DATA_API_KEY is blank or whitespace-only', () => {
    expect(() =>
      validateEnv({ ...validConfig, TWELVE_DATA_API_KEY: '   ' }),
    ).toThrow(/TWELVE_DATA_API_KEY/);
  });

  it('throws when SUPABASE_URL is missing', () => {
    const broken = { ...validConfig };
    delete broken.SUPABASE_URL;
    expect(() => validateEnv(broken)).toThrow(/SUPABASE_URL/);
  });

  it.each(['not-a-url', 'ftp://supabase.co', '', '   '])(
    'throws when SUPABASE_URL is %s (not an http(s) URL)',
    (value) => {
      expect(() =>
        validateEnv({ ...validConfig, SUPABASE_URL: value }),
      ).toThrow(/SUPABASE_URL/);
    },
  );

  it('throws when SUPABASE_ANON_KEY is blank or whitespace-only', () => {
    expect(() =>
      validateEnv({ ...validConfig, SUPABASE_ANON_KEY: '   ' }),
    ).toThrow(/SUPABASE_ANON_KEY/);
  });

  it.each(['abc', '-5', '0', '5.5'])(
    'throws when MARKET_PROVIDER_TIMEOUT_MS is %s (not a positive integer)',
    (value) => {
      expect(() =>
        validateEnv({ ...validConfig, MARKET_PROVIDER_TIMEOUT_MS: value }),
      ).toThrow(/MARKET_PROVIDER_TIMEOUT_MS/);
    },
  );

  it.each(['abc', '0', '70000', '-1'])(
    'throws when PORT is %s (not an integer in 1-65535)',
    (value) => {
      expect(() => validateEnv({ ...validConfig, PORT: value })).toThrow(
        /PORT/,
      );
    },
  );

  it.each(['not-a-url', 'ftp://finnhub.io', ''])(
    'throws when a provider base URL is %s (not an http(s) URL)',
    (value) => {
      expect(() =>
        validateEnv({ ...validConfig, FINNHUB_BASE_URL: value }),
      ).toThrow(/FINNHUB_BASE_URL/);
    },
  );

  it('throws when DEFAULT_SYMBOLS contains no symbols', () => {
    expect(() =>
      validateEnv({ ...validConfig, DEFAULT_SYMBOLS: ',,,' }),
    ).toThrow(/DEFAULT_SYMBOLS/);
  });

  it('accumulates every problem into a single error message', () => {
    let error: Error | undefined;
    try {
      validateEnv({ PORT: 'abc' }); // both API keys also missing
    } catch (e) {
      error = e as Error;
    }

    expect(error).toBeDefined();
    expect(error!.message).toContain('FINNHUB_API_KEY');
    expect(error!.message).toContain('TWELVE_DATA_API_KEY');
    expect(error!.message).toContain('SUPABASE_URL');
    expect(error!.message).toContain('PORT');
  });
});
