import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentToken } from '../auth/current-token.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUserDto } from '../auth/dto/auth-response.dto';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { ParseSymbolPipe } from '../market/pipes/parse-symbol.pipe';
import { CreateWatchlistDto } from './dto/create-watchlist.dto';
import { UpdateWatchlistDto } from './dto/update-watchlist.dto';
import { AddWatchlistItemDto } from './dto/add-watchlist-item.dto';
import {
  WatchlistDto,
  WatchlistItemDto,
  WatchlistsResponseDto,
} from './dto/watchlist-response.dto';
import { WatchlistsService } from './watchlists.service';

/**
 * Authenticated watchlist endpoints.
 *
 * Every route requires a valid `Authorization: Bearer <access_token>` (enforced
 * by SupabaseAuthGuard) and operates on the authenticated user's own data only.
 * Ownership comes from the verified token/user — user ids are never read from
 * bodies or route parameters — and Row Level Security is the final boundary.
 */
@ApiTags('watchlists')
@Controller('watchlists')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  description: 'Missing/malformed bearer header, or an invalid/expired token.',
})
export class WatchlistsController {
  constructor(private readonly watchlistsService: WatchlistsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a watchlist' })
  @ApiCreatedResponse({ type: WatchlistDto })
  @ApiBadRequestResponse({ description: 'Invalid name payload.' })
  @ApiConflictResponse({
    description: 'A watchlist with this name already exists.',
  })
  create(
    @CurrentUser() user: AuthUserDto,
    @CurrentToken() token: string,
    @Body() dto: CreateWatchlistDto,
  ): Promise<WatchlistDto> {
    return this.watchlistsService.create(user.id, token, dto.name);
  }

  @Get()
  @ApiOperation({ summary: 'List the authenticated user’s watchlists with items' })
  @ApiOkResponse({ type: WatchlistsResponseDto })
  list(
    @CurrentUser() user: AuthUserDto,
    @CurrentToken() token: string,
  ): Promise<WatchlistsResponseDto> {
    return this.watchlistsService.list(user.id, token);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename a watchlist' })
  @ApiOkResponse({ type: WatchlistDto })
  @ApiBadRequestResponse({
    description: 'Invalid name payload or malformed watchlist id.',
  })
  @ApiNotFoundResponse({ description: 'Watchlist not found or inaccessible.' })
  @ApiConflictResponse({
    description: 'A watchlist with this name already exists.',
  })
  rename(
    @CurrentUser() user: AuthUserDto,
    @CurrentToken() token: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWatchlistDto,
  ): Promise<WatchlistDto> {
    return this.watchlistsService.rename(user.id, token, id, dto.name);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a watchlist and its items' })
  @ApiNoContentResponse({ description: 'Deleted. No response body.' })
  @ApiBadRequestResponse({ description: 'Malformed watchlist id.' })
  @ApiNotFoundResponse({ description: 'Watchlist not found or inaccessible.' })
  async remove(
    @CurrentUser() user: AuthUserDto,
    @CurrentToken() token: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.watchlistsService.remove(user.id, token, id);
  }

  @Post(':id/items')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add a symbol to a watchlist' })
  @ApiCreatedResponse({ type: WatchlistItemDto })
  @ApiBadRequestResponse({
    description: 'Invalid symbol payload or malformed watchlist id.',
  })
  @ApiNotFoundResponse({ description: 'Watchlist not found or inaccessible.' })
  @ApiConflictResponse({
    description: 'This symbol is already in the watchlist.',
  })
  addItem(
    @CurrentToken() token: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddWatchlistItemDto,
  ): Promise<WatchlistItemDto> {
    return this.watchlistsService.addItem(token, id, dto.symbol);
  }

  @Delete(':id/items/:symbol')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a symbol from a watchlist' })
  @ApiNoContentResponse({ description: 'Removed. No response body.' })
  @ApiBadRequestResponse({
    description: 'Malformed watchlist id or invalid symbol.',
  })
  @ApiNotFoundResponse({ description: 'Watchlist item not found or inaccessible.' })
  async removeItem(
    @CurrentToken() token: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('symbol', ParseSymbolPipe) symbol: string,
  ): Promise<void> {
    await this.watchlistsService.removeItem(token, id, symbol);
  }
}
