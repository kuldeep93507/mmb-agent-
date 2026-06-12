import type { Channel, Video } from '../store/useChannelStore';
import type { PickableVideo } from '../components/shared/ChannelVideoPicker';
import type { VideoTarget } from './engagementApi';

export function pickableToVideoTarget(v: PickableVideo, existing?: VideoTarget): VideoTarget {
  return {
    url: v.url,
    title: v.title,
    channelName: v.channelName,
    trafficSource: existing?.trafficSource,
  };
}

export function videoTargetsFromPickable(videos: PickableVideo[], prev: VideoTarget[] = []): VideoTarget[] {
  const byUrl = new Map(prev.map(t => [t.url, t]));
  return videos.map(v => pickableToVideoTarget(v, byUrl.get(v.url)));
}

export function pickableFromVideoTargets(targets: VideoTarget[]): PickableVideo[] {
  return targets.map(t => ({
    url: t.url,
    title: t.title,
    channelName: t.channelName,
  }));
}

export function sameModePicksFromPickable(videos: PickableVideo[]): Record<number, string[]> {
  const out: Record<number, string[]> = {};
  for (const v of videos) {
    if (v.channelId == null || !v.videoId) continue;
    if (!out[v.channelId]) out[v.channelId] = [];
    if (!out[v.channelId].includes(v.videoId)) out[v.channelId].push(v.videoId);
  }
  return out;
}

export function pickableFromSameModePicks(
  picks: Record<number, string | string[]>,
  channels: Channel[],
  getVideos: (channelId: number) => Video[],
): PickableVideo[] {
  const out: PickableVideo[] = [];
  for (const [cidStr, raw] of Object.entries(picks)) {
    if (raw == null || raw === 'random') continue;
    const cid = Number(cidStr);
    const ch = channels.find(c => c.id === cid);
    const ids = Array.isArray(raw) ? raw : [raw];
    const vids = getVideos(cid);
    for (const vid of ids) {
      const v = vids.find(x => x.video_id === vid);
      if (!v) continue;
      out.push({
        url: v.url || `https://www.youtube.com/watch?v=${vid}`,
        title: v.title,
        channelName: ch?.channel_name ?? '',
        videoId: vid,
        channelId: cid,
      });
    }
  }
  return out;
}
