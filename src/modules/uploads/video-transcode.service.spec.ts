import * as fs from 'fs';
import {
  RESOLUTION_PRESETS,
  VideoTranscodeProcessor,
  selectPresetsForSource,
} from './video-transcode.service';

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: jest.fn(() => true),
  mkdirSync: jest.fn(),
  unlinkSync: jest.fn(),
}));

let mockProbeResult: { err?: Error; metadata?: any } = {};
const mockScaledTo: string[] = [];

jest.mock('fluent-ffmpeg', () => {
  const factory: any = jest.fn(() => {
    const handlers: Record<string, (...args: any[]) => void> = {};
    const command: any = {
      outputOptions: jest.fn((options: string[]) => {
        mockScaledTo.push(options[0]);
        return command;
      }),
      output: jest.fn(() => command),
      on: jest.fn((event: string, handler: (...args: any[]) => void) => {
        handlers[event] = handler;
        return command;
      }),
      run: jest.fn(() => handlers.end?.()),
    };
    return command;
  });
  factory.ffprobe = jest.fn((_path: string, cb: (err: any, data: any) => void) =>
    cb(mockProbeResult.err ?? null, mockProbeResult.metadata),
  );
  return factory;
});

const videoStream = (width: number, height: number) => ({
  streams: [{ codec_type: 'video', width, height }],
});

describe('selectPresetsForSource', () => {
  it('keeps the full ladder for a 1080p source', () => {
    expect(selectPresetsForSource({ width: 1920, height: 1080 }).map((p) => p.name))
      .toEqual(['1080p', '720p', '480p']);
  });

  it('skips presets above a 720p source', () => {
    expect(selectPresetsForSource({ width: 1280, height: 720 }).map((p) => p.name))
      .toEqual(['720p', '480p']);
  });

  it('uses the source size instead of upscaling a tiny source', () => {
    expect(selectPresetsForSource({ width: 427, height: 241 })).toEqual([
      expect.objectContaining({ name: '240p', width: 426, height: 240 }),
    ]);
  });

  it('falls back to every preset when the size is unknown', () => {
    expect(selectPresetsForSource(null)).toBe(RESOLUTION_PRESETS);
  });
});

describe('VideoTranscodeProcessor', () => {
  const jobData = {
    videoId: 'lesson-1',
    sourcePath: 'uploads/courses/c1/lessons/lesson-1/source.mp4',
    filename: 'source.mp4',
    subfolder: 'courses/c1/lessons/lesson-1',
  };
  const job: any = { id: 'job-1', data: jobData, updateProgress: jest.fn() };

  let prisma: any;
  let config: any;
  const cdn = {
    attachCdnUrls: jest.fn((originUrl: string) => ({ originUrl, cdnUrl: `https://cdn${originUrl}` })),
  };

  const build = () => new VideoTranscodeProcessor(config, cdn as any, prisma);

  beforeEach(() => {
    jest.clearAllMocks();
    mockScaledTo.length = 0;
    mockProbeResult = { metadata: videoStream(1280, 720) };
    prisma = {
      lesson: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'lesson-1',
          videoUrl: '/uploads/courses/c1/lessons/lesson-1/source.mp4',
        }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    config = { get: jest.fn((_key: string, fallback?: unknown) => fallback) };
  });

  it('only transcodes presets up to the source resolution', async () => {
    const result = await build().process(job);

    expect(Object.keys(result)).toEqual(['720p', '480p']);
    expect(mockScaledTo).toEqual(['-vf scale=1280x720', '-vf scale=854x480']);
  });

  it('persists the renditions on the lesson and repoints videoUrl off the source', async () => {
    await build().process(job);

    expect(prisma.lesson.update).toHaveBeenCalledWith({
      where: { id: 'lesson-1' },
      data: {
        videoRenditions: {
          '720p': expect.objectContaining({
            originUrl: '/uploads/courses/c1/lessons/lesson-1/transcoded/source-720p.mp4',
            width: 1280,
            height: 720,
          }),
          '480p': expect.objectContaining({ width: 854, height: 480 }),
        },
        videoUrl: '/uploads/courses/c1/lessons/lesson-1/transcoded/source-720p.mp4',
      },
    });
  });

  it('keeps a custom videoUrl that does not point at the source', async () => {
    prisma.lesson.findUnique.mockResolvedValue({ id: 'lesson-1', videoUrl: 'https://videos.example/x.mp4' });

    await build().process(job);

    expect(prisma.lesson.update.mock.calls[0][0].data.videoUrl).toBeUndefined();
  });

  it('keeps the source by default', async () => {
    await build().process(job);
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });

  it('deletes the source after linking when VIDEO_DELETE_SOURCE_AFTER_TRANSCODE is on', async () => {
    config.get.mockImplementation((key: string, fallback?: unknown) =>
      key === 'VIDEO_DELETE_SOURCE_AFTER_TRANSCODE' ? 'true' : fallback,
    );

    await build().process(job);
    expect(fs.unlinkSync).toHaveBeenCalledWith(jobData.sourcePath);
  });

  it('does not delete the source when no lesson matches the job', async () => {
    config.get.mockImplementation((key: string, fallback?: unknown) =>
      key === 'VIDEO_DELETE_SOURCE_AFTER_TRANSCODE' ? 'true' : fallback,
    );
    prisma.lesson.findUnique.mockResolvedValue(null);

    await build().process(job);
    expect(prisma.lesson.update).not.toHaveBeenCalled();
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });
});
