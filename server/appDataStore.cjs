/**
 * Server-side persistence for profile configs, comments, and channel library.
 * Replaces browser-only localStorage as source of truth (UI still caches locally).
 */
const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./analyticsStore.cjs');

const ROOT = path.resolve(__dirname, '..');
const FILES = {
  profileConfigs: path.join(ROOT, 'profile_configs_data.json'),
  comments: path.join(ROOT, 'comments_data.json'),
  channels: path.join(ROOT, 'channels_data.json'),
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  try {
    atomicWriteJson(file, data);
    return true;
  } catch (err) {
    console.error('[AppData] Write failed:', file, err.message);
    return false;
  }
}

function getAllProfileConfigs() {
  const raw = readJson(FILES.profileConfigs, {});
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function getProfileConfig(profileId) {
  return getAllProfileConfigs()[profileId] || null;
}

function setProfileConfig(profileId, config) {
  const all = getAllProfileConfigs();
  all[profileId] = config;
  writeJson(FILES.profileConfigs, all);
  return all[profileId];
}

function setAllProfileConfigs(configs) {
  if (!configs || typeof configs !== 'object' || Array.isArray(configs)) return false;
  return writeJson(FILES.profileConfigs, configs);
}

function getComments() {
  const raw = readJson(FILES.comments, []);
  return Array.isArray(raw) ? raw : [];
}

function setComments(list) {
  if (!Array.isArray(list)) return false;
  return writeJson(FILES.comments, list);
}

function getChannelsBundle() {
  const raw = readJson(FILES.channels, { channels: [], videos: [], playlists: [] });
  return {
    channels: Array.isArray(raw.channels) ? raw.channels : [],
    videos: Array.isArray(raw.videos) ? raw.videos : [],
    playlists: Array.isArray(raw.playlists) ? raw.playlists : [],
  };
}

function setChannelsBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') return false;
  return writeJson(FILES.channels, {
    channels: Array.isArray(bundle.channels) ? bundle.channels : [],
    videos: Array.isArray(bundle.videos) ? bundle.videos : [],
    playlists: Array.isArray(bundle.playlists) ? bundle.playlists : [],
  });
}

module.exports = {
  getAllProfileConfigs,
  getProfileConfig,
  setProfileConfig,
  setAllProfileConfigs,
  getComments,
  setComments,
  getChannelsBundle,
  setChannelsBundle,
};
