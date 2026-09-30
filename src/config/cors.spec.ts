import { parseAllowedOrigins } from './cors';

describe('production browser origins', () => {
  it('preserves same-origin configuration when omitted', () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
  });
  it('accepts and deduplicates exact origins', () => {
    expect(
      parseAllowedOrigins(
        'https://app.netlify.app, http://localhost:5173,https://app.netlify.app',
      ),
    ).toEqual(['https://app.netlify.app', 'http://localhost:5173']);
  });
  it.each([
    '*',
    '',
    'https://app.netlify.app/',
    'https://app.netlify.app/path',
    'https://app.netlify.app?x=1',
    'https://user:pass@app.netlify.app',
    'ftp://app.netlify.app',
    'https://app.netlify.app,',
  ])('rejects invalid configuration %s', (value) => {
    expect(() => parseAllowedOrigins(value)).toThrow();
  });
});
