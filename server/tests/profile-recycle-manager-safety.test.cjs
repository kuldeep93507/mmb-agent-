'use strict';

const fs = require('fs');
const path = require('path');
const { ProfileRecycleManager } = require('../profileRecycleManager.cjs');
const appDataStore = require('../appDataStore.cjs');

const ROOT = path.resolve(__dirname, '../..');
const RECYCLE_FILE = path.join(ROOT, 'recycle_state.json');
const PROFILE_CONFIGS_FILE = path.join(ROOT, 'profile_configs_data.json');

function cleanupFiles() {
  for (const file of [RECYCLE_FILE, PROFILE_CONFIGS_FILE]) {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }
}

function deps(overrides = {}) {
  const logs = [];
  return {
    orchestrator: {
      getWorkerStatus: () => null,
      stopWorker: jest.fn(),
      runSchedule: jest.fn(),
    },
    getMaxConcurrent: () => 0, // force queued, avoid real schedule/shuffle run in unit tests
    getRunningCount: () => 0,
    runningSchedules: new Map(),
    getWatchHistory: () => ({}),
    loadShuffleFile: () => ({ settings: {}, channelConfigs: [] }),
    activityLog: { append: (x) => logs.push(x) },
    notificationService: { info: jest.fn(() => Promise.resolve()), warning: jest.fn(() => Promise.resolve()) },
    _logs: logs,
    ...overrides,
  };
}

function shutdown(mgr) {
  if (!mgr) return;
  if (mgr._queueTimer) clearInterval(mgr._queueTimer);
  for (const t of mgr._timers.values()) clearTimeout(t);
  mgr._timers.clear();
}

describe('ProfileRecycleManager safety fixes', () => {
  beforeEach(() => cleanupFiles());
  afterEach(() => cleanupFiles());

  test('start() uses profileId slot IDs and removes old unselected slots', async () => {
    const d = deps();
    const mgr = new ProfileRecycleManager(d);
    try {
      mgr.slots.set('Old Same Name', {
        slotId: 'Old Same Name', profileName: 'Old Same Name', currentProfileId: 'old-profile', enabled: true, status: 'idle',
      });
      mgr.profileToSlot.set('old-profile', 'Old Same Name');

      await mgr.start({
        profiles: [
          { id: 'profile-a', name: 'Same Name', browserType: 'multilogin', os: 'Windows' },
          { id: 'profile-b', name: 'Same Name', browserType: 'multilogin', os: 'Windows' },
        ],
        cooldownMinMinutes: 1,
        cooldownMaxMinutes: 2,
      });

      expect(mgr.slots.has('profile-a')).toBe(true);
      expect(mgr.slots.has('profile-b')).toBe(true);
      expect(mgr.slots.has('Old Same Name')).toBe(false);
      expect(mgr.profileToSlot.get('profile-a')).toBe('profile-a');
      expect(mgr.profileToSlot.get('profile-b')).toBe('profile-b');
      expect(mgr.profileToSlot.has('old-profile')).toBe(false);
    } finally {
      shutdown(mgr);
    }
  });

  test('pause/resume does not route through cooldown/recreate', async () => {
    const d = deps();
    const mgr = new ProfileRecycleManager(d);
    try {
      await mgr.start({
        profiles: [{ id: 'profile-a', name: 'A', browserType: 'multilogin', os: 'Windows' }],
        cooldownMinMinutes: 1,
        cooldownMaxMinutes: 2,
      });
      mgr.pause();
      expect(mgr.slots.get('profile-a').status).toBe('paused');
      expect(mgr.slots.get('profile-a').cooldownUntil).toBe(null);

      mgr.resume();
      const status = mgr.slots.get('profile-a').status;
      expect(status).not.toBe('cooldown');
      expect(status).not.toBe('recreating');
    } finally {
      shutdown(mgr);
    }
  });

  test('protected profile sign-in wall becomes needs_attention instead of recreate', async () => {
    const d = deps();
    const mgr = new ProfileRecycleManager(d);
    try {
      appDataStore.setProfileConfig('profile-protected', { profileId: 'profile-protected', doNotRecreate: true });
      await mgr.start({
        profiles: [{ id: 'profile-protected', name: 'Protected', browserType: 'multilogin', os: 'Windows' }],
        cooldownMinMinutes: 1,
        cooldownMaxMinutes: 2,
      });
      mgr.immediateRecreate('profile-protected');
      const slot = mgr.slots.get('profile-protected');
      expect(slot.status).toBe('needs_attention');
      expect(slot.isPaused).toBe(true);
      expect(slot.lastError).toMatch(/recreate skipped/i);
    } finally {
      shutdown(mgr);
    }
  });
});
