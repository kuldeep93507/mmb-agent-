'use strict';

/**
 * Server-side Video Shuffle assignment — mirrors VideoShufflePage logic
 * for autonomous 24/7 recycle runs.
 */

const appDataStore = require('./appDataStore.cjs');

const SHUFFLE_HISTORY_MS = 14 * 24 * 60 * 60 * 1000;

const DEFAULT_SETTINGS = {
  assignmentMode: 'unique',
  watchTimeMin: 80,
  watchTimeMax: 100,
  videoQuality: 'auto',
  sameModeManualPicks: {},
  adSkipEnabled: true,
  adSkipAfterSec: 5,
  midRollAdWaitSec: 10,
  warmupEnabled: false,
};

function normalizeWatchTitle(title) {
  return String(title || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function clampWatchRange(min, max) {
  let watchTimeMin = Math.max(1, Math.min(100, Math.round(min)));
  let watchTimeMax = Math.max(1, Math.min(100, Math.round(max)));
  if (watchTimeMin > watchTimeMax) [watchTimeMin, watchTimeMax] = [watchTimeMax, watchTimeMin];
  return { watchTimeMin, watchTimeMax };
}

function normalizeSettings(raw) {
  const merged = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  const picksRaw = merged.sameModeManualPicks;
  const sameModeManualPicks = {};
  if (picksRaw && typeof picksRaw === 'object') {
    for (const [key, val] of Object.entries(picksRaw)) {
      if (typeof val === 'string') sameModeManualPicks[Number(key)] = val;
    }
  }
  return {
    ...merged,
    ...clampWatchRange(Number(merged.watchTimeMin), Number(merged.watchTimeMax)),
    assignmentMode: merged.assignmentMode === 'same-all' ? 'same-all' : 'unique',
    sameModeManualPicks,
    adSkipEnabled: merged.adSkipEnabled !== false,
    adSkipAfterSec: Number.isFinite(Number(merged.adSkipAfterSec)) ? Math.max(0, Math.min(120, Number(merged.adSkipAfterSec))) : 5,
    midRollAdWaitSec: Number.isFinite(Number(merged.midRollAdWaitSec)) ? Math.max(0, Math.min(120, Number(merged.midRollAdWaitSec))) : 10,
    // Warmup is permanently disabled by design. Old shuffle_data.json values are ignored.
    warmupEnabled: false,
  };
}

function buildTitleIndex(watchHistory, profileId) {
  const cutoff = Date.now() - SHUFFLE_HISTORY_MS;
  const rows = (watchHistory[profileId] || []).filter((h) => (h.watchedAt || 0) > cutoff);
  const norms = [];
  for (const h of rows) {
    const title = typeof h.videoTitle === 'string' ? h.videoTitle.trim() : '';
    if (title) norms.push({ norm: normalizeWatchTitle(title), watchedAt: h.watchedAt || 0 });
  }
  return norms;
}

function videoIsWatched(profileId, video, watchHistory) {
  const cutoff = Date.now() - SHUFFLE_HISTORY_MS;
  const list = watchHistory[profileId] || [];
  if (list.some((h) => h.videoId === video.video_id && (h.watchedAt || 0) > cutoff)) return true;
  const n = normalizeWatchTitle(video.title);
  return buildTitleIndex(watchHistory, profileId).some((r) => r.norm === n);
}

function videoLastWatchedAt(profileId, video, watchHistory) {
  const cutoff = Date.now() - SHUFFLE_HISTORY_MS;
  let t = 0;
  for (const h of watchHistory[profileId] || []) {
    if (h.videoId === video.video_id && (h.watchedAt || 0) > cutoff) {
      t = Math.max(t, h.watchedAt || 0);
    }
  }
  const n = normalizeWatchTitle(video.title);
  for (const r of buildTitleIndex(watchHistory, profileId)) {
    if (r.norm === n) t = Math.max(t, r.watchedAt);
  }
  return t;
}


function fisherYatesShuffle(items) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function loadChannelVideoMap() {
  const bundle = appDataStore.getChannelsBundle();
  const channelMap = {};
  for (const ch of bundle.channels || []) {
    channelMap[ch.id] = ch.channel_name || ch.channel_handle || String(ch.id);
  }
  const byChannel = {};
  for (const v of bundle.videos || []) {
    // Skip only unavailable (deleted/private) videos — respect is_enabled only as a soft filter.
    // Fall back to all channel videos if none are explicitly enabled (is_enabled=1).
    if (v.status === 'unavailable') continue;
    const cid = v.channel_id;
    if (!byChannel[cid]) byChannel[cid] = [];
    byChannel[cid].push({
      video_id: v.video_id,
      title: v.title,
      url: v.url,
    });
  }
  return { channelMap, byChannel };
}

function getEnabledVideos(channelId) {
  const { byChannel } = loadChannelVideoMap();
  return byChannel[channelId] || [];
}

function pickUniqueVideosForProfile(profileId, profileName, channelConfigs, watchHistory, usedInThisRun, notices) {
  const profileVideos = [];

  for (const config of channelConfigs) {
    const allChannelVideos = getEnabledVideos(config.channelId);
    if (!allChannelVideos.length) continue;

    const count = Math.floor(Math.random() * (config.maxPerProfile - config.minPerProfile + 1)) + config.minPerProfile;

    let available = allChannelVideos.filter(
      (v) => !videoIsWatched(profileId, v, watchHistory) && !usedInThisRun.has(v.video_id),
    );

    if (available.length < count) {
      if (notices) notices.push(`${profileName}: Pool exhausted for "${config.channelName}" — repeating oldest`);
      const oldestWatched = allChannelVideos
        .filter((v) => !usedInThisRun.has(v.video_id))
        .sort((a, b) => videoLastWatchedAt(profileId, a, watchHistory) - videoLastWatchedAt(profileId, b, watchHistory));
      available = [...new Map([...available, ...oldestWatched].map((v) => [v.video_id, v])).values()];
    }

    const shuffled = fisherYatesShuffle(available);
    let picked = shuffled.slice(0, Math.min(count, shuffled.length));
    if (picked.length < count && shuffled.length > 0) {
      while (picked.length < count) {
        picked = [...picked, ...shuffled.slice(0, count - picked.length)];
      }
    }

    for (const video of picked) {
      usedInThisRun.add(video.video_id);
      profileVideos.push({
        channelId: config.channelId,
        channelName: config.channelName,
        videoId: video.video_id,
        title: video.title,
        url: video.url,
      });
    }
  }

  return profileVideos;
}

function pickSameVideosPerChannel(channelConfigs, watchHistory, allProfileIds, sameModeManualPicks, notices) {
  const shared = [];

  for (const config of channelConfigs) {
    const allChannelVideos = getEnabledVideos(config.channelId);
    if (!allChannelVideos.length) continue;

    const manualPick = sameModeManualPicks[config.channelId] ?? sameModeManualPicks[Number(config.channelId)];
    if (manualPick && manualPick !== 'random') {
      const fixed = allChannelVideos.find((v) => v.video_id === manualPick);
      if (fixed) {
        shared.push({
          channelId: config.channelId,
          channelName: config.channelName,
          videoId: fixed.video_id,
          title: fixed.title,
          url: fixed.url,
        });
        continue;
      }
      if (notices) notices.push(`"${config.channelName}": selected video missing — random pick used`);
    }

    const unwatched = allChannelVideos.filter(
      (v) => !(allProfileIds || []).some((pid) => videoIsWatched(pid, v, watchHistory)),
    );
    if (unwatched.length === 0 && allChannelVideos.length > 0) {
      if (notices) notices.push(`"${config.channelName}": pool exhausted — random repeat`);
    }
    const pickFrom = unwatched.length ? unwatched : allChannelVideos;
    const picked = pickFrom[Math.floor(Math.random() * pickFrom.length)];
    shared.push({
      channelId: config.channelId,
      channelName: config.channelName,
      videoId: picked.video_id,
      title: picked.title,
      url: picked.url,
    });
  }

  return shared;
}

/**
 * Assign videos for one profile using shuffle_data + channels + watch history.
 */
function assignOneProfile(options) {
  const {
    profileId,
    profileName,
    shuffleFile,
    watchHistory,
    allProfileIds = [],
    usedInThisRun = new Set(),
  } = options;

  const settings = normalizeSettings(shuffleFile.settings);
  const channelConfigs = Array.isArray(shuffleFile.channelConfigs) ? shuffleFile.channelConfigs : [];
  const { channelMap } = loadChannelVideoMap();
  const notices = [];

  let videos = [];
  if (settings.assignmentMode === 'same-all') {
    videos = pickSameVideosPerChannel(
      channelConfigs,
      watchHistory,
      allProfileIds.length ? allProfileIds : [profileId],
      settings.sameModeManualPicks,
      notices,
    );
  } else {
    videos = pickUniqueVideosForProfile(
      profileId,
      profileName,
      channelConfigs,
      watchHistory,
      usedInThisRun,
      notices,
    );
  }

  // Fill channel names from server data if missing
  videos = videos.map((v) => ({
    ...v,
    channelName: v.channelName || channelMap[v.channelId] || '',
  }));

  return {
    profileId,
    profileName,
    videos,
    notices,
  };
}

function toScheduleVideo(v) {
  return {
    mode: 'url',
    value: v.url || v.title,
    title: v.title,
    url: v.url,
  };
}

function pickRandomComment() {
  const comments = appDataStore.getComments();
  if (!comments.length) return '';
  const c = comments[Math.floor(Math.random() * comments.length)];
  return (c && c.text) ? String(c.text) : '';
}

function enrichCommentText(cfg) {
  if (!cfg.commentEnabled) return cfg;
  const existing = String(cfg.commentText || '').trim();
  if (existing) return cfg;
  const tid = String(cfg.commentTemplateId || '').trim();
  if (!tid) return cfg;
  const t = appDataStore.getComments().find((x) => x.id === tid);
  if (t && t.text && String(t.text).trim()) return { ...cfg, commentText: String(t.text).trim() };
  return cfg;
}

function buildProfileConfig(profileId, browserType, settings) {
  const stored = appDataStore.getProfileConfig(profileId) || {};
  const { watchTimeMin, watchTimeMax } = clampWatchRange(settings.watchTimeMin, settings.watchTimeMax);
  const cfg = enrichCommentText({
    profileId,
    ...stored,
    browserType: browserType || stored.browserType || 'multilogin',
    watchTimeMin,
    watchTimeMax,
    videoQuality: settings.videoQuality || 'auto',
    adSkipEnabled: settings.adSkipEnabled !== false,
    adSkipAfterSec: settings.adSkipAfterSec ?? 5,
    midRollAdWaitSec: settings.midRollAdWaitSec ?? 10,
    humanEngagementEnabled: true,
    seekForwardMax: 2,
    seekForwardSec: 10,
  });
  return cfg;
}

/**
 * Build orchestrator schedule payload for one recycle slot.
 */
function buildRecycleSchedule(slot, shuffleFile, options = {}) {
  const settings = normalizeSettings(shuffleFile.settings);
  const channelConfigs = Array.isArray(shuffleFile.channelConfigs) ? shuffleFile.channelConfigs : [];
  const assignment = slot.assignment;
  if (!assignment || !assignment.videos.length) {
    throw new Error(`No videos assigned for ${slot.profileName}`);
  }

  const scheduleId = options.scheduleId || `recycle_${slot.slotId}_${Date.now()}`;
  const profileConfig = buildProfileConfig(slot.currentProfileId, slot.browserType, settings);

  const sameForAll = settings.assignmentMode === 'same-all'
    ? channelConfigs.map((config) => ({
        channelId: config.channelId,
        channelName: config.channelName,
        videos: assignment.videos
          .filter((v) => v.channelId === config.channelId)
          .map(toScheduleVideo),
      }))
    : [];

  const perProfile = settings.assignmentMode === 'same-all'
    ? []
    : [{
        profileId: slot.currentProfileId,
        channelSelections: channelConfigs.map((config) => ({
          channelId: config.channelId,
          channelName: config.channelName,
          videos: assignment.videos
            .filter((v) => v.channelId === config.channelId)
            .map(toScheduleVideo),
        })),
      }];

  return {
    id: scheduleId,
    name: `24/7 Recycle: ${slot.profileName}`,
    selectedProfiles: [slot.currentProfileId],
    selectedChannels: channelConfigs.map((c) => c.channelId),
    assignmentMode: settings.assignmentMode === 'same-all' ? 'same-all' : 'per-profile',
    sameForAll,
    perProfile,
    profileConfigs: [profileConfig],
    profileDelayMin: options.profileDelayMin ?? 5,
    profileDelayMax: options.profileDelayMax ?? 15,
    tabDelayMin: options.tabDelayMin ?? 2,
    tabDelayMax: options.tabDelayMax ?? 8,
    commentText: pickRandomComment(),
    runMode: 'manual',
    _recycleSlotId: slot.slotId,
  };
}

module.exports = {
  normalizeSettings,
  assignOneProfile,
  buildRecycleSchedule,
  clampWatchRange,
  fisherYatesShuffle,
};
