import { useMemo, useState } from 'react';
import { Tv, Link2, Search, Plus, Trash2, Check } from 'lucide-react';
import type { Channel, Video } from '../../store/useChannelStore';
import { parseYoutubeVideoLines } from '../../utils/youtubeUrlParse';

export type PickableVideo = {
  url: string;
  title: string;
  channelName: string;
  videoId?: string;
  channelId?: number;
};

interface Props {
  channels: Channel[];
  getVideos: (channelId: number, filter?: string) => Video[];
  videos: PickableVideo[];
  onChange: (videos: PickableVideo[]) => void;
}

function toPickable(v: Video, channelName: string, channelId: number): PickableVideo {
  return {
    url: v.url || `https://www.youtube.com/watch?v=${v.video_id}`,
    title: v.title,
    channelName,
    videoId: v.video_id,
    channelId,
  };
}

function dedupeVideos(list: PickableVideo[]): PickableVideo[] {
  const seen = new Set<string>();
  const out: PickableVideo[] = [];
  for (const v of list) {
    const key = v.videoId || v.url;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

export default function ChannelVideoPicker({ channels, getVideos, videos, onChange }: Props) {
  const [mode, setMode] = useState<'channels' | 'paste'>('channels');
  const [selChannels, setSelChannels] = useState<number[]>([]);
  const [activeCh, setActiveCh] = useState<number | null>(null);
  const [videoQ, setVideoQ] = useState('');
  const [paste, setPaste] = useState('');

  const activeChannels = useMemo(
    () => channels.filter(c => c.status === 'active' || c.status === 'syncing'),
    [channels],
  );

  const pickedKeys = useMemo(() => new Set(videos.map(v => v.videoId || v.url)), [videos]);

  const toggleChannel = (id: number) => {
    setSelChannels(prev => {
      const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id];
      if (!next.includes(activeCh ?? -1)) setActiveCh(next[0] ?? null);
      return next;
    });
  };

  const browseChannel = activeCh ?? selChannels[0] ?? activeChannels[0]?.id ?? null;
  const browseName = channels.find(c => c.id === browseChannel)?.channel_name || '';

  const browseVideos = useMemo(() => {
    if (!browseChannel) return [];
    return getVideos(browseChannel, videoQ.trim() || undefined);
  }, [browseChannel, getVideos, videoQ]);

  const addVideo = (v: PickableVideo) => {
    if (pickedKeys.has(v.videoId || v.url)) return;
    onChange(dedupeVideos([...videos, v]));
  };

  const addFromPaste = () => {
    const lines = parseYoutubeVideoLines(paste);
    if (!lines.length) return;
    const added = lines.map(l => ({
      url: l.url,
      title: l.title,
      channelName: '',
      videoId: l.videoId,
    }));
    onChange(dedupeVideos([...videos, ...added]));
    setPaste('');
  };

  const addAllFromSelectedChannels = (limit = 5) => {
    const batch: PickableVideo[] = [];
    for (const cid of selChannels) {
      const ch = channels.find(c => c.id === cid);
      if (!ch) continue;
      const list = getVideos(cid).slice(0, limit);
      list.forEach(v => batch.push(toPickable(v, ch.channel_name, cid)));
    }
    onChange(dedupeVideos([...videos, ...batch]));
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-1 p-1 bg-gray-800/60 rounded-lg border border-gray-800 w-fit">
        <button type="button" onClick={() => setMode('channels')}
          className={`px-3 py-1.5 rounded-md text-xs font-medium flex items-center gap-1.5 ${
            mode === 'channels' ? 'bg-amber-600/30 text-amber-200' : 'text-gray-500'
          }`}>
          <Tv size={13} /> Channels se pick
        </button>
        <button type="button" onClick={() => setMode('paste')}
          className={`px-3 py-1.5 rounded-md text-xs font-medium flex items-center gap-1.5 ${
            mode === 'paste' ? 'bg-amber-600/30 text-amber-200' : 'text-gray-500'
          }`}>
          <Link2 size={13} /> URL paste
        </button>
      </div>

      {mode === 'channels' && (
        <>
          <p className="text-[11px] text-gray-500 leading-relaxed">
            <strong className="text-gray-400">Step 1:</strong> ek ya zyada channels select karo →
            <strong className="text-gray-400"> Step 2:</strong> video click karo.
            Title + channel name save hota hai — notification match ke liye zaroori.
          </p>

          <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto p-2 rounded-xl border border-gray-800 bg-gray-900/40">
            {activeChannels.length === 0 && (
              <span className="text-xs text-gray-600">Pehle Channels page se channel add karo</span>
            )}
            {activeChannels.map(ch => {
              const on = selChannels.includes(ch.id);
              return (
                <button key={ch.id} type="button" onClick={() => toggleChannel(ch.id)}
                  className={`px-2.5 py-1 rounded-lg text-[11px] border truncate max-w-[180px] ${
                    on ? 'border-amber-500/50 bg-amber-900/20 text-amber-100' : 'border-gray-700 text-gray-400 hover:border-gray-500'
                  }`}>
                  {ch.channel_name}
                </button>
              );
            })}
          </div>

          {selChannels.length > 0 && (
            <div className="flex flex-wrap gap-2 items-center">
              <span className="text-[10px] text-gray-500">Browse:</span>
              {selChannels.map(cid => {
                const ch = channels.find(c => c.id === cid);
                return (
                  <button key={cid} type="button" onClick={() => setActiveCh(cid)}
                    className={`text-[10px] px-2 py-0.5 rounded border ${
                      browseChannel === cid ? 'border-purple-500 text-purple-300' : 'border-gray-700 text-gray-500'
                    }`}>
                    {ch?.channel_name || cid}
                  </button>
                );
              })}
              <button type="button" onClick={() => addAllFromSelectedChannels(3)}
                className="text-[10px] text-emerald-400 hover:underline ml-auto">
                + Latest 3 per channel
              </button>
            </div>
          )}

          {browseChannel && (
            <div className="border border-gray-800 rounded-xl overflow-hidden">
              <div className="flex items-center gap-2 p-2 border-b border-gray-800 bg-gray-900/60">
                <Search size={13} className="text-gray-500" />
                <input value={videoQ} onChange={e => setVideoQ(e.target.value)}
                  placeholder={`${browseName} — video search…`}
                  className="flex-1 bg-transparent text-white text-xs outline-none" />
              </div>
              <div className="max-h-48 overflow-y-auto divide-y divide-gray-800/80">
                {browseVideos.slice(0, 40).map(v => {
                  const added = pickedKeys.has(v.video_id);
                  return (
                    <button key={v.video_id} type="button" disabled={added}
                      onClick={() => addVideo(toPickable(v, browseName, browseChannel))}
                      className={`w-full flex items-center gap-2 p-2 text-left ${added ? 'opacity-40' : 'hover:bg-gray-800/50'}`}>
                      <img src={v.thumbnail || `https://i.ytimg.com/vi/${v.video_id}/mqdefault.jpg`} alt=""
                        className="w-14 h-8 rounded object-cover flex-shrink-0 bg-gray-800" />
                      <div className="flex-1 min-w-0">
                        <p className="text-[11px] text-gray-200 truncate">{v.title}</p>
                        <p className="text-[10px] text-gray-600">{browseName}</p>
                      </div>
                      {added ? <Check size={14} className="text-emerald-400" /> : <Plus size={14} className="text-gray-600" />}
                    </button>
                  );
                })}
                {browseVideos.length === 0 && (
                  <p className="p-4 text-xs text-gray-600 text-center">Is channel mein video nahi / sync karo</p>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {mode === 'paste' && (
        <div>
          <textarea value={paste} onChange={e => setPaste(e.target.value)} rows={3}
            placeholder="YouTube URLs — har line ek video"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-xs font-mono" />
          <button type="button" onClick={addFromPaste}
            className="mt-2 text-xs px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-amber-300">
            + URLs add karo
          </button>
          <p className="text-[10px] text-gray-600 mt-1">Backend oEmbed se title/channel bhar lega agar empty ho</p>
        </div>
      )}

      {/* Selected queue */}
      <div className="border border-gray-800 rounded-xl overflow-hidden">
        <div className="px-3 py-2 bg-gray-900/80 border-b border-gray-800 flex justify-between items-center">
          <span className="text-xs text-gray-400 font-medium">Plan videos ({videos.length})</span>
          {videos.length > 0 && (
            <button type="button" onClick={() => onChange([])} className="text-[10px] text-red-400 hover:underline flex items-center gap-1">
              <Trash2 size={11} /> Clear all
            </button>
          )}
        </div>
        <div className="max-h-40 overflow-y-auto divide-y divide-gray-800/60">
          {videos.map((v, i) => (
            <div key={v.videoId || v.url} className="flex items-start gap-2 p-2 text-xs">
              <span className="text-gray-600 font-mono w-5">{i + 1}</span>
              <div className="flex-1 min-w-0">
                <p className="text-gray-200 truncate">{v.title || v.url}</p>
                <p className="text-[10px] text-amber-400/80 truncate">{v.channelName || '— channel unknown'}</p>
              </div>
              <button type="button" onClick={() => onChange(videos.filter((_, j) => j !== i))}
                className="text-gray-600 hover:text-red-400 p-1">×</button>
            </div>
          ))}
          {videos.length === 0 && (
            <p className="p-4 text-center text-gray-600 text-xs">Abhi koi video select nahi</p>
          )}
        </div>
      </div>
    </div>
  );
}
