'use strict';

/**
 * End-to-end YT agent workflow test: profile create → start → 1 video watch → cleanup
 * Usage: node server/scripts/yt-workflow-test.cjs
 */

require('../providers/loadEnv.cjs')();
const path = require('path');
const fs = require('fs');

const SETTINGS_FILE = path.resolve(__dirname, '..', '..', 'user-settings.json');

function hydrateFromEnv() {
  if (process.env.PROXY_PASSWORD) process.env.PROXY_PASSWORD = process.env.PROXY_PASSWORD.trim();
  if (process.env.PROXY_PREFIX) process.env.PROXY_PREFIX = process.env.PROXY_PREFIX.trim();
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    if (!process.env.PROXY_PASSWORD && s.proxyPassword) process.env.PROXY_PASSWORD = s.proxyPassword;
    if (!process.env.PROXY_PREFIX && s.proxyPrefix) process.env.PROXY_PREFIX = s.proxyPrefix;
    if (s.anthropicApiKey) process.env.ANTHROPIC_API_KEY = s.anthropicApiKey;
  } catch {}
}

async function main() {
  hydrateFromEnv();

  console.log('\n━━━ YT Agent Workflow Test ━━━');
  console.log('Proxy prefix:', process.env.PROXY_PREFIX ? `${process.env.PROXY_PREFIX.slice(0, 12)}...` : 'MISSING');
  console.log('Proxy password:', process.env.PROXY_PASSWORD ? 'SET' : 'MISSING');
  console.log('Multilogin folder:', process.env.MULTILOGIN_FOLDER_ID ? 'SET' : 'MISSING');
  console.log('AI key:', process.env.ANTHROPIC_API_KEY ? 'SET' : 'off');

  if (!process.env.PROXY_PASSWORD || !process.env.PROXY_PREFIX) {
    console.error('\n❌ FAIL: Smartproxy credentials empty — fix Settings or .env');
    process.exit(1);
  }

  const { ProfileFactory } = require('../profileFactory.cjs');
  const { getEnabledVideos } = require('../scheduleEngine.cjs');
  const { ProfileAgent } = require('../agent.cjs');

  const videos = getEnabledVideos();
  if (!videos.length) {
    console.error('❌ FAIL: No enabled videos in channels_data.json');
    process.exit(1);
  }
  const video = videos[0];
  console.log(`\nTest video: "${video.title}" (${video.video_id || video.videoId})`);

  const factory = new ProfileFactory({ proxyType: 'smartproxy' });
  const agentName = 'MMB YT TEST 01';
  let profileId = null;

  try {
    console.log('\n[1/4] Creating + starting Multilogin profile...');
    const profileData = await factory.createAndStart(agentName);
    profileId = profileData.profileId;
    console.log(`✅ Profile open — CDP port ${profileData.cdpPort}`);

    console.log('\n[2/4] Connecting Playwright via CDP...');
    const agent = new ProfileAgent(profileId, agentName, profileData.cdpPort, {
      cdpEndpoint: profileData.cdpEndpoint,
      browserType: 'multilogin',
    });
    const connected = await agent.connectWithRetry(12, 4000);
    if (!connected) throw new Error(`CDP connection failed on port ${profileData.cdpPort}`);
    console.log('✅ CDP connected');

    console.log('\n[3/4] Watching video (search + watch)...');
    const config = {
      trafficPreference: 'custom',
      watchTimeMin: 40,
      watchTimeMax: 55,
      likeEnabled: false,
      adSkipEnabled: true,
      agentName,
    };
    const ok = await agent.searchAndWatch(video.title, video.channel_name || '', {
      ...config,
      videoUrl: video.url,
      expectedTitle: video.title,
      videoId: video.video_id || video.videoId,
    });

    console.log('\n[4/4] Cleanup...');
    await agent.disconnect().catch(() => {});
    await factory.stopAndDelete(profileId);
    profileId = null;

    if (ok) {
      console.log('\n✅ SUCCESS — Full workflow completed (profile opened + video watched)');
      process.exit(0);
    }
    console.error('\n⚠️ Profile opened but video watch returned false — check logs above');
    process.exit(2);
  } catch (err) {
    console.error('\n❌ FAIL:', err.message);
    if (profileId) {
      await factory.stopAndDelete(profileId).catch(() => {});
    }
    process.exit(1);
  }
}

main();
