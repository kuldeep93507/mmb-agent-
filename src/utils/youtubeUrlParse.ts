/** Parse YouTube watch / shorts / youtu.be links from pasted text. */

export function parseYoutubeVideoId(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  const m = t.match(/(?:youtube\.com\/watch\?v=|youtube\.com\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

export function toYoutubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export interface ParsedYoutubeVideo {
  videoId: string;
  url: string;
  title: string;
}

/** One line = one video. Title falls back to video id if line is only a URL. */
export function parseYoutubeVideoLines(text: string): ParsedYoutubeVideo[] {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out: ParsedYoutubeVideo[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const videoId = parseYoutubeVideoId(line);
    if (!videoId || seen.has(videoId)) continue;
    seen.add(videoId);
    const url = toYoutubeWatchUrl(videoId);
    const title =
      line.length > 80
        ? line.slice(0, 77) + '…'
        : line.includes('youtube.com') || line.includes('youtu.be')
          ? `Video ${videoId}`
          : line;
    out.push({ videoId, url, title });
  }
  return out;
}

export function isLikelyChannelUrl(input: string): boolean {
  const t = input.trim().toLowerCase();
  if (!t) return false;
  if (parseYoutubeVideoId(t)) return false;
  return (
    t.includes('youtube.com/channel/') ||
    t.includes('youtube.com/@') ||
    t.includes('youtube.com/c/') ||
    t.includes('youtube.com/user/') ||
    /^uc[\w-]{20,}$/i.test(t) ||
    t.startsWith('@')
  );
}
