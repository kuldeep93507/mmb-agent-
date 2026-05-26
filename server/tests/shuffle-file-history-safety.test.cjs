'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const CHANNELS_FILE = path.join(ROOT, 'channels_data.json');
const SHUFFLE_SRC = fs.readFileSync(path.resolve(__dirname, '../shuffleEngine.cjs'), 'utf8');
const INDEX_SRC = fs.readFileSync(path.resolve(__dirname, '../index.cjs'), 'utf8');
const UI_SRC = fs.readFileSync(path.resolve(ROOT, 'src/components/VideoShufflePage.tsx'), 'utf8');

function cleanup() {
  try { fs.unlinkSync(CHANNELS_FILE); } catch { /* ignore */ }
}

describe('Group 4 shuffle/config/file safety', () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  test('normalizeSettings permanently disables warmup even if old state says true', () => {
    jest.resetModules();
    const { normalizeSettings } = require('../shuffleEngine.cjs');
    expect(normalizeSettings({ warmupEnabled: true }).warmupEnabled).toBe(false);
    expect(SHUFFLE_SRC).toContain('function fisherYatesShuffle');
    expect(SHUFFLE_SRC).not.toContain('sort(() => Math.random() - 0.5)');
  });

  test('assignOneProfile respects shared usedInThisRun reservations', () => {
    fs.writeFileSync(CHANNELS_FILE, JSON.stringify({
      channels: [{ id: 1, channel_name: 'Ch' }],
      videos: [
        { channel_id: 1, video_id: 'v1', title: 'Video 1', url: 'https://youtu.be/v1' },
        { channel_id: 1, video_id: 'v2', title: 'Video 2', url: 'https://youtu.be/v2' },
      ],
    }));
    jest.resetModules();
    const { assignOneProfile } = require('../shuffleEngine.cjs');
    const shuffleFile = {
      settings: { assignmentMode: 'unique' },
      channelConfigs: [{ channelId: 1, channelName: 'Ch', minPerProfile: 1, maxPerProfile: 1 }],
    };
    const first = assignOneProfile({ profileId: 'p1', profileName: 'P1', shuffleFile, watchHistory: {}, usedInThisRun: new Set() });
    expect(first.videos).toHaveLength(1);
    const used = new Set(first.videos.map((v) => v.videoId));
    const second = assignOneProfile({ profileId: 'p2', profileName: 'P2', shuffleFile, watchHistory: {}, usedInThisRun: used });
    expect(second.videos).toHaveLength(1);
    expect(second.videos[0].videoId).not.toBe(first.videos[0].videoId);
  });

  test('server file/history safety source guards are present', () => {
    expect(INDEX_SRC).toContain('atomicWriteJson(SHUFFLE_FILE');
    expect(INDEX_SRC).toContain('normalizeHistoryTitle');
    expect(INDEX_SRC).toContain('WATCH_HISTORY_TTL_MS');
    expect(INDEX_SRC).toContain('usedVideoIds');
  });

  test('VideoShuffle UI exports/imports ad settings and uses Fisher-Yates', () => {
    expect(UI_SRC).toContain('function fisherYatesShuffle');
    expect(UI_SRC).toContain('adSkipEnabled: settings.adSkipEnabled');
    expect(UI_SRC).toContain('adSkipAfterSec: settings.adSkipAfterSec');
    expect(UI_SRC).toContain('midRollAdWaitSec: settings.midRollAdWaitSec');
  });
});
