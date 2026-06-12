import { useState, useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { Profile } from '../../types';
import type { Channel, Video } from '../../store/useChannelStore';
import {
  extractVideoIdFromEntry,
  shouldSkipVideoToday,
  type WatchHistoryEntry,
} from '../../utils/watchHistorySchedule';

export type VideoEntry = { mode: 'title' | 'url'; value: string; title?: string; url?: string };

export interface Step2Schedule {
  assignmentMode: 'same-all' | 'per-profile';
  selectedProfiles: string[];
  selectedChannels: number[];
  sameForAll: { channelId: number; channelName: string; videos: VideoEntry[] }[];
  perProfile: { profileId: string; channelSelections: { channelId: number; channelName: string; videos: VideoEntry[] }[] }[];
}

function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function parseYoutubeUrls(text: string): { title: string; url: string }[] {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out: { title: string; url: string }[] = [];
  for (const line of lines) {
    const m = line.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    if (m) {
      const url = `https://www.youtube.com/watch?v=${m[1]}`;
      out.push({ title: line.length > 60 ? line.slice(0, 57) + '…' : line, url });
    } else if (line.startsWith('http')) {
      out.push({ title: line, url: line });
    }
  }
  return out;
}

export default function Step2Videos({ schedule, profiles, channels, getVideos, onChange, watchHistoryByProfile, allowSameDayRepeat }: {
  schedule: Step2Schedule;
  profiles: Profile[];
  channels: Channel[];
  getVideos: (channelId: number, filter?: string) => Video[];
  onChange: (s: Step2Schedule) => void;
  watchHistoryByProfile?: Record<string, WatchHistoryEntry[]>;
  allowSameDayRepeat?: boolean;
}) {
  const selectedChannels = channels.filter(c => schedule.selectedChannels.includes(c.id));
  const [activeProfileId, setActiveProfileId] = useState(schedule.selectedProfiles[0] || '');
  const [videoSearch, setVideoSearch] = useState<Record<number, string>>({});
  const [pasteUrls, setPasteUrls] = useState<Record<number, string>>({});

  useEffect(() => {
    if (schedule.assignmentMode !== 'per-profile') return;
    const existing = new Set(schedule.perProfile.map(p => p.profileId));
    const missing = schedule.selectedProfiles.filter(id => !existing.has(id));
    if (!missing.length) return;
    onChange({
      ...schedule,
      perProfile: [
        ...schedule.perProfile,
        ...missing.map(profileId => ({
          profileId,
          channelSelections: schedule.selectedChannels.map(chId => ({
            channelId: chId,
            channelName: channels.find(c => c.id === chId)?.channel_name || '',
            videos: [] as VideoEntry[],
          })),
        })),
      ],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only seed missing per-profile rows
  }, [schedule.assignmentMode, schedule.selectedProfiles.join(','), schedule.selectedChannels.join(','), channels.length]);

  useEffect(() => {
    if (schedule.assignmentMode === 'per-profile' && schedule.selectedProfiles.length && !schedule.selectedProfiles.includes(activeProfileId)) {
      setActiveProfileId(schedule.selectedProfiles[0]);
    }
  }, [schedule.selectedProfiles, schedule.assignmentMode, activeProfileId]);

  const makeEntry = (title: string, url?: string): VideoEntry =>
    url ? { mode: 'url', value: url, title, url } : { mode: 'title', value: title, title };

  const addVideoSameAll = (channelId: number, title: string, url?: string) => {
    if (!title.trim()) return;
    const channelName = channels.find(c => c.id === channelId)?.channel_name || '';
    const entry = makeEntry(title, url);
    const existing = schedule.sameForAll.find(s => s.channelId === channelId);
    if (existing) {
      if (existing.videos.some(v => v.value === entry.value || v.title === title)) return;
      onChange({
        ...schedule,
        sameForAll: schedule.sameForAll.map(s => s.channelId === channelId ? { ...s, videos: [...s.videos, entry] } : s),
      });
    } else {
      onChange({ ...schedule, sameForAll: [...schedule.sameForAll, { channelId, channelName, videos: [entry] }] });
    }
  };

  const addVideoPerProfile = (profileId: string, channelId: number, title: string, url?: string) => {
    if (!title.trim()) return;
    const entry = makeEntry(title, url);
    onChange({
      ...schedule,
      perProfile: schedule.perProfile.map(p => {
        if (p.profileId !== profileId) return p;
        const cs = p.channelSelections.find(c => c.channelId === channelId);
        if (cs) {
          if (cs.videos.some(v => v.value === entry.value)) return p;
          return {
            ...p,
            channelSelections: p.channelSelections.map(c =>
              c.channelId === channelId ? { ...c, videos: [...c.videos, entry] } : c,
            ),
          };
        }
        return {
          ...p,
          channelSelections: [...p.channelSelections, {
            channelId,
            channelName: channels.find(c => c.id === channelId)?.channel_name || '',
            videos: [entry],
          }],
        };
      }),
    });
  };

  const removeVideoSameAll = (channelId: number, index: number) => {
    onChange({
      ...schedule,
      sameForAll: schedule.sameForAll.map(s => s.channelId === channelId ? { ...s, videos: s.videos.filter((_, i) => i !== index) } : s),
    });
  };

  const removeVideoPerProfile = (profileId: string, channelId: number, index: number) => {
    onChange({
      ...schedule,
      perProfile: schedule.perProfile.map(p => {
        if (p.profileId !== profileId) return p;
        return {
          ...p,
          channelSelections: p.channelSelections.map(c =>
            c.channelId === channelId ? { ...c, videos: c.videos.filter((_, i) => i !== index) } : c,
          ),
        };
      }),
    });
  };

  const addAllEnabled = (channelId: number, profileId?: string) => {
    for (const v of getVideos(channelId, 'enabled')) {
      if (profileId) addVideoPerProfile(profileId, channelId, v.title, v.url);
      else addVideoSameAll(channelId, v.title, v.url);
    }
  };

  const shuffleSelected = (channelId: number, profileId?: string) => {
    if (profileId) {
      onChange({
        ...schedule,
        perProfile: schedule.perProfile.map(p => {
          if (p.profileId !== profileId) return p;
          return {
            ...p,
            channelSelections: p.channelSelections.map(c =>
              c.channelId === channelId ? { ...c, videos: shuffleArray(c.videos) } : c,
            ),
          };
        }),
      });
    } else {
      onChange({
        ...schedule,
        sameForAll: schedule.sameForAll.map(s =>
          s.channelId === channelId ? { ...s, videos: shuffleArray(s.videos) } : s,
        ),
      });
    }
  };

  const history = watchHistoryByProfile ?? {};
  const allowRepeat = allowSameDayRepeat ?? false;

  const isSkippedToday = (video: VideoEntry, profileId?: string) => {
    const videoId = extractVideoIdFromEntry(video);
    if (!videoId) return false;
    if (schedule.assignmentMode === 'same-all') {
      return schedule.selectedProfiles.some(pid =>
        shouldSkipVideoToday(pid, videoId, history, allowRepeat),
      );
    }
    if (!profileId) return false;
    return shouldSkipVideoToday(profileId, videoId, history, allowRepeat);
  };

  const renderChannelBlock = (ch: Channel, profileId?: string) => {
    const allVideos = getVideos(ch.id, 'enabled');
    const q = (videoSearch[ch.id] || '').trim().toLowerCase();
    const videos = q ? allVideos.filter(v => v.title.toLowerCase().includes(q)) : allVideos;
    const selected = profileId
      ? schedule.perProfile.find(p => p.profileId === profileId)?.channelSelections.find(c => c.channelId === ch.id)?.videos || []
      : schedule.sameForAll.find(s => s.channelId === ch.id)?.videos || [];

    return (
      <div key={`${ch.id}-${profileId || 'all'}`} className="bg-gray-800 rounded-xl p-4 border border-gray-700">
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <span className="text-white font-semibold text-sm">{ch.channel_name}</span>
          <span className="text-xs text-gray-500 ml-auto">{selected.length} selected • {allVideos.length} enabled</span>
        </div>
        {selected.length > 0 && (
          <div className="space-y-1 mb-3">
            {selected.map((v, i) => {
              const skipped = !allowRepeat && isSkippedToday(v, profileId);
              return (
              <div key={i} className={`flex items-center gap-2 rounded-lg px-3 py-1.5 ${skipped ? 'bg-amber-900/20 border border-amber-700/30' : 'bg-gray-900'}`}>
                <span className="text-xs text-gray-500 w-4">{i + 1}.</span>
                <span className={`text-xs flex-1 truncate ${skipped ? 'text-amber-300' : 'text-green-400'}`}>{v.title || v.value}</span>
                {skipped && (
                  <span className="text-[10px] text-amber-400 whitespace-nowrap" title="Aaj pehle watched — skip hogi">
                    ⏭ aaj watched
                  </span>
                )}
                <button type="button" onClick={() => profileId ? removeVideoPerProfile(profileId, ch.id, i) : removeVideoSameAll(ch.id, i)} className="text-red-400 text-xs">✕</button>
              </div>
            );})}
            <button type="button" onClick={() => shuffleSelected(ch.id, profileId)} className="text-xs text-purple-400 mt-1">Shuffle order</button>
          </div>
        )}
        <div className="flex gap-2 mb-2">
          <input value={videoSearch[ch.id] || ''} onChange={(e) => setVideoSearch(prev => ({ ...prev, [ch.id]: e.target.value }))}
            placeholder="Search videos…" className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-white" />
          <button type="button" onClick={() => addAllEnabled(ch.id, profileId)} className="text-xs px-2 py-1.5 rounded-lg bg-green-900/40 text-green-400 border border-green-700/40">All enabled</button>
        </div>
        <select onChange={(e) => {
          const vid = videos.find(v => v.video_id === e.target.value);
          if (vid) {
            if (profileId) addVideoPerProfile(profileId, ch.id, vid.title, vid.url);
            else addVideoSameAll(ch.id, vid.title, vid.url);
            e.target.value = '';
          }
        }} className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white mb-2">
          <option value="">+ Add from list…</option>
          {videos.filter(v => !selected.some(sv => sv.title === v.title || sv.value === v.url)).map(v => (
            <option key={v.video_id} value={v.video_id}>{v.title}</option>
          ))}
        </select>
        <textarea value={pasteUrls[ch.id] || ''} onChange={(e) => setPasteUrls(prev => ({ ...prev, [ch.id]: e.target.value }))}
          placeholder="Paste YouTube URLs (one per line)" rows={2}
          className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white mb-1" />
        <button type="button" onClick={() => {
          for (const { title, url } of parseYoutubeUrls(pasteUrls[ch.id] || '')) {
            if (profileId) addVideoPerProfile(profileId, ch.id, title, url);
            else addVideoSameAll(ch.id, title, url);
          }
          setPasteUrls(prev => ({ ...prev, [ch.id]: '' }));
        }} className="text-xs text-blue-400">Add pasted URLs</button>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-white font-bold text-lg mb-1">🎬 Select Videos</h2>
        <p className="text-gray-400 text-sm">Same for all profiles, or different lists per profile</p>
      </div>

      {!allowRepeat && schedule.selectedProfiles.length > 0 && Object.keys(history).length > 0 && (
        <div className="flex items-start gap-2 text-xs text-amber-300/90 bg-amber-900/20 border border-amber-700/30 rounded-lg px-3 py-2">
          <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
          <span>
            <strong className="text-amber-200">Watch history:</strong> jo video aaj pehle watched hai,
            run pe skip hogi — kal dubara chal sakti hai. Same din repeat ke liye Step 3 me toggle on karo.
          </span>
        </div>
      )}

      <div className="flex gap-2">
        <button type="button" onClick={() => onChange({ ...schedule, assignmentMode: 'same-all' })}
          className={`flex-1 py-2 rounded-xl border text-sm ${schedule.assignmentMode === 'same-all' ? 'border-red-500 bg-red-900/20 text-white' : 'border-gray-700 text-gray-400'}`}>
          Same for all
        </button>
        <button type="button" onClick={() => onChange({ ...schedule, assignmentMode: 'per-profile' })}
          className={`flex-1 py-2 rounded-xl border text-sm ${schedule.assignmentMode === 'per-profile' ? 'border-cyan-500 bg-cyan-900/20 text-white' : 'border-gray-700 text-gray-400'}`}>
          Per profile
        </button>
      </div>

      {schedule.assignmentMode === 'per-profile' && (
        <div className="flex flex-wrap gap-2">
          {schedule.selectedProfiles.map(pid => {
            const name = profiles.find(p => p.id === pid)?.name || pid.slice(-6);
            return (
              <button key={pid} type="button" onClick={() => setActiveProfileId(pid)}
                className={`px-3 py-1.5 rounded-lg text-xs border ${activeProfileId === pid ? 'border-cyan-500 bg-cyan-900/30 text-white' : 'border-gray-700 text-gray-400'}`}>
                {name}
              </button>
            );
          })}
        </div>
      )}

      {schedule.assignmentMode === 'same-all'
        ? selectedChannels.map(ch => renderChannelBlock(ch))
        : selectedChannels.map(ch => renderChannelBlock(ch, activeProfileId))}

      {selectedChannels.length === 0 && (
        <p className="text-gray-500 text-center py-8">Go back and select channels first</p>
      )}
    </div>
  );
}
