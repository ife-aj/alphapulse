import { Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SupabaseModule } from './supabase.module';
import { SupabaseService } from './supabase.service';

// Replace the real package with a jest.fn so construction never opens a socket.
jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));

const mockedCreateClient = createClient as unknown as jest.Mock;

/** A ConfigService double whose getOrThrow returns from `values` or throws like the real one. */
function configFrom(values: Record<string, string>): ConfigService {
  return {
    getOrThrow: (key: string) => {
      if (key in values) return values[key];
      throw new Error(`Configuration key "${key}" is missing`);
    },
  } as unknown as ConfigService;
}

const URL = 'https://abcdefghijk.supabase.co';
// A structurally-realistic (but fake) anon-key JWT.
const ANON_KEY = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.dummy-signature';
const SERVER_AUTH_OPTIONS = {
  auth: { autoRefreshToken: false, persistSession: false },
};

describe('SupabaseService', () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    // Silence the service's own logger (it would otherwise print during tests)
    // while keeping the spy so tests can assert nothing sensitive is logged.
    logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
  });

  it('builds the client from SUPABASE_URL and SUPABASE_ANON_KEY via ConfigService', () => {
    const fakeClient = { from: jest.fn() } as unknown as SupabaseClient;
    mockedCreateClient.mockReturnValue(fakeClient);

    const service = new SupabaseService(
      configFrom({ SUPABASE_URL: URL, SUPABASE_ANON_KEY: ANON_KEY }),
    );

    expect(mockedCreateClient).toHaveBeenCalledTimes(1);
    expect(mockedCreateClient).toHaveBeenCalledWith(
      URL,
      ANON_KEY,
      SERVER_AUTH_OPTIONS,
    );
    expect(service.client).toBe(fakeClient);
  });

  it('fails fast when SUPABASE_URL is missing', () => {
    expect(
      () => new SupabaseService(configFrom({ SUPABASE_ANON_KEY: ANON_KEY })),
    ).toThrow(/SUPABASE_URL/);
  });

  it('fails fast when SUPABASE_ANON_KEY is missing', () => {
    expect(
      () => new SupabaseService(configFrom({ SUPABASE_URL: URL })),
    ).toThrow(/SUPABASE_ANON_KEY/);
  });

  it('never logs the URL or the anon key', () => {
    mockedCreateClient.mockReturnValue({} as unknown as SupabaseClient);

    new SupabaseService(
      configFrom({ SUPABASE_URL: URL, SUPABASE_ANON_KEY: ANON_KEY }),
    );

    const logged = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).not.toContain(URL);
    expect(logged).not.toContain(ANON_KEY);
  });

  it('returns a fresh, isolated client per createAuthClient() call', () => {
    const shared = { kind: 'shared' } as unknown as SupabaseClient;
    const first = { kind: 'first' } as unknown as SupabaseClient;
    const second = { kind: 'second' } as unknown as SupabaseClient;
    mockedCreateClient
      .mockReturnValueOnce(shared)
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);

    const service = new SupabaseService(
      configFrom({ SUPABASE_URL: URL, SUPABASE_ANON_KEY: ANON_KEY }),
    );

    const clientA = service.createAuthClient();
    const clientB = service.createAuthClient();

    expect(service.client).toBe(shared);
    expect(clientA).not.toBe(clientB);
    expect(clientA).not.toBe(shared);
    // Every auth client uses the same non-persistent options and no per-user header.
    for (const call of mockedCreateClient.mock.calls) {
      expect(call[0]).toBe(URL);
      expect(call[1]).toBe(ANON_KEY);
      expect(call[2]).toEqual(SERVER_AUTH_OPTIONS);
    }
  });

  it('createUserClient() scopes only that client to the bearer token', () => {
    const shared = { kind: 'shared' } as unknown as SupabaseClient;
    const userScoped = { kind: 'user' } as unknown as SupabaseClient;
    mockedCreateClient
      .mockReturnValueOnce(shared)
      .mockReturnValueOnce(userScoped);

    const service = new SupabaseService(
      configFrom({ SUPABASE_URL: URL, SUPABASE_ANON_KEY: ANON_KEY }),
    );

    const scoped = service.createUserClient('user-access-token');

    expect(scoped).toBe(userScoped);
    // The singleton client is untouched and carries no per-user header.
    expect(service.client).toBe(shared);
    expect(mockedCreateClient).toHaveBeenCalledTimes(2);
    expect(mockedCreateClient.mock.calls[0][2]).toEqual(SERVER_AUTH_OPTIONS);
    expect(mockedCreateClient.mock.calls[1][2]).toEqual({
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: 'Bearer user-access-token' } },
    });
  });

  it('createUserClient() throws on a blank access token', () => {
    mockedCreateClient.mockReturnValue({} as unknown as SupabaseClient);
    const service = new SupabaseService(
      configFrom({ SUPABASE_URL: URL, SUPABASE_ANON_KEY: ANON_KEY }),
    );

    expect(() => service.createUserClient('   ')).toThrow(/access token/);
  });
});

describe('SupabaseModule', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
  });

  it('provides an exported SupabaseService wired to environment config', async () => {
    mockedCreateClient.mockReturnValue({} as unknown as SupabaseClient);
    process.env.SUPABASE_URL = URL;
    process.env.SUPABASE_ANON_KEY = ANON_KEY;

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        SupabaseModule,
      ],
    }).compile();

    try {
      const service = moduleRef.get(SupabaseService);
      expect(service.client).toBeDefined();
      expect(mockedCreateClient).toHaveBeenCalledWith(
        URL,
        ANON_KEY,
        SERVER_AUTH_OPTIONS,
      );
    } finally {
      await moduleRef.close();
    }
  });
});
