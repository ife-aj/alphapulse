import type { Request } from 'express';
import type { AuthUserDto } from './dto/auth-response.dto';

/**
 * An Express request that has passed SupabaseAuthGuard. `user` is the verified
 * (and safely-mapped) Supabase user, attached by the guard so downstream
 * controllers/interceptors can rely on `request.user.id`.
 */
export interface AuthenticatedRequest extends Request {
  user: AuthUserDto;
  /**
   * The raw bearer token, attached by SupabaseAuthGuard. Downstream handlers use
   * it to build a per-user Supabase client (createUserClient) whose requests are
   * scoped by Row Level Security to this user.
   */
  accessToken?: string;
}
