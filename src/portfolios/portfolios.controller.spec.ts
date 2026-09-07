import { PortfoliosController } from './portfolios.controller';
import { PortfoliosService } from './portfolios.service';
import { PortfoliosValuationService } from './portfolio-valuation.service';

/**
 * Controller unit test: proves each handler plumbs the authenticated user id,
 * the raw access token, the validated DTO/params, and the right service.
 *
 * HTTP-level behaviour (status codes, the bearer guard, UUID/symbol pipes, the
 * 400/404/422 bodies) is deliberately NOT exercised here — those are covered by
 * the e2e spec, which runs through Nest's full request pipeline.
 */
describe('PortfoliosController', () => {
  let controller: PortfoliosController;
  const portfolios = {
    create: jest.fn(),
    list: jest.fn(),
    getOne: jest.fn(),
    rename: jest.fn(),
    remove: jest.fn(),
    addHolding: jest.fn(),
    updateHolding: jest.fn(),
    removeHolding: jest.fn(),
  };
  const valuation = { getValuation: jest.fn() };

  const user = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new PortfoliosController(
      portfolios as unknown as PortfoliosService,
      valuation as unknown as PortfoliosValuationService,
    );
  });

  it('create passes the user id, token, and trimmed name to the service', () => {
    controller.create(user as never, 'token-1', { name: 'Tech Holdings' } as never);
    expect(portfolios.create).toHaveBeenCalledWith(
      user.id,
      'token-1',
      'Tech Holdings',
    );
  });

  it('list passes the user id and token to the service', () => {
    controller.list(user as never, 'token-1');
    expect(portfolios.list).toHaveBeenCalledWith(user.id, 'token-1');
  });

  it('getOne passes the user id, token, and portfolio id', () => {
    controller.getOne(user as never, 'token-1', 'pf-1');
    expect(portfolios.getOne).toHaveBeenCalledWith(user.id, 'token-1', 'pf-1');
  });

  it('rename passes the user id, token, portfolio id, and new name', () => {
    controller.rename(user as never, 'token-1', 'pf-1', {
      name: 'Growth Holdings',
    } as never);
    expect(portfolios.rename).toHaveBeenCalledWith(
      user.id,
      'token-1',
      'pf-1',
      'Growth Holdings',
    );
  });

  it('remove passes the user id, token, and portfolio id', async () => {
    await controller.remove(user as never, 'token-1', 'pf-1');
    expect(portfolios.remove).toHaveBeenCalledWith(user.id, 'token-1', 'pf-1');
  });

  it('addHolding passes the token, portfolio id, symbol, quantity, and price', () => {
    controller.addHolding('token-1', 'pf-1', {
      symbol: 'AAPL',
      quantity: 12.5,
      averagePurchasePrice: 152.3755,
    } as never);
    expect(portfolios.addHolding).toHaveBeenCalledWith(
      'token-1',
      'pf-1',
      'AAPL',
      12.5,
      152.3755,
    );
  });

  it('updateHolding passes the token, portfolio id, symbol, and both optional fields', () => {
    controller.updateHolding('token-1', 'pf-1', 'AAPL', {
      quantity: 15,
      averagePurchasePrice: 160.25,
    } as never);
    expect(portfolios.updateHolding).toHaveBeenCalledWith(
      'token-1',
      'pf-1',
      'AAPL',
      15,
      160.25,
    );
  });

  it('updateHolding forwards undefined when a field is absent', () => {
    controller.updateHolding('token-1', 'pf-1', 'AAPL', {} as never);
    expect(portfolios.updateHolding).toHaveBeenCalledWith(
      'token-1',
      'pf-1',
      'AAPL',
      undefined,
      undefined,
    );
  });

  it('removeHolding passes the token, portfolio id, and symbol', async () => {
    await controller.removeHolding('token-1', 'pf-1', 'AAPL');
    expect(portfolios.removeHolding).toHaveBeenCalledWith(
      'token-1',
      'pf-1',
      'AAPL',
    );
  });

  it('getValuation routes to the valuation service with the user id and token', () => {
    controller.getValuation(user as never, 'token-1', 'pf-1');
    expect(valuation.getValuation).toHaveBeenCalledWith(
      user.id,
      'token-1',
      'pf-1',
    );
  });
});
