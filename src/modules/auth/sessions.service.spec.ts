import { SessionsService } from './sessions.service';

describe('SessionsService — New Device Login Alerts (Issue #501)', () => {
  let service: SessionsService;
  const mockPrisma = {
    session: {
      findFirst: jest.fn(),
      create: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
  };
  const mockNotifications = {
    notifyUser: jest.fn(),
  };
  const mockConfig = {
    get: jest.fn().mockReturnValue('https://app.hamplard.com'),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SessionsService(
      mockPrisma as any,
      mockNotifications as any,
      mockConfig as any,
    );
  });

  it('sends an email + in-app notification with sessions link when logging in from a new device/IP', async () => {
    mockPrisma.session.findFirst.mockResolvedValueOnce(null);
    mockPrisma.session.create.mockResolvedValueOnce({
      id: 'sess-1',
      userId: 'user-1',
      jti: 'jti-1',
      deviceLabel: 'Chrome on macOS',
      ipAddress: '198.51.100.42',
    });

    await service.createSession({
      userId: 'user-1',
      jti: 'jti-1',
      expiresAt: new Date(Date.now() + 86400000),
      meta: {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0.0',
        ipAddress: '198.51.100.42',
      },
    });

    expect(mockPrisma.session.findFirst).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        deviceLabel: 'Chrome on macOS',
        ipAddress: '198.51.100.42',
      },
    });
    expect(mockNotifications.notifyUser).toHaveBeenCalledWith(
      'user-1',
      'NEW_DEVICE_LOGIN',
      'New device sign-in detected',
      expect.stringContaining('https://app.hamplard.com/dashboard/settings/sessions'),
      expect.objectContaining({
        sessionId: 'sess-1',
        deviceLabel: 'Chrome on macOS',
        ipAddress: '198.51.100.42',
        sessionsUrl: 'https://app.hamplard.com/dashboard/settings/sessions',
      }),
    );
  });

  it('does not send a duplicate notification when the device label and IP combination is already known', async () => {
    mockPrisma.session.findFirst.mockResolvedValueOnce({
      id: 'sess-prev',
      userId: 'user-1',
      deviceLabel: 'Chrome on macOS',
      ipAddress: '198.51.100.42',
    });
    mockPrisma.session.create.mockResolvedValueOnce({
      id: 'sess-2',
      userId: 'user-1',
      jti: 'jti-2',
      deviceLabel: 'Chrome on macOS',
      ipAddress: '198.51.100.42',
    });

    await service.createSession({
      userId: 'user-1',
      jti: 'jti-2',
      expiresAt: new Date(Date.now() + 86400000),
      meta: {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0.0',
        ipAddress: '198.51.100.42',
      },
    });

    expect(mockNotifications.notifyUser).not.toHaveBeenCalled();
  });
});
