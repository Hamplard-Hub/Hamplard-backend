import { QueueController } from './queue.controller';

describe('QueueController', () => {
  it('scopes job status lookup to the requesting user', () => {
    const queueService = { getJobStatus: jest.fn().mockReturnValue({ state: 'completed' }) };
    const controller = new QueueController(queueService as any);

    expect(controller.getJobStatus('job-1', 'user-1')).toEqual({ state: 'completed' });
    expect(queueService.getJobStatus).toHaveBeenCalledWith('job-1', 'user-1');
  });
});
