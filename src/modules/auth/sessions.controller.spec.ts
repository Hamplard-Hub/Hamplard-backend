import { SessionsController } from './sessions.controller';

describe('SessionsController', () => {
  const sessionsService = {
    listSessions: jest.fn(),
    revokeSession: jest.fn(),
    revokeAllExceptCurrent: jest.fn(),
  };
  const controller = new SessionsController(sessionsService as any);

  beforeEach(() => jest.clearAllMocks());

  it('delegates listing and revoking to the sessions service', () => {
    controller.list('user-1', 'current-jti');
    controller.revoke('user-1', 'session-1');
    controller.revokeAll('user-1', 'current-jti');

    expect(sessionsService.listSessions).toHaveBeenCalledWith('user-1', 'current-jti');
    expect(sessionsService.revokeSession).toHaveBeenCalledWith('user-1', 'session-1');
    expect(sessionsService.revokeAllExceptCurrent).toHaveBeenCalledWith('user-1', 'current-jti');
  });
});
