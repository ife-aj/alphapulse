import {
  BadRequestException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { toCanonicalDecimalString } from './decimal';
import { toDatabaseHttpException } from './database-errors';
import {
  HoldingDto,
  PortfolioDetailDto,
  PortfolioDto,
  PortfoliosResponseDto,
} from './dto/portfolio-response.dto';
import type { HoldingRow, PortfolioRow } from './portfolio.types';

const PORTFOLIOS_UNEXPECTED = 'Unexpected error while accessing portfolios.';
const PORTFOLIO_NOT_FOUND = 'Portfolio not found.';
const HOLDING_NOT_FOUND = 'Holding not found.';
const EMPTY_HOLDING_PATCH =
  'Provide at least one of quantity or averagePurchasePrice.';

function toPortfolioDto(row: PortfolioRow): PortfolioDto {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toHoldingDto(row: HoldingRow): HoldingDto {
  return {
    id: row.id,
    symbol: row.symbol,
    // Stored numeric(18,6) cells are echoed back as exact canonical decimal
    // strings — never as JS numbers.
    quantity: toCanonicalDecimalString(row.quantity),
    averagePurchasePrice: toCanonicalDecimalString(row.average_purchase_price),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Portfolio and holding database operations, scoped per authenticated user.
 *
 * Every operation runs on a *fresh* client from
 * `SupabaseService.createUserClient(accessToken)` whose requests carry the
 * user's JWT. Row Level Security is the ownership boundary: rows that are not
 * the caller's are either filtered out (reads) or rejected/filtered by RLS
 * (writes), and any RLS-hidden or nonexistent resource answers the same neutral
 * 404. The shared singleton client is never mutated with per-user headers, and
 * no service-role key is used anywhere. Ownership always comes from the verified
 * token — no `user_id` is ever read from a request body or route parameter.
 *
 * Holding writes take validated request *numbers* and canonicalize them to exact
 * decimal strings here, immediately before the Supabase call, so `numeric(18,6)`
 * never receives a binary float.
 *
 * Insert operations use `.insert(...).select().single()` (supabase-js adds
 * `Prefer: return=representation` automatically) and treat a successful call
 * that returns no row as an unexpected service failure. Update/delete use
 * `.select().maybeSingle()` so a zero-row result (not found or RLS-hidden) is a
 * clean `data: null` that maps to 404.
 */
@Injectable()
export class PortfoliosService {
  constructor(private readonly supabase: SupabaseService) {}

  async create(
    userId: string,
    accessToken: string,
    name: string,
  ): Promise<PortfolioDto> {
    const client = this.supabase.createUserClient(accessToken);
    try {
      const { data, error } = await client
        .from('portfolios')
        .insert({ user_id: userId, name })
        .select()
        .single();
      if (error) throw toDatabaseHttpException(error, 'create-portfolio');
      if (data === null)
        throw new InternalServerErrorException(PORTFOLIOS_UNEXPECTED);
      return toPortfolioDto(data as PortfolioRow);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw toDatabaseHttpException(error, 'create-portfolio');
    }
  }

  /** List the user's portfolios (newest first); holdings are intentionally not fetched. */
  async list(
    userId: string,
    accessToken: string,
  ): Promise<PortfoliosResponseDto> {
    const client = this.supabase.createUserClient(accessToken);
    try {
      const { data, error } = await client
        .from('portfolios')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .order('id');
      if (error) throw toDatabaseHttpException(error, 'list-portfolios');
      return {
        portfolios: ((data ?? []) as PortfolioRow[]).map(toPortfolioDto),
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw toDatabaseHttpException(error, 'list-portfolios');
    }
  }

  /** Fetch one portfolio with its holdings (ordered by symbol) — or a neutral 404. */
  async getOne(
    userId: string,
    accessToken: string,
    portfolioId: string,
  ): Promise<PortfolioDetailDto> {
    const client = this.supabase.createUserClient(accessToken);
    try {
      const { data, error } = await client
        .from('portfolios')
        .select('*')
        .eq('id', portfolioId)
        .eq('user_id', userId)
        .maybeSingle();
      if (error) throw toDatabaseHttpException(error, 'get-portfolio');
      if (data === null) throw new NotFoundException(PORTFOLIO_NOT_FOUND);

      const { data: holdingRows, error: holdingsError } = await client
        .from('holdings')
        .select('*')
        .eq('portfolio_id', portfolioId)
        .order('symbol');
      if (holdingsError)
        throw toDatabaseHttpException(holdingsError, 'get-holdings');

      return {
        ...toPortfolioDto(data as PortfolioRow),
        holdings: ((holdingRows ?? []) as HoldingRow[]).map(toHoldingDto),
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw toDatabaseHttpException(error, 'get-portfolio');
    }
  }

  async rename(
    userId: string,
    accessToken: string,
    portfolioId: string,
    name: string,
  ): Promise<PortfolioDto> {
    const client = this.supabase.createUserClient(accessToken);
    try {
      const { data, error } = await client
        .from('portfolios')
        .update({ name })
        .eq('id', portfolioId)
        .eq('user_id', userId)
        .select()
        .maybeSingle();
      if (error) throw toDatabaseHttpException(error, 'rename-portfolio');
      if (data === null) throw new NotFoundException(PORTFOLIO_NOT_FOUND);
      return toPortfolioDto(data as PortfolioRow);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw toDatabaseHttpException(error, 'rename-portfolio');
    }
  }

  async remove(
    userId: string,
    accessToken: string,
    portfolioId: string,
  ): Promise<void> {
    const client = this.supabase.createUserClient(accessToken);
    try {
      const { data, error } = await client
        .from('portfolios')
        .delete()
        .eq('id', portfolioId)
        .eq('user_id', userId)
        .select()
        .maybeSingle();
      if (error) throw toDatabaseHttpException(error, 'delete-portfolio');
      if (data === null) throw new NotFoundException(PORTFOLIO_NOT_FOUND);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw toDatabaseHttpException(error, 'delete-portfolio');
    }
  }

  async addHolding(
    accessToken: string,
    portfolioId: string,
    symbol: string,
    quantity: number,
    averagePurchasePrice: number,
  ): Promise<HoldingDto> {
    const client = this.supabase.createUserClient(accessToken);
    try {
      const { data, error } = await client
        .from('holdings')
        .insert({
          portfolio_id: portfolioId,
          symbol,
          quantity: toCanonicalDecimalString(quantity),
          average_purchase_price: toCanonicalDecimalString(
            averagePurchasePrice,
          ),
        })
        .select()
        .single();
      if (error) throw toDatabaseHttpException(error, 'add-holding');
      if (data === null)
        throw new InternalServerErrorException(PORTFOLIOS_UNEXPECTED);
      return toHoldingDto(data as HoldingRow);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw toDatabaseHttpException(error, 'add-holding');
    }
  }

  /** Partial update of one holding's quantity / average purchase price. */
  async updateHolding(
    accessToken: string,
    portfolioId: string,
    symbol: string,
    quantity: number | undefined,
    averagePurchasePrice: number | undefined,
  ): Promise<HoldingDto> {
    if (quantity === undefined && averagePurchasePrice === undefined) {
      throw new BadRequestException(EMPTY_HOLDING_PATCH);
    }

    const client = this.supabase.createUserClient(accessToken);
    try {
      const patch: { quantity?: string; average_purchase_price?: string } = {};
      if (quantity !== undefined) {
        patch.quantity = toCanonicalDecimalString(quantity);
      }
      if (averagePurchasePrice !== undefined) {
        patch.average_purchase_price = toCanonicalDecimalString(
          averagePurchasePrice,
        );
      }

      const { data, error } = await client
        .from('holdings')
        .update(patch)
        .eq('portfolio_id', portfolioId)
        .eq('symbol', symbol)
        .select()
        .maybeSingle();
      if (error) throw toDatabaseHttpException(error, 'update-holding');
      if (data === null) throw new NotFoundException(HOLDING_NOT_FOUND);
      return toHoldingDto(data as HoldingRow);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw toDatabaseHttpException(error, 'update-holding');
    }
  }

  async removeHolding(
    accessToken: string,
    portfolioId: string,
    symbol: string,
  ): Promise<void> {
    const client = this.supabase.createUserClient(accessToken);
    try {
      const { data, error } = await client
        .from('holdings')
        .delete()
        .eq('portfolio_id', portfolioId)
        .eq('symbol', symbol)
        .select()
        .maybeSingle();
      if (error) throw toDatabaseHttpException(error, 'delete-holding');
      if (data === null) throw new NotFoundException(HOLDING_NOT_FOUND);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw toDatabaseHttpException(error, 'delete-holding');
    }
  }
}
