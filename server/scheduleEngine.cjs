'use strict';

/**
 * scheduleEngine — Video assignment for 24/7 MMB YT agents
 */

const fs = require('fs');
const path = require('path');

const CHANNELS_FILE = path.resolve(__dirname, '..', 'channels_data.json');
const HISTORY_FILE = path.resolve(__dirname, '..', 'watch_history.json');
const MS_24H = 24 * 60 * 60 * 1000;

function loadChannelsData() {
  try {
    return JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'));
  } catch {
    return { channels: [], videos: [], playlists: [] };
  }
}

function loadWatchHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function agentHistoryKey(agentName) {
  return `agent:${agentName}`;
}

function wasWatchedRecently(agentName, videoId) {
  if (!agentName || !videoId) return false;
  const history = loadWatchHistory();
  const rows = history[agentHistoryKey(agentName)] || [];
  const cutoff = Date.now() - MS_24H;
  return rows.some(r => r.videoId === videoId && (r.watchedAt || 0) > cutoff);
}

function getEnabledVideos() {
  const data = loadChannelsData();
  const channelMap = {};
  for (const ch of data.channels || []) {
    channelMap[ch.id] = ch.channel_name || ch.channel_handle || '';
  }

  return (data.videos || [])
    .filter(v => v.is_enabled !== false && v.status !== 'unavailable')
    .map(v => ({
      id: v.id,
      videoId: v.video_id || v.videoId || '',
      title: v.title || '',
      url: v.url || '',
      channelName: channelMap[v.channel_id] || '',
      priority: v.priority === 'high' ? 'high' : 'normal',
      mode: 'url',
      value: v.url || v.title,
    }))
    .filter(v => v.url || v.title);
}

function pickSessionVideoCount(min, max) {
  const lo = Math.max(1, Math.min(min, max));
  const hi = Math.max(lo, max);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function assignVideosToAgents(agentNames, options = {}) {
  const pool = getEnabledVideos();
  if (!pool.length) return agentNames.map(name => ({ agentName: name, videos: [] }));

  const minCount = options.videosMin ?? 3;
  const maxCount = options.videosMax ?? 7;
  const high = pool.filter(v => v.priority === 'high');
  const normal = pool.filter(v => v.priority !== 'high');
  const weighted = [...high, ...high, ...shuffle(normal)];

  const assignments = [];

  for (let a = 0; a < agentNames.length; a++) {
    const agentName = agentNames[a];
    const count = pickSessionVideoCount(minCount, maxCount);
    const picked = [];
    const tried = new Set();
    // Offset cursor per agent so parallel agents don't pick identical videos
    let cursor = (agentName.length * 7 + a * 13) % Math.max(1, weighted.length);
    let attempts = 0;

    while (picked.length < count && attempts < weighted.length * 3) {
      const v = weighted[cursor % weighted.length];
      cursor++;
      attempts++;
      const vid = v.videoId || v.url;
      if (!vid || tried.has(vid)) continue;
      tried.add(vid);
      if (wasWatchedRecently(agentName, v.videoId)) continue;
      picked.push({ ...v });
    }

    assignments.push({ agentName, videos: picked });
  }

  return assignments;
}

module.exports = {
  getEnabledVideos,
  pickSessionVideoCount,
  assignVideosToAgents,
  wasWatchedRecently,
  agentHistoryKey,
};
