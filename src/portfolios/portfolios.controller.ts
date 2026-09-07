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
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { CurrentToken } from '../auth/current-token.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUserDto } from '../auth/dto/auth-response.dto';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { ParseSymbolPipe } from '../market/pipes/parse-symbol.pipe';
import { PortfoliosService } from './portfolios.service';
import { PortfoliosValuationService } from './portfolio-valuation.service';
import { PortfolioNameDto } from './dto/portfolio-name.dto';
import { CreateHoldingDto } from './dto/create-holding.dto';
import { UpdateHoldingDto } from './dto/update-holding.dto';
import {
  HoldingDto,
  PortfolioDetailDto,
  PortfolioDto,
  PortfoliosResponseDto,
} from './dto/portfolio-response.dto';
import { PortfolioValuationDto } from './dto/valuation-response.dto';

/**
 * Authenticated portfolio and holding endpoints.
 *
 * Every route requires a valid `Authorization: Bearer <access_token>` (enforced
 * by SupabaseAuthGuard) and operates on the authenticated user's own data only.
 * Ownership comes from the verified token/user — user ids are never read from
 * bodies or route parameters — and Row Level Security is the final boundary.
 */
@ApiTags('portfolios')
@Controller('portfolios')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  description: 'Missing/malformed bearer header, or an invalid/expired token.',
})
export class PortfoliosController {
  constructor(
    private readonly portfoliosService: PortfoliosService,
    private readonly valuationService: PortfoliosValuationService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a portfolio' })
  @ApiCreatedResponse({ type: PortfolioDto })
  @ApiBadRequestResponse({ description: 'Invalid name payload.' })
  @ApiConflictResponse({
    description: 'A portfolio with this name already exists.',
  })
  create(
    @CurrentUser() user: AuthUserDto,
    @CurrentToken() token: string,
    @Body() dto: PortfolioNameDto,
  ): Promise<PortfolioDto> {
    return this.portfoliosService.create(user.id, token, dto.name);
  }

  @Get()
  @ApiOperation({ summary: 'List the authenticated user’s portfolios' })
  @ApiOkResponse({ type: PortfoliosResponseDto })
  list(
    @CurrentUser() user: AuthUserDto,
    @CurrentToken() token: string,
  ): Promise<PortfoliosResponseDto> {
    return this.portfoliosService.list(user.id, token);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a portfolio with its holdings' })
  @ApiOkResponse({ type: PortfolioDetailDto })
  @ApiBadRequestResponse({ description: 'Malformed portfolio id.' })
  @ApiNotFoundResponse({ description: 'Portfolio not found or inaccessible.' })
  getOne(
    @CurrentUser() user: AuthUserDto,
    @CurrentToken() token: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PortfolioDetailDto> {
    return this.portfoliosService.getOne(user.id, token, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename a portfolio' })
  @ApiOkResponse({ type: PortfolioDto })
  @ApiBadRequestResponse({
    description: 'Invalid name payload or malformed portfolio id.',
  })
  @ApiNotFoundResponse({ description: 'Portfolio not found or inaccessible.' })
  @ApiConflictResponse({
    description: 'A portfolio with this name already exists.',
  })
  rename(
    @CurrentUser() user: AuthUserDto,
    @CurrentToken() token: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PortfolioNameDto,
  ): Promise<PortfolioDto> {
    return this.portfoliosService.rename(user.id, token, id, dto.name);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a portfolio and its holdings' })
  @ApiNoContentResponse({ description: 'Deleted. No response body.' })
  @ApiBadRequestResponse({ description: 'Malformed portfolio id.' })
  @ApiNotFoundResponse({ description: 'Portfolio not found or inaccessible.' })
  async remove(
    @CurrentUser() user: AuthUserDto,
    @CurrentToken() token: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.portfoliosService.remove(user.id, token, id);
  }

  @Post(':id/holdings')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add a holding to a portfolio' })
  @ApiCreatedResponse({ type: HoldingDto })
  @ApiBadRequestResponse({
    description: 'Invalid symbol/quantity/price payload or malformed portfolio id.',
  })
  @ApiNotFoundResponse({ description: 'Portfolio not found or inaccessible.' })
  @ApiConflictResponse({
    description: 'This symbol is already held in the portfolio.',
  })
  addHolding(
    @CurrentToken() token: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateHoldingDto,
  ): Promise<HoldingDto> {
    return this.portfoliosService.addHolding(
      token,
      id,
      dto.symbol,
      dto.quantity,
      dto.averagePurchasePrice,
    );
  }

  @Patch(':id/holdings/:symbol')
  @ApiOperation({ summary: 'Update a holding (quantity and/or average price)' })
  @ApiOkResponse({ type: HoldingDto })
  @ApiBadRequestResponse({
    description:
      'Invalid payload, empty body, malformed portfolio id, or invalid symbol.',
  })
  @ApiNotFoundResponse({ description: 'Holding not found or inaccessible.' })
  updateHolding(
    @CurrentToken() token: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('symbol', ParseSymbolPipe) symbol: string,
    @Body() dto: UpdateHoldingDto,
  ): Promise<HoldingDto> {
    return this.portfoliosService.updateHolding(
      token,
      id,
      symbol,
      dto.quantity,
      dto.averagePurchasePrice,
    );
  }

  @Delete(':id/holdings/:symbol')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a holding from a portfolio' })
  @ApiNoContentResponse({ description: 'Removed. No response body.' })
  @ApiBadRequestResponse({
    description: 'Malformed portfolio id or invalid symbol.',
  })
  @ApiNotFoundResponse({ description: 'Holding not found or inaccessible.' })
  async removeHolding(
    @CurrentToken() token: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('symbol', ParseSymbolPipe) symbol: string,
  ): Promise<void> {
    await this.portfoliosService.removeHolding(token, id, symbol);
  }

  @Get(':id/valuation')
  @ApiOperation({
    summary:
      'Live valuation of a portfolio (read-only; no market calls when empty)',
  })
  @ApiOkResponse({ type: PortfolioValuationDto })
  @ApiBadRequestResponse({ description: 'Malformed portfolio id.' })
  @ApiNotFoundResponse({ description: 'Portfolio not found or inaccessible.' })
  @ApiUnprocessableEntityResponse({
    description: 'A held symbol has no market data and cannot be valued.',
  })
  getValuation(
    @CurrentUser() user: AuthUserDto,
    @CurrentToken() token: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PortfolioValuationDto> {
    return this.valuationService.getValuation(user.id, token, id);
  }
}
