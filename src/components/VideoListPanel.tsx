import { useState, useMemo } from 'react';
import { CheckCircle, XCircle, Search } from 'lucide-react';
import type { Channel, Video } from '../store/useChannelStore';
import VideoRow from './VideoRow';

interface VideoListPanelProps {
  channel: Channel;
  getVideos: (channelId: number, filter?: string, sort?: string, search?: string) => Video[];
  toggleVideo: (videoId: number) => void;
  enableAllVideos: (channelId: number) => void;
  disableAllVideos: (channelId: number) => void;
}

export default function VideoListPanel({
  channel,
  getVideos,
  toggleVideo,
  enableAllVideos,
  disableAllVideos,
}: VideoListPanelProps) {
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('newest');
  const [search, setSearch] = useState('');

  const videos = useMemo(
    () => getVideos(channel.id, filter, sort, search),
    [channel.id, filter, sort, search, getVideos]
  );

  const allVideos = useMemo(() => getVideos(channel.id), [channel.id, getVideos]);
  const totalCount   = allVideos.length;
  const enabledCount = allVideos.filter(v => v.is_enabled === 1).length;
  const newCount     = allVideos.filter(v => v.is_new === 1).length;

  return (
    <div className="bg-gray-950 border border-gray-800 border-t-0 rounded-b-2xl overflow-hidden animate-pulse-once">
      {/* Panel Header */}
      <div className="px-5 py-3 border-b border-gray-800 bg-gray-900/50">
        <h3 className="text-white font-semibold text-sm">
          {channel.channel_name} — Videos
        </h3>
        <p className="text-gray-500 text-xs mt-0.5">
          {totalCount} total &bull; {enabledCount} enabled &bull; {newCount} new
        </p>
      </div>

      {/* Panel Toolbar */}
      <div className="px-5 py-3 border-b border-gray-800 flex items-center gap-2 flex-wrap">
        {/* Left: Enable/Disable All */}
        <button
          onClick={() => enableAllVideos(channel.id)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-green-900/30 border border-green-700/40 text-green-400 hover:bg-green-900/50 transition-all text-xs font-medium"
        >
          <CheckCircle size={12} />
          Enable All
        </button>
        <button
          onClick={() => disableAllVideos(channel.id)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-red-900/30 border border-red-700/40 text-red-400 hover:bg-red-900/50 transition-all text-xs font-medium"
        >
          <XCircle size={12} />
          Disable All
        </button>

        <div className="w-px h-5 bg-gray-700 mx-1" />

        {/* Right side: Filter + Sort + Search */}
        <div className="flex items-center gap-2 ml-auto flex-wrap">
          {/* Filter Dropdown */}
          <select
            value={filter}
            onChange={e => setFilter(e.target.value)}
            className="bg-gray-800 border border-gray-700 text-gray-300 rounded-xl px-3 py-1.5 text-xs font-medium focus:outline-none focus:border-gray-500"
          >
            <option value="all">Filter: All Videos</option>
            <option value="enabled">Enabled Only</option>
            <option value="disabled">Disabled Only</option>
            <option value="new">New Videos</option>
            <option value="watched">Watched</option>
            <option value="unwatched">Unwatched</option>
          </select>

          {/* Sort Dropdown */}
          <select
            value={sort}
            onChange={e => setSort(e.target.value)}
            className="bg-gray-800 border border-gray-700 text-gray-300 rounded-xl px-3 py-1.5 text-xs font-medium focus:outline-none focus:border-gray-500"
          >
            <option value="newest">Sort: Newest First</option>
            <option value="oldest">Oldest First</option>
            <option value="views">Most Viewed</option>
            <option value="duration">Duration</option>
          </select>

          {/* Search */}
          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              type="text"
              placeholder="Search video title..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="bg-gray-800 border border-gray-700 text-gray-200 rounded-xl pl-7 pr-3 py-1.5 text-xs w-44 focus:outline-none focus:border-gray-500"
            />
          </div>
        </div>
      </div>

      {/* Video List */}
      <div className="max-h-[520px] overflow-y-auto">
        {videos.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-gray-500 text-sm">No videos match your filters</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-800/50">
            {videos.map(video => (
              <VideoRow
                key={video.id}
                video={video}
                onToggle={() => toggleVideo(video.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
