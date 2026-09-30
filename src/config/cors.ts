import { IoAdapter } from '@nestjs/platform-socket.io';
import type { ServerOptions } from 'socket.io';

/** Exact browser origins only; an omitted setting preserves same-origin use. */
export function parseAllowedOrigins(value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(
      'CORS_ORIGINS must be a comma-separated list of http(s) origins',
    );
  }
  return [
    ...new Set(
      value.split(',').map((entry) => {
        const origin = entry.trim();
        const url = new URL(origin);
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.origin !== origin
        ) {
          throw new Error(
            'CORS_ORIGINS entries must be exact http(s) origins without paths or trailing slashes',
          );
        }
        return origin;
      }),
    ),
  ];
}

export class CorsIoAdapter extends IoAdapter {
  constructor(
    app: ConstructorParameters<typeof IoAdapter>[0],
    private readonly origins: string[],
  ) {
    super(app);
  }

  createIOServer(port: number, options?: ServerOptions) {
    return super.createIOServer(port, {
      ...options,
      cors: { origin: this.origins, credentials: false },
    });
  }
}
