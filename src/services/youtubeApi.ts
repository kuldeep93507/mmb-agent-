/**
 * YouTube Channel Data Service
 * Uses YouTube InnerTube private API (no API key needed)
 * Gets ALL videos from a channel (not limited to 15 like RSS)
 */

export interface YouTubeVideo {
  videoId: string;
  title: string;
  url: string;
  thumbnail: string;
  publishedAt: number;
  updatedAt: number;
  views: number;
  likes: number;
  description: string;
  duration: string;
}

export interface YouTubeChannelData {
  channelId: string;
  channelName: string;
  channelUrl: string;
  publishedAt: number;
  subscriberCount: number;
  videos: YouTubeVideo[];
}

/**
 * Fetch ALL channel videos using YouTube InnerTube API via Vite proxy.
 * Accepts UC channel IDs (UCxxxxxx) OR @handles OR full YouTube URLs.
 */
export async function fetchChannelFromRSS(channelId: string): Promise<YouTubeChannelData> {
  // Resolve YouTube URL to channel ID / handle
  const resolved = resolveChannelInput(channelId);

  const res = await fetch(`/youtube-feed?channel_id=${encodeURIComponent(resolved)}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch channel data: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return parseInnerTubeResponse(data, resolved);
}

/**
 * Normalise any user-pasted input to the form InnerTube accepts:
 *   - "UCxxxxxxxxxxxxxxxxxxxxxx"  → returned as-is
 *   - "@handle" / "youtube.com/@handle" → "@handle"
 *   - "youtube.com/channel/UC…" → "UCxxxxxx"
 *   - bare "handle" (no @)       → "@handle"
 */
export function resolveChannelInput(input: string): string {
  const t = input.trim();
  if (!t) return t;

  // Already a UC ID
  if (/^UC[\w-]{22}$/.test(t)) return t;

  // Bare @handle
  if (/^@[\w.-]+$/.test(t)) return t;

  // Full URL
  const withProto = /^https?:\/\//i.test(t) ? t : `https://${t}`;
  try {
    const u = new URL(withProto);
    const host = u.hostname.replace(/^(www\.|m\.)/i, '');
    if (host !== 'youtube.com') return t; // not YT — pass through, let InnerTube fail

    const path = u.pathname.replace(/\/+$/, '');

    // /channel/UCxxxx
    const ucMatch = path.match(/^\/channel\/(UC[\w-]{22})$/i);
    if (ucMatch) return ucMatch[1];

    // /@handle
    const handleMatch = path.match(/^\/@([\w.-]+)$/);
    if (handleMatch) return `@${handleMatch[1]}`;

    // /c/customname or /user/username → @-prefix so InnerTube resolves it
    const legacyMatch = path.match(/^\/(?:c|user)\/([\w.-]+)$/i);
    if (legacyMatch) return `@${legacyMatch[1]}`;
  } catch { /* ignore */ }

  // Fallback: treat bare word as handle
  return t.startsWith('@') ? t : `@${t}`;
}

/**
 * Parse YouTube InnerTube browse response.
 * Extracts the real UC channel ID from metadata (important when input was @handle).
 */
function parseInnerTubeResponse(data: any, inputId: string): YouTubeChannelData {
  const metadata = data.metadata?.channelMetadataRenderer;
  const header   = data.header?.c4TabbedHeaderRenderer;

  // Real UC ID from InnerTube response — always prefer this over the input
  const realChannelId: string =
    metadata?.externalId ||
    header?.channelId ||
    inputId;

  const channelName = metadata?.title || header?.title || 'Unknown Channel';
  const channelUrl  = `https://www.youtube.com/channel/${realChannelId}`;
  const channelId   = realChannelId;

  // Subscriber count — InnerTube returns it in several possible paths
  const subText: string =
    header?.subscriberCountText?.simpleText ||
    header?.subscriberCountText?.runs?.[0]?.text ||
    metadata?.description?.match(/(\d[\d.,KMB]*)\s+subscriber/i)?.[1] ||
    '0';
  const subscriberCount = parseSubscriberCount(subText);

  // Find the Videos tab
  const tabs = data.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
  const videosTab = tabs.find((t: any) => t.tabRenderer?.title === 'Videos');

  const videos: YouTubeVideo[] = [];

  if (videosTab) {
    const contents = videosTab.tabRenderer?.content?.richGridRenderer?.contents || [];

    for (const item of contents) {
      const content = item.richItemRenderer?.content;
      if (!content) continue;

      // ── Format A: old videoRenderer ──────────────────────────────────────
      if (content.videoRenderer) {
        const vr = content.videoRenderer;
        const videoId = vr.videoId;
        if (!videoId) continue;
        const title         = vr.title?.runs?.[0]?.text || '';
        const viewCountText = vr.viewCountText?.simpleText || vr.viewCountText?.runs?.[0]?.text || '0';
        const views         = parseViewCount(viewCountText);
        const publishedText = vr.publishedTimeText?.simpleText || '';
        const publishedAt   = parseRelativeTime(publishedText);
        const duration      = vr.lengthText?.simpleText || '0:00';
        const thumbnails    = vr.thumbnail?.thumbnails || [];
        const thumbnail     = thumbnails[thumbnails.length - 1]?.url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
        videos.push({ videoId, title, url: `https://www.youtube.com/watch?v=${videoId}`, thumbnail, publishedAt, updatedAt: publishedAt, views, likes: 0, description: '', duration });
        continue;
      }

      // ── Format B: new lockupViewModel (2024+) ────────────────────────────
      if (content.lockupViewModel) {
        const lvm    = content.lockupViewModel;
        const videoId: string = lvm.contentId || '';
        if (!videoId) continue;

        const meta   = lvm.metadata?.lockupMetadataViewModel;
        const title  = meta?.title?.content || '';

        // Views & published time from metadataRows
        const parts  = meta?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts || [];
        const viewCountText = parts[0]?.text?.content || '0';
        const publishedText = parts[1]?.text?.content || '';
        const views         = parseViewCount(viewCountText);
        const publishedAt   = parseRelativeTime(publishedText);

        // Duration from thumbnail overlay badge
        const overlays  = lvm.contentImage?.thumbnailViewModel?.overlays || [];
        const badge     = overlays[0]?.thumbnailBottomOverlayViewModel?.badges?.[0]?.thumbnailBadgeViewModel;
        const duration  = badge?.text || '0:00';

        // Thumbnail — take highest-res source
        const sources   = lvm.contentImage?.thumbnailViewModel?.image?.sources || [];
        const thumbnail = sources[sources.length - 1]?.url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

        videos.push({ videoId, title, url: `https://www.youtube.com/watch?v=${videoId}`, thumbnail, publishedAt, updatedAt: publishedAt, views, likes: 0, description: '', duration });
        continue;
      }
    }
  }
  
  return {
    channelId,
    channelName,
    channelUrl,
    publishedAt: Date.now(),
    subscriberCount,
    videos,
  };
}

/**
 * Parse subscriber count from text like "1.2M subscribers", "45.3K", "823"
 */
function parseSubscriberCount(text: string): number {
  if (!text) return 0;
  const t = text.replace(/,/g, '').replace(/subscribers?/gi, '').trim();
  const lower = t.toLowerCase();
  if (/b/i.test(lower)) return Math.round(parseFloat(lower) * 1_000_000_000);
  if (/m/i.test(lower)) return Math.round(parseFloat(lower) * 1_000_000);
  if (/k/i.test(lower)) return Math.round(parseFloat(lower) * 1_000);
  const n = parseInt(t.replace(/\D/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

/**
 * Parse view count from text like "1,234 views" or "1.2K views"
 */
function parseViewCount(text: string): number {
  if (!text) return 0;

  let t = text.replace(/,/g, '').trim();
  t = t.replace(/\s+views\b/gi, '').trim();

  const lower = t.toLowerCase();
  if (/k\b/i.test(lower)) {
    const n = parseFloat(lower.replace(/k.*$/i, ''));
    return Number.isFinite(n) ? Math.round(n * 1000) : 0;
  }
  if (/m\b/i.test(lower)) {
    const n = parseFloat(lower.replace(/m.*$/i, ''));
    return Number.isFinite(n) ? Math.round(n * 1_000_000) : 0;
  }
  if (/b\b/i.test(lower)) {
    const n = parseFloat(lower.replace(/b.*$/i, ''));
    return Number.isFinite(n) ? Math.round(n * 1_000_000_000) : 0;
  }

  const num = Number.parseInt(t.replace(/[^\d.]/g, ''), 10);
  return Number.isFinite(num) && !Number.isNaN(num) ? num : 0;
}

/**
 * Parse relative time like "2 weeks ago", "3 months ago" to timestamp
 */
function parseRelativeTime(text: string): number {
  if (!text) return Date.now();
  
  const now = Date.now();
  const lower = text.toLowerCase();
  
  const match = lower.match(/(\d+)\s+(second|minute|hour|day|week|month|year)/);
  if (!match) return now;
  
  const amount = parseInt(match[1], 10);
  const unit = match[2];
  
  const msMap: Record<string, number> = {
    second: 1000,
    minute: 60 * 1000,
    hour: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
    year: 365 * 24 * 60 * 60 * 1000,
  };
  
  return now - (amount * (msMap[unit] || 0));
}


/**
 * Fetch videos from a YouTube playlist
 */
export async function fetchPlaylistVideos(playlistId: string): Promise<YouTubeVideo[]> {
  const res = await fetch(`/youtube-playlist?list=${playlistId}`);
  if (!res.ok) throw new Error('Failed to fetch playlist');
  
  const data = await res.json();
  const videos: YouTubeVideo[] = [];
  
  // Parse InnerTube playlist response
  const contents = data.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents?.[0]?.playlistVideoListRenderer?.contents || [];
  
  for (const item of contents) {
    const renderer = item.playlistVideoRenderer;
    if (!renderer) continue;
    
    const videoId = renderer.videoId;
    const title = renderer.title?.runs?.[0]?.text || '';
    const lengthText = renderer.lengthText?.simpleText || '0:00';
    
    if (videoId && title) {
      videos.push({
        videoId,
        title,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        publishedAt: Date.now(),
        updatedAt: Date.now(),
        views: 0,
        likes: 0,
        description: '',
        duration: lengthText,
      });
    }
  }
  
  return videos;
}
