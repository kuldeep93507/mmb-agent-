import { Eye, Clock, ThumbsUp, ExternalLink } from 'lucide-react';
import type { Video } from '../store/useChannelStore';

interface VideoRowProps {
  video: Video;
  onToggle: () => void;
}

function formatDuration(raw: number | string | undefined | null): string {
  if (raw === null || raw === undefined) return '—';

  // Old data stored as string "4:32" or "1:23:45" — return directly
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (/^\d+:\d{2}(:\d{2})?$/.test(trimmed)) return trimmed;
    return '—';
  }

  // Number (seconds) — 0 or -1 means unknown / not fetched
  const sec = Math.round(raw as number);
  if (sec <= 0) return '—';

  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatViews(views: number): string {
  if (!views || views <= 0) return '—';
  if (views >= 1_000_000) return (views / 1_000_000).toFixed(1) + 'M views';
  if (views >= 1_000) return Math.floor(views / 1_000) + 'K views';
  return views + ' views';
}

function formatLikes(likes: number | undefined): string {
  if (!likes || likes <= 0) return '';
  if (likes >= 1_000_000) return (likes / 1_000_000).toFixed(1) + 'M';
  if (likes >= 1_000) return Math.floor(likes / 1_000) + 'K';
  return likes.toString();
}

function formatRelativeDate(timestamp: number): string {
  if (!timestamp) return '—';
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function getStatusBadge(video: Video): { label: string; classes: string } | null {
  if (video.is_enabled === 0)   return { label: 'DISABLED', classes: 'bg-gray-800 text-gray-500 border-gray-700' };
  if (video.is_new === 1)        return { label: 'NEW',      classes: 'bg-green-900/60 text-green-400 border-green-600/50' };
  if (video.status === 'queued') return { label: 'QUEUED',   classes: 'bg-yellow-900/50 text-yellow-400 border-yellow-600/40' };
  if (video.status === 'running')return { label: 'RUNNING',  classes: 'bg-purple-900/50 text-purple-400 border-purple-600/40' };
  if (video.status === 'done')   return { label: 'DONE',     classes: 'bg-emerald-900/40 text-emerald-400 border-emerald-600/30' };
  return null;
}

// YouTube thumbnail fallback: try maxresdefault → hqdefault → mqdefault
function thumbnailUrl(video: Video): string {
  if (video.thumbnail && video.thumbnail.startsWith('http')) return video.thumbnail;
  if (video.video_id) return `https://i.ytimg.com/vi/${video.video_id}/mqdefault.jpg`;
  return '';
}

export default function VideoRow({ video, onToggle }: VideoRowProps) {
  const isEnabled  = video.is_enabled === 1;
  const badge      = getStatusBadge(video);
  const duration   = formatDuration(video.duration);
  const thumb      = thumbnailUrl(video);
  const likesLabel = formatLikes(video.likes);
  const videoUrl   = `https://youtube.com/watch?v=${video.video_id}`;

  return (
    <div className={`flex items-center gap-3 px-4 py-3 hover:bg-gray-800/30 transition-colors group
      ${!isEnabled ? 'opacity-50' : ''}`}>

      {/* ── Toggle ── */}
      <button
        onClick={onToggle}
        title={isEnabled ? 'Disable this video' : 'Enable this video'}
        className={`relative w-10 h-[22px] rounded-full transition-all duration-200 flex-shrink-0
          ${isEnabled ? 'bg-green-600 hover:bg-green-500' : 'bg-gray-600 hover:bg-gray-500'}`}
      >
        <div className={`absolute top-[3px] w-4 h-4 rounded-full bg-white shadow-sm transition-all duration-200
          ${isEnabled ? 'left-[22px]' : 'left-[3px]'}`} />
      </button>

      {/* ── Thumbnail ── */}
      <div className="relative flex-shrink-0 w-28 h-16 rounded-lg overflow-hidden bg-gray-800 border border-gray-700/60">
        {thumb ? (
          <img
            src={thumb}
            alt={video.title}
            className="w-full h-full object-cover"
            loading="lazy"
            onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-700 text-2xl">▶</div>
        )}
        {/* NEW badge overlay */}
        {video.is_new === 1 && isEnabled && (
          <span className="absolute top-1 left-1 bg-red-600 text-white text-[9px] font-bold px-1.5 py-0.5 rounded">
            NEW
          </span>
        )}
      </div>

      {/* ── Info ── */}
      <div className="flex-1 min-w-0">
        {/* Title row */}
        <div className="flex items-start gap-2">
          <p className={`text-sm font-medium leading-snug line-clamp-2 flex-1 ${isEnabled ? 'text-white' : 'text-gray-500'}`}>
            {video.title}
          </p>
          {/* External link */}
          <a
            href={videoUrl}
            target="_blank"
            rel="noreferrer"
            onClick={e => e.stopPropagation()}
            title="Open on YouTube"
            className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded text-gray-500 hover:text-gray-300"
          >
            <ExternalLink size={12} />
          </a>
        </div>

        {/* Stats row */}
        <div className="flex items-center gap-3 mt-1 flex-wrap">
          {/* Upload date */}
          <span className="flex items-center gap-1 text-[11px] text-gray-500">
            <Clock size={10} />
            {formatRelativeDate(video.upload_date)}
          </span>

          {/* Duration — right next to views */}
          <span className="flex items-center gap-1 text-[11px] text-gray-400 font-mono bg-gray-800/60 px-1.5 py-0.5 rounded">
            ⏱ {duration}
          </span>

          {/* Views */}
          <span className="flex items-center gap-1 text-[11px] text-gray-500">
            <Eye size={10} />
            {formatViews(video.views)}
          </span>

          {/* Likes */}
          {likesLabel && (
            <span className="flex items-center gap-1 text-[11px] text-gray-500">
              <ThumbsUp size={10} />
              {likesLabel}
            </span>
          )}

          {/* Watch count */}
          {video.watch_count > 0 && (
            <span className="text-[11px] text-green-400/80">
              ✓ Watched {video.watch_count}×
            </span>
          )}
        </div>
      </div>

      {/* ── Status badge ── */}
      {badge && (
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md border flex-shrink-0 ${badge.classes}`}>
          {badge.label}
        </span>
      )}
    </div>
  );
}
