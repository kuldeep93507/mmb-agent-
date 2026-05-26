'use strict';

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.resolve(__dirname, '../agent/VideoWatcher.cjs'), 'utf8');

describe('VideoWatcher timing/playback safety source guards', () => {
  test('watch timer subtracts active/completed paused time', () => {
    expect(SRC).toContain('totalPausedTime');
    expect(SRC).toContain('activePausedElapsed');
    expect(SRC).toMatch(/totalElapsed\s*-\s*totalAdTime\s*-\s*activeAdElapsed\s*-\s*totalPausedTime\s*-\s*activePausedElapsed/);
  });

  test('initial playback is verified before watch timer starts', () => {
    expect(SRC).toContain('verifyPlaybackStarted');
    expect(SRC).toContain('Video playback did not start');
    expect(SRC).toContain('currentTime_advancing');
  });

  test('stall watchdog has resume, reload, and fail-fast paths', () => {
    expect(SRC).toContain('Playback stalled ~30s');
    expect(SRC).toContain('one safe page reload');
    expect(SRC).toContain('Playback stalled for too long after recovery attempts');
  });

  test('ad config normalization preserves zero using nullish-style defaults', () => {
    expect(SRC).toContain('function normalizeAdConfig');
    expect(SRC).toContain('config.adSkipAfterSec, 5');
    expect(SRC).not.toContain('config.adSkipAfterSec || 15');
  });
});
