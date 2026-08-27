import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import {
  isValidSymbol,
  normalizeSymbol,
  SYMBOL_FORMAT_HINT,
} from '../validation/symbol.validation';

/**
 * Validates and normalizes a single stock symbol taken from a route param.
 *
 * Bound per-param via `@Param('symbol', ParseSymbolPipe)`, it runs before the
 * controller method, so an invalid symbol is rejected with 400 before any
 * upstream provider call is made. On success it returns the normalized
 * (trimmed, upper-cased) symbol, which the controller forwards to the service.
 */
@Injectable()
export class ParseSymbolPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new BadRequestException(
        `A stock symbol is required. ${SYMBOL_FORMAT_HINT}`,
      );
    }

    const normalized = normalizeSymbol(value);
    if (!isValidSymbol(normalized)) {
      throw new BadRequestException(
        `Invalid symbol "${value}". ${SYMBOL_FORMAT_HINT}`,
      );
    }

    return normalized;
  }
}
