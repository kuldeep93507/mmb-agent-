'use strict';

/**
 * YouTube viewer personas — stable per profileId
 */

const YT_PERSONAS = [
  {
    name: 'Researcher',
    watchPercentMin: 75,
    watchPercentMax: 95,
    engageChance: 0.4,
    pausePerVideo: 2,
    tabOutChance: 0.05,
    commentStyle: 'long',
    mouseActivity: 'high',
  },
  {
    name: 'Casual',
    watchPercentMin: 55,
    watchPercentMax: 75,
    engageChance: 0.25,
    pausePerVideo: 1,
    tabOutChance: 0.12,
    commentStyle: 'short',
    mouseActivity: 'normal',
  },
  {
    name: 'Skimmer',
    watchPercentMin: 40,
    watchPercentMax: 55,
    engageChance: 0.1,
    pausePerVideo: 0,
    tabOutChance: 0.08,
    commentStyle: 'rare',
    mouseActivity: 'low',
  },
  {
    name: 'DeepDiver',
    watchPercentMin: 85,
    watchPercentMax: 100,
    engageChance: 0.6,
    pausePerVideo: 3,
    tabOutChance: 0.02,
    commentStyle: 'detailed',
    mouseActivity: 'high',
  },
  {
    name: 'MobileUser',
    watchPercentMin: 60,
    watchPercentMax: 85,
    engageChance: 0.3,
    pausePerVideo: 1,
    tabOutChance: 0.15,
    commentStyle: 'emoji',
    mouseActivity: 'normal',
  },
];

function hashProfileSeed(profileId) {
  let h = 0;
  const s = String(profileId || 'default');
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) || 1;
}

function pickPersona(profileId) {
  const idx = hashProfileSeed(profileId) % YT_PERSONAS.length;
  return { ...YT_PERSONAS[idx] };
}

module.exports = { YT_PERSONAS, pickPersona };
