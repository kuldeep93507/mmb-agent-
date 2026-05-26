import { RefreshCw, Edit3, List, Trash2, ChevronDown, ChevronUp, Video, Clock, Pin } from 'lucide-react';
import type { Channel } from '../store/useChannelStore';

interface ChannelCardProps {
  channel: Channel & { total_videos: number; enabled_videos: number; new_videos: number };
  permanent?: boolean;
  onSync: () => void;
  onEdit: () => void;
  onPlaylist: () => void;
  onDelete: () => void;
  onToggle: () => void;
  onCardClick: () => void;
  isExpanded: boolean;
}

function formatSubscribers(count: number): string {
  if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M';
  if (count >= 1000) return (count / 1000).toFixed(0) + 'K';
  return count.toString();
}

function formatTimeSince(timestamp: number | null): string {
  if (!timestamp) return 'Never';
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}hr ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function ChannelCard({
  channel,
  permanent = false,
  onSync,
  onEdit,
  onPlaylist,
  onDelete,
  onToggle,
  onCardClick,
  isExpanded,
}: ChannelCardProps) {
  const isActive = channel.status === 'active';
  const isSyncing = channel.status === 'syncing';

  // Status badge config
  const statusConfig = {
    active: { label: 'Active', badge: 'bg-green-900/40 text-green-400 border-green-600/30', dot: 'bg-green-500' },
    inactive: { label: 'Inactive', badge: 'bg-red-900/40 text-red-400 border-red-600/30', dot: 'bg-red-500' },
    syncing: { label: 'Syncing...', badge: 'bg-blue-900/40 text-blue-400 border-blue-600/30', dot: 'bg-blue-500 animate-pulse' },
  };

  const st = statusConfig[channel.status] || statusConfig.inactive;

  return (
    <div
      className={`bg-gray-900 border rounded-2xl overflow-hidden transition-all duration-200
        ${isExpanded ? 'border-red-500/40 ring-1 ring-red-500/20' : 'border-gray-800 hover:border-gray-700'}`}
    >
      {/* Clickable Card Area */}
      <div
        onClick={onCardClick}
        className="cursor-pointer"
      >
        {/* Top Row: Status Dot + YT Logo + Name + Badge */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-800">
          {/* Status Dot */}
          <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${st.dot}`} />

          {/* YouTube Logo */}
          <div className="w-8 h-8 rounded-lg bg-red-600/20 border border-red-600/30 flex items-center justify-center flex-shrink-0">
            <svg viewBox="0 0 24 24" className="w-4 h-4 fill-red-400">
              <path d="M21.8 8s-.195-1.377-.795-1.984c-.76-.797-1.613-.8-2.004-.847-2.798-.203-6.996-.203-6.996-.203h-.01s-4.197 0-6.996.202c-.39.046-1.242.05-2.003.847C2.395 6.623 2.2 8 2.2 8S2 9.62 2 11.24v1.517c0 1.618.2 3.237.2 3.237s.195 1.378.795 1.985c.76.797 1.76.771 2.205.855C6.8 19.01 12 19.06 12 19.06s4.203-.007 7.001-.208c.39-.047 1.243-.05 2.004-.847.6-.607.795-1.985.795-1.985S22 14.375 22 12.757V11.24C22 9.62 21.8 8 21.8 8zM9.935 14.595V9.404l5.403 2.602-5.403 2.59z" />
            </svg>
          </div>

          {/* Channel Name + Handle */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-white font-semibold text-sm truncate">{channel.channel_name}</span>
              {permanent && (
                <span className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-900/40 border border-amber-600/30 text-amber-400 font-medium" title="Built-in channel">
                  <Pin size={10} /> Fixed
                </span>
              )}
            </div>
            <div className="text-gray-500 text-xs truncate">
              {channel.channel_handle} &bull; {formatSubscribers(channel.subscriber_count)} subscribers
            </div>
          </div>

          {/* Status Badge */}
          <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium flex-shrink-0 ${st.badge}`}>
            <div className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />
            {st.label}
          </div>

          {/* Expand Indicator */}
          <div className="text-gray-500 flex-shrink-0">
            {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </div>
        </div>

        {/* Channel Info Row */}
        <div className="px-4 py-2.5 flex items-center gap-4 text-xs text-gray-500">
          <span className="font-mono text-gray-600">ID: {channel.channel_id}</span>
          <div className="flex items-center gap-1">
            <Video size={12} className="text-gray-600" />
            <span>{channel.total_videos} Videos</span>
          </div>
          <div className="flex items-center gap-1">
            <Clock size={12} className="text-gray-600" />
            <span>Last Sync: {formatTimeSince(channel.last_sync)}</span>
          </div>
        </div>
      </div>

      {/* Action Buttons + Toggle */}
      <div className="px-4 py-3 border-t border-gray-800 flex items-center gap-2">
        {/* Sync */}
        <button
          onClick={(e) => { e.stopPropagation(); onSync(); }}
          disabled={isSyncing}
          title="Sync this channel"
          className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-all
            ${isSyncing
              ? 'bg-blue-900/30 border border-blue-700/30 text-blue-400 cursor-not-allowed'
              : 'bg-blue-900/20 border border-blue-700/30 text-blue-400 hover:bg-blue-900/30 hover:border-blue-600/50'}`}
        >
          <RefreshCw size={12} className={isSyncing ? 'animate-spin' : ''} />
          Sync
        </button>

        {/* Edit */}
        <button
          onClick={(e) => { e.stopPropagation(); onEdit(); }}
          title="Edit channel"
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-gray-800 border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-all"
        >
          <Edit3 size={12} />
          Edit
        </button>

        {/* Playlist */}
        <button
          onClick={(e) => { e.stopPropagation(); onPlaylist(); }}
          title="Manage playlists"
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-purple-900/20 border border-purple-700/30 text-purple-400 hover:bg-purple-900/30 hover:border-purple-600/50 transition-all"
        >
          <List size={12} />
          Playlist
        </button>

        {!permanent && (
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            title="Delete channel"
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-red-900/20 border border-red-700/30 text-red-500 hover:bg-red-900/30 hover:border-red-600/50 transition-all"
          >
            <Trash2 size={12} />
            Delete
          </button>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Active/Inactive Toggle */}
        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={onToggle}
            disabled={isSyncing}
            className={`relative w-11 h-6 rounded-full transition-all duration-200 flex-shrink-0
              ${isActive ? 'bg-green-600' : 'bg-gray-600'}`}
          >
            <div
              className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-md transition-all duration-200
                ${isActive ? 'left-[22px]' : 'left-0.5'}`}
            />
          </button>
          <span className={`text-xs font-medium ${isActive ? 'text-green-400' : 'text-gray-500'}`}>
            {isActive ? 'Active' : 'Inactive'}
          </span>
        </div>
      </div>
    </div>
  );
}
