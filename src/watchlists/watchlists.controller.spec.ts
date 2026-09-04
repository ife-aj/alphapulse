import { WatchlistsController } from './watchlists.controller';
import type { WatchlistsService } from './watchlists.service';

/**
 * Controller unit test: proves each handler plumbs the authenticated user id,
 * the raw access token, and the validated DTO/params into the service.
 *
 * HTTP-level behaviour (status codes, the bearer guard, UUID/symbol pipes) is
 * deliberately NOT exercised here — those are covered by the e2e spec, which
 * runs through Nest's full request pipeline.
 */
describe('WatchlistsController', () => {
  let controller: WatchlistsController;
  const service = {
    create: jest.fn(),
    list: jest.fn(),
    rename: jest.fn(),
    remove: jest.fn(),
    addItem: jest.fn(),
    removeItem: jest.fn(),
  };

  const user = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new WatchlistsController(
      service as unknown as WatchlistsService,
    );
  });

  it('create passes the user id, token, and trimmed name to the service', () => {
    controller.create(user as never, 'token-1', { name: 'Tech Stocks' } as never);
    expect(service.create).toHaveBeenCalledWith(
      user.id,
      'token-1',
      'Tech Stocks',
    );
  });

  it('list passes the user id and token to the service', () => {
    controller.list(user as never, 'token-1');
    expect(service.list).toHaveBeenCalledWith(user.id, 'token-1');
  });

  it('rename passes the user id, token, watchlist id, and new name', () => {
    controller.rename(user as never, 'token-1', 'wl-1', {
      name: 'Growth Stocks',
    } as never);
    expect(service.rename).toHaveBeenCalledWith(
      user.id,
      'token-1',
      'wl-1',
      'Growth Stocks',
    );
  });

  it('remove passes the user id, token, and watchlist id', async () => {
    await controller.remove(user as never, 'token-1', 'wl-1');
    expect(service.remove).toHaveBeenCalledWith(user.id, 'token-1', 'wl-1');
  });

  it('addItem passes the token, watchlist id, and normalized symbol', () => {
    controller.addItem('token-1', 'wl-1', { symbol: 'AAPL' } as never);
    expect(service.addItem).toHaveBeenCalledWith('token-1', 'wl-1', 'AAPL');
  });

  it('removeItem passes the token, watchlist id, and symbol', async () => {
    await controller.removeItem('token-1', 'wl-1', 'AAPL');
    expect(service.removeItem).toHaveBeenCalledWith('token-1', 'wl-1', 'AAPL');
  });
});
