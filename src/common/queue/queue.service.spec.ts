import { BadRequestException, NotFoundException } from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { QueueService } from './queue.service';

describe('QueueService', () => {
  const queue = {
    add: jest.fn(),
    getJob: jest.fn(),
  };
  let service: QueueService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new QueueService(queue as never);
  });

  it('rejects invalid job payloads before enqueueing', async () => {
    await expect(service.enqueueNotificationEmail({ to: 'not-an-email' })).rejects.toThrow(BadRequestException);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('enqueues a validated notification email job', async () => {
    const job = { id: 'job-1', getState: jest.fn().mockResolvedValue('waiting') };
    queue.add.mockResolvedValue(job);

    await expect(
      service.enqueueNotificationEmail({
        userId: 'user-1',
        notificationId: 'notification-1',
        to: 'student@example.com',
        subject: 'Welcome',
        text: 'Welcome to Hamplard',
        type: NotificationType.COURSE_APPROVED,
      }),
    ).resolves.toEqual({ id: 'job-1', status: 'waiting' });
    expect(queue.add).toHaveBeenCalledWith(
      'send-notification-email',
      expect.objectContaining({ to: 'student@example.com' }),
    );
  });

  it('hides jobs belonging to another user', async () => {
    queue.getJob.mockResolvedValue({ data: { userId: 'another-user' } });

    await expect(service.getJobStatus('job-1', 'user-1')).rejects.toThrow(NotFoundException);
  });
});
