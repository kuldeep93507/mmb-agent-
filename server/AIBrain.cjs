'use strict';

/**
 * AIBrain — Claude decisions for YouTube watching (falls back if no API key)
 */

const https = require('https');

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 180;
const TIMEOUT_MS = 12000;
const MAX_CALLS_PER_SESSION = 50;

class AIBrain {
  constructor(profileId, personaName) {
    this.profileId = profileId;
    this.personaName = personaName || 'Casual';
    this.apiKey = process.env.ANTHROPIC_API_KEY || '';
    this.enabled = !!this.apiKey;
    this.callCount = 0;
    this.sessionHistory = [];
  }

  async _call(systemPrompt, userMessage) {
    if (!this.enabled || this.callCount >= MAX_CALLS_PER_SESSION) return null;

    const body = JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    return new Promise((resolve) => {
      const req = https.request({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: TIMEOUT_MS,
      }, (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try {
            const j = JSON.parse(data);
            resolve(j.content?.[0]?.text?.trim() || null);
          } catch {
            resolve(null);
          }
        });
      });

      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.write(body);
      req.end();
      this.callCount++;
    });
  }

  /** Natural YouTube search query — must differ from previous queries in session */
  async decideYouTubeSearchQuery(videoTitle, channelName = '', avoidQueries = '') {
    const system = `You are a ${this.personaName} viewer on YouTube. Generate a UNIQUE natural search query (max 6 words) a real person would type to find this video. Reply with ONLY the query. No quotes.
Previous queries this session (DO NOT repeat or rephrase similarly): ${avoidQueries || 'none'}`;
    const user = `Video: "${videoTitle}"${channelName ? ` by ${channelName}` : ''}`;
    return await this._call(system, user);
  }

  /** Watch percentage 40-100 based on video length and session context */
  async decideWatchPercent(videoTitle, durationSec, videoIndex = 0) {
    const system = `You are a ${this.personaName} YouTube viewer. Decide what % of the video to watch. Reply with ONLY an integer 40-100. Short videos (<5min): often 80-100. Long (>15min): often 40-70.`;
    const user = `Video ${videoIndex + 1} in session: "${videoTitle}", length ${durationSec}s.`;
    const result = await this._call(system, user);
    const n = parseInt(result, 10);
    if (!Number.isFinite(n) || n < 40 || n > 100) return null;
    return n;
  }

  /** Traffic source for next video */
  async decideTrafficSource(videoTitle, previousSource = '') {
    const system = `You are a ${this.personaName} viewer. Pick how you found this video. Reply with ONLY one word: search, direct, homepage, suggested, google`;
    const user = `Opening "${videoTitle}". Previous source: ${previousSource || 'none'}.`;
    const result = (await this._call(system, user))?.toLowerCase();
    const valid = ['search', 'direct', 'homepage', 'suggested', 'google'];
    return valid.includes(result) ? result : null;
  }

  /** Like / comment / subscribe decision at watch progress */
  async decideEngagement(action, watchProgress, videoTitle) {
    const system = `You are a ${this.personaName} viewer at ${Math.round(watchProgress * 100)}% of a video. Should you ${action}? Reply ONLY yes or no.`;
    const user = `Video: "${videoTitle}"`;
    const result = (await this._call(system, user))?.toLowerCase();
    if (result === 'yes') return true;
    if (result === 'no') return false;
    return null;
  }

  /** Natural comment text */
  async generateComment(videoTitle, channelName = '') {
    const system = `You are a ${this.personaName} YouTube viewer. Write ONE short authentic comment (max 120 chars). No spam. No generic "nice video".`;
    const user = `Video: "${videoTitle}"${channelName ? ` by ${channelName}` : ''}`;
    const result = await this._call(system, user);
    if (!result || result.length > 200) return null;
    return result.replace(/^["']|["']$/g, '');
  }

  /** Per-video unique behavior knobs */
  async decideVideoBehavior(videoTitle, videoIndex, sessionCount) {
    const system = `You are a ${this.personaName} viewer. Reply ONLY JSON: {"pauseCount":0-2,"scrollComments":true|false,"mouseActivity":"low|normal|high","quality":"auto|360p|480p"}`;
    const user = `Video ${videoIndex + 1}/${sessionCount}: "${videoTitle}" — unique behavior.`;
    const result = await this._call(system, user);
    try {
      return JSON.parse(result);
    } catch {
      return null;
    }
  }

  addHistory(action, title) {
    this.sessionHistory.push({ action, title });
    if (this.sessionHistory.length > 8) this.sessionHistory.shift();
  }

  isEnabled() { return this.enabled; }
  resetSession() { this.callCount = 0; this.sessionHistory = []; }
}

module.exports = { AIBrain };
