import { Tv, Target, Clock, Copy } from 'lucide-react';
import type { Channel, Video } from '../../store/useChannelStore';
import ChannelVideoPicker, { type PickableVideo } from '../shared/ChannelVideoPicker';
import type { DemoCampaignVideo } from '../../utils/mastermindDemoTypes';
import { formatDuration } from '../../utils/mastermindSessionTime';

interface Props {
  channels: Channel[];
  getVideos: (channelId: number, filter?: string) => Video[];
  videos: DemoCampaignVideo[];
  onChange: (videos: DemoCampaignVideo[]) => void;
  defaultViewGoal: number;
  onDefaultViewGoalChange?: (n: number) => void;
}

function pickableToCampaign(v: PickableVideo, viewGoal: number, durationSec: number): DemoCampaignVideo {
  return {
    id: v.videoId || v.url,
    url: v.url,
    title: v.title,
    channelName: v.channelName,
    channelId: v.channelId,
    viewGoal,
    durationSec,
  };
}

function lookupDuration(getVideos: (id: number) => Video[], channelId?: number, videoId?: string): number {
  if (!channelId || !videoId) return 600;
  const found = getVideos(channelId).find(v => v.video_id === videoId);
  return found?.duration && found.duration > 0 ? found.duration : 600;
}

export default function CampaignVideosPanel({
  channels, getVideos, videos, onChange, defaultViewGoal, onDefaultViewGoalChange,
}: Props) {
  const pickable: PickableVideo[] = videos.map(v => ({
    url: v.url,
    title: v.title,
    channelName: v.channelName,
    videoId: v.id,
    channelId: v.channelId,
  }));

  const syncFromPicker = (list: PickableVideo[]) => {
    const prev = new Map(videos.map(v => [v.id, v]));
    onChange(list.map(p => {
      const id = p.videoId || p.url;
      const existing = prev.get(id);
      const dur = lookupDuration((cid) => getVideos(cid), p.channelId, p.videoId);
      return pickableToCampaign(p, existing?.viewGoal ?? defaultViewGoal, existing?.durationSec ?? dur);
    }));
  };

  const setGoal = (id: string, viewGoal: number) => {
    onChange(videos.map(v => (v.id === id ? { ...v, viewGoal: Math.max(1, viewGoal) } : v)));
  };

  const applyDefaultToAll = () => {
    onChange(videos.map(v => ({ ...v, viewGoal: defaultViewGoal })));
  };

  const setDuration = (id: string, durationSec: number) => {
    onChange(videos.map(v => (v.id === id ? { ...v, durationSec: Math.max(60, durationSec) } : v)));
  };

  const totalViews = videos.reduce((s, v) => s + v.viewGoal, 0);
  const channelCount = new Set(videos.map(v => v.channelName).filter(Boolean)).size;
  const avgDuration = videos.length
    ? formatDuration(Math.round(videos.reduce((s, v) => s + (v.durationSec || 600), 0) / videos.length))
    : '—';

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <div className="flex items-center gap-2 text-gray-500">
          <Tv size={14} className="text-emerald-400" />
          <span>
            <strong className="text-gray-300">{videos.length}</strong> videos ·
            <strong className="text-gray-300 ml-1">{channelCount}</strong> channels ·
            <strong className="text-amber-400 ml-1">{totalViews.toLocaleString()}</strong> total ·
            avg <strong className="text-gray-400">{avgDuration}</strong>
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-3 ml-auto bg-gray-900/80 border border-amber-800/40 rounded-xl px-4 py-3">
          <Target size={16} className="text-amber-400" />
          <span className="text-sm text-gray-400">Default har video:</span>
          <input
            type="number"
            min={1}
            max={50000}
            value={defaultViewGoal}
            onChange={e => onDefaultViewGoalChange?.(Math.max(1, Number(e.target.value) || 1000))}
            className="w-28 bg-gray-950 border-2 border-gray-600 rounded-lg px-3 py-2 text-white text-right font-mono text-lg font-bold"
          />
          <button type="button" onClick={applyDefaultToAll} disabled={!videos.length}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-amber-900/40 border border-amber-700/50 text-amber-100 text-sm font-semibold hover:bg-amber-900/60 disabled:opacity-40">
            <Copy size={14} /> Sab par apply
          </button>
        </div>
      </div>

      <ChannelVideoPicker channels={channels} getVideos={getVideos} videos={pickable} onChange={syncFromPicker} />

      {videos.length > 0 && (
        <div className="border border-gray-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 bg-gray-900/80 border-b border-gray-800 text-xs text-gray-400 uppercase font-semibold tracking-wide">
            Per-video — lambai (video timing) + view goal
          </div>
          <div className="max-h-[420px] overflow-y-auto divide-y divide-gray-800/60">
            {videos.map(v => (
              <div key={v.id} className="flex flex-wrap items-center gap-4 p-4">
                <div className="flex-1 min-w-[200px]">
                  <p className="text-sm text-gray-100 font-medium truncate">{v.title}</p>
                  <p className="text-xs text-amber-500/80 truncate mt-0.5">{v.channelName || '—'}</p>
                </div>
                <label className="flex flex-col gap-1.5 shrink-0">
                  <span className="text-xs text-gray-400 font-medium">Video lambai</span>
                  <span className="flex items-center gap-2 bg-gray-950 border-2 border-gray-600 rounded-xl px-3 py-2">
                    <Clock size={18} className="text-amber-400 shrink-0" />
                    <input
                      type="text"
                      value={formatDuration(v.durationSec)}
                      onChange={e => {
                        const parts = e.target.value.split(':').map(Number);
                        const sec = parts.length === 2 ? parts[0] * 60 + parts[1] : Number(parts[0]) * 60 || 600;
                        setDuration(v.id, sec);
                      }}
                      className="w-24 bg-transparent text-white font-mono text-xl font-bold text-center outline-none"
                      title="YouTube video kitni lambi hai (8:30)"
                    />
                  </span>
                </label>
                <label className="flex flex-col gap-1.5 shrink-0">
                  <span className="text-xs text-gray-400 font-medium">View goal</span>
                  <input
                    type="number"
                    min={1}
                    max={50000}
                    value={v.viewGoal}
                    onChange={e => setGoal(v.id, Number(e.target.value) || defaultViewGoal)}
                    className="w-28 bg-gray-950 border-2 border-gray-600 rounded-xl px-4 py-2.5 text-white text-right font-mono text-xl font-bold"
                  />
                </label>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
