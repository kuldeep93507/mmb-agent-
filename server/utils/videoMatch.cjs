'use strict';

/**
 * Shared title/channel scoring for search results — extracted to break circular
 * dependency between searchEngine.cjs ↔ agentBrain.cjs.
 */

// Must match escalation logic elsewhere (searchEngine).
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'in', 'on', 'at', 'to', 'for', 'of',
  'with', 'by', 'from', 'and', 'or', 'but', 'not', 'this', 'that', 'it', 'its',
  'how', 'what', 'which', 'who', 'when', 'where', 'why', 'do', 'does', 'did',
  'will', 'would', 'could', 'should', 'can', 'may', 'might',
  'you', 'your', 'my', 'our', 'their', 'his', 'her',
]);

function cleanChannelLabel(channel) {
  return String(channel || '').replace(/\s+/g, ' ').trim();
}

/** Word-level verification before clicking a video result card. */
function verifyVideoMatch(
  resultTitle,
  resultChannel,
  resultDuration,
  expectedTitle,
  expectedChannel,
  expectedDuration,
) {
  const expectedWords = expectedTitle.toLowerCase().split(/\s+/).filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  const resultWords = resultTitle.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const matchedWords = expectedWords.filter((w) => resultWords.some((rw) => rw.includes(w) || w.includes(rw)));
  const titleMatchPercent = expectedWords.length > 0 ? matchedWords.length / expectedWords.length : 0;

  let score = 0;
  if (titleMatchPercent >= 0.65) score += 55;
  else if (titleMatchPercent >= 0.5) score += 42;
  else if (titleMatchPercent >= 0.4) score += 28;
  else return { score, titleMatchPercent, isMatch: false };

  const needChannel = !!(expectedChannel && String(expectedChannel).trim());
  let channelOk = !needChannel;

  if (needChannel && resultChannel) {
    const expCh = expectedChannel.toLowerCase().trim();
    const resCh = resultChannel.toLowerCase().trim();
    if (resCh.includes(expCh) || expCh.includes(resCh)) {
      score += 35;
      channelOk = true;
    } else {
      const expParts = expCh.split(/\s+/).filter((w) => w.length > 2);
      const resParts = resCh.split(/\s+/).filter((w) => w.length > 2);
      const chRatio = expParts.length > 0
        ? expParts.filter((w) => resParts.some((r) => r.includes(w) || w.includes(r))).length / expParts.length
        : 0;
      if (chRatio >= 0.6) {
        score += 28;
        channelOk = true;
      }
    }
  }

  if (expectedDuration > 0 && resultDuration > 0) {
    const diff = Math.abs(expectedDuration - resultDuration);
    if (diff < 10) score += 15;
    else if (diff < 30) score += 8;
  }

  const isMatch = needChannel
    // Channel provided: must match channel + 45% title + score 62
    ? (channelOk && titleMatchPercent >= 0.45 && score >= 62)
    // No channel given: require very high title match (80%) to avoid wrong-video clicks
    // Best practice: always provide channelName in schedule for 100% accuracy
    : (titleMatchPercent >= 0.80 && score >= 55);

  return { score, titleMatchPercent, isMatch };
}

/** Parse duration text like "12:34" or "1:02:34" to seconds */
function parseDurationText(text) {
  if (!text) return 0;
  const parts = String(text).trim().split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

module.exports = {
  STOP_WORDS,
  cleanChannelLabel,
  verifyVideoMatch,
  parseDurationText,
};
