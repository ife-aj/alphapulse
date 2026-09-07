import { IsUUID } from 'class-validator';

/**
 * Validated payload of `portfolio:subscribe` / `portfolio:unsubscribe`.
 *
 * The socket payloads are validated manually (class-validator on the gateway),
 * because the global HTTP ValidationPipe does not run over WebSocket traffic.
 * Ownership is never part of the payload: the user is derived from the
 * verified socket identity.
 */
export class SubscribePortfolioDto {
  @IsUUID()
  portfolioId: string;
}
