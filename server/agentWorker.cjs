'use strict';

/**
 * agentWorker.cjs — Isolated child process per MMB YT AGENT
 */

require('./providers/loadEnv.cjs')();

const { ProfileAgent } = require('./agent.cjs');
const { buildAgentConfig } = require('./agentBrain.cjs');
const { recoverProfile } = require('./profileRecovery.cjs');

function ipc(msg) {
  if (process.send) process.send(msg);
}

function log(level, message) {
  ipc({ type: 'log', level, message, ts: Date.now() });
  console.log(`[${level.toUpperCase()}] ${message}`);
}

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function runVideoSession(agent, videos, config) {
  const results = { watched: 0, failed: 0, videos: [] };

  for (let i = 0; i < videos.length; i++) {
    const video = videos[i];
    const videoUrl = video.url || (video.mode === 'url' ? video.value : '');
    const videoTitle = video.title || (video.mode === 'title' ? video.value : '') || video.value || '';
    const videoId = video.videoId || (() => {
      const m = String(videoUrl).match(/(?:v=|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
      return m ? m[1] : '';
    })();

    ipc({
      type: 'progress',
      videoIndex: i,
      totalVideos: videos.length,
      title: videoTitle,
      url: videoUrl,
      ts: Date.now(),
    });

    log('info', `Video ${i + 1}/${videos.length}: "${videoTitle}"`);

    const watchConfig = {
      ...config,
      videoUrl: video.targetYoutubeUrl || video.youtubeUrl || videoUrl || config.videoUrl || '',
      channelName: video.channelName || config.channelName || '',
      expectedTitle: videoTitle,
      videoId,
      browserType: 'multilogin',
    };

    let success = false;
    try {
      agent._videoIndex = i;
      const trafficPref = (config.trafficPreference || 'custom').toLowerCase();
      if (trafficPref === 'direct' && watchConfig.videoUrl) {
        success = await agent.watchByUrl(watchConfig.videoUrl, watchConfig);
      } else {
        success = await agent.searchAndWatch(videoTitle, video.channelName || '', watchConfig);
      }
    } catch (err) {
      log('error', `Video failed: ${err.message}`);
    }

    if (success) {
      results.watched++;
      results.videos.push({ title: videoTitle, videoId, status: 'watched' });
      ipc({ type: 'video_done', videoId, videoTitle, agentName: config.agentName });
    } else {
      results.failed++;
      results.videos.push({ title: videoTitle, status: 'failed' });
    }

    if (i < videos.length - 1) {
      const tabDelay = randomDelay((config.tabDelayMin || 30) * 1000, (config.tabDelayMax || 120) * 1000);
      await sleep(tabDelay);
    }
  }

  return results;
}

process.on('message', async (msg) => {
  if (msg.type !== 'start') return;

  const { agentId, agentName, profileId, cdpPort, cdpEndpoint, videos, settings, envVars } = msg;

  if (envVars) {
    for (const [k, v] of Object.entries(envVars)) {
      if (v) process.env[k] = v;
    }
  }

  log('info', `${agentName} worker started — ${videos.length} videos on CDP:${cdpPort}`);

  let agent = null;

  try {
    const config = buildAgentConfig(settings || {}, settings || {});
    config.agentName = agentName;
    config.sessionVideoCount = videos.length;

    agent = new ProfileAgent(profileId, agentName, cdpPort, {
      cdpEndpoint,
      onLog: (level, message) => log(level, message),
      onRecoverProfile: async ({ profileId: pid, strategy, profileName: pname }) => {
        log('warn', `YouTube block — recovery: ${strategy}`);
        return recoverProfile({
          browserType: 'multilogin',
          profileId: pid,
          profileName: pname || agentName,
          strategy,
          log: (level, message) => log(level, message),
        });
      },
    });

    const connected = await agent.connectWithRetry(12, 4000);
    if (!connected) throw new Error(`CDP connection failed on port ${cdpPort}`);

    const results = await runVideoSession(agent, videos, config);
    await agent.disconnect();

    ipc({
      type: 'done',
      agentId,
      agentName,
      profileId,
      videosWatched: results.watched,
      videosFailed: results.failed,
      results,
      ts: Date.now(),
    });
  } catch (err) {
    log('error', `${agentName} fatal: ${err.message}`);
    if (agent) await agent.disconnect().catch(() => {});
    ipc({
      type: 'error',
      agentId,
      agentName,
      profileId,
      error: err.message,
      ts: Date.now(),
    });
  } finally {
    process.exit(0);
  }
});

process.on('uncaughtException', (err) => {
  ipc({ type: 'error', error: `Uncaught: ${err.message}`, ts: Date.now() });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  ipc({ type: 'error', error: `Unhandled: ${String(reason)}`, ts: Date.now() });
  process.exit(1);
});

ipc({ type: 'ready' });
