import { useState, useMemo } from 'react';
import { Plus, RefreshCw, CheckCircle, XCircle, Search, Bell, X, ExternalLink, Zap, Play } from 'lucide-react';
import type { Channel, AutoSync, ChannelStatus } from '../store/useChannelStore';
import ChannelCard from './ChannelCard';
import AddChannelModal from './AddChannelModal';
import EditChannelModal from './EditChannelModal';
import PlaylistModal from './PlaylistModal';
import DeleteConfirmModal from './DeleteConfirmModal';
import VideoListPanel from './VideoListPanel';
import { isPermanentChannel } from '../data/defaultChannels';
import { getMonitorConfig, setMonitorConfig } from '../utils/videoMonitorStore';
import type { UseVideoMonitorReturn } from '../hooks/useVideoMonitor';
interface ChannelsPageProps {
  channels: Channel[];
  getChannels: () => (Channel & { total_videos: number; enabled_videos: number; new_videos: number })[];
  addChannel: (channelId: string, autoSync: AutoSync, status: ChannelStatus) => Promise<Channel | null> | Channel | null;
  updateChannel: (id: number, updates: Partial<Pick<Channel, 'auto_sync' | 'status' | 'channel_name'>>) => void;
  deleteChannel: (id: number) => void;
  syncChannel: (id: number) => void;
  syncAllChannels: () => void;
  toggleChannel: (id: number) => void;
  enableAllChannels: () => void;
  disableAllChannels: () => void;
  getVideos: (channelId: number, filter?: string, sort?: string, search?: string) => any[];
  toggleVideo: (videoId: number) => void;
  enableAllVideos: (channelId: number) => void;
  disableAllVideos: (channelId: number) => void;
  getPlaylists: (channelId: number) => any[];
  addPlaylist: (channelId: number, playlistId: string, playlistName: string) => void;
  deletePlaylist: (id: number) => void;
  togglePlaylist: (id: number) => void;
  toasts: { id: string; message: string; type: 'success' | 'error' | 'info' }[];
  dismissToast: (id: string) => void;
  forceSyncToServer?: () => Promise<boolean>;
  videoMonitor?: UseVideoMonitorReturn;
}

export default function ChannelsPage({
  channels,
  getChannels,
  addChannel,
  updateChannel,
  deleteChannel,
  syncChannel,
  syncAllChannels,
  toggleChannel,
  enableAllChannels,
  disableAllChannels,
  getVideos,
  toggleVideo,
  enableAllVideos,
  disableAllVideos,
  getPlaylists,
  addPlaylist,
  deletePlaylist,
  togglePlaylist,
  toasts,
  dismissToast,
  forceSyncToServer,
  videoMonitor,
}: ChannelsPageProps) {
  const [search, setSearch] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  // Force re-render when monitor toggles change (stored in localStorage)
  const [monitorTick, setMonitorTick] = useState(0);
  function refreshMonitor() { setMonitorTick(t => t + 1); }
  const [editChannelId, setEditChannelId] = useState<number | null>(null);
  const [playlistChannelId, setPlaylistChannelId] = useState<number | null>(null);
  const [deleteChannelId, setDeleteChannelId] = useState<number | null>(null);
  const [expandedChannelId, setExpandedChannelId] = useState<number | null>(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const enrichedChannels = useMemo(() => getChannels(), [getChannels, monitorTick]);

  const totalChannels = enrichedChannels.length;
  const activeChannels = enrichedChannels.filter(ch => ch.status === 'active').length;
  const totalEnabledVideos = enrichedChannels.reduce((sum, ch) => sum + ch.enabled_videos, 0);

  // Filter channels by search
  const filtered = useMemo(() => {
    if (!search) return enrichedChannels;
    const s = search.toLowerCase();
    return enrichedChannels.filter(ch =>
      ch.channel_name.toLowerCase().includes(s) ||
      ch.channel_id.toLowerCase().includes(s) ||
      ch.channel_handle.toLowerCase().includes(s)
    );
  }, [enrichedChannels, search]);

  const handleCardClick = (channelId: number) => {
    setExpandedChannelId(prev => prev === channelId ? null : channelId);
  };

  const editChannel = editChannelId ? channels.find(c => c.id === editChannelId) || null : null;
  const deleteChannelData = deleteChannelId ? enrichedChannels.find(c => c.id === deleteChannelId) || null : null;
  const playlistChannel = playlistChannelId ? channels.find(c => c.id === playlistChannelId) || null : null;

  return (
    <div className="flex flex-col h-full relative overflow-y-auto">
      {/* ━━━ TOP BAR ━━━ */}
      <div className="px-6 py-4 border-b border-gray-800 bg-gray-950/50 flex-shrink-0">
        {/* Page Header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold text-white">Channels</h1>
            <p className="text-gray-500 text-sm mt-0.5">
              {totalChannels} total &bull; {activeChannels} active &bull; {totalEnabledVideos} videos enabled
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={syncAllChannels}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600/20 border border-blue-600/30 text-blue-400 hover:bg-blue-600/30 transition-all text-sm font-medium"
            >
              <RefreshCw size={15} />
              Sync All Channels
            </button>
            {forceSyncToServer && (
              <button
                type="button"
                onClick={() => void forceSyncToServer()}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-green-600/20 border border-green-600/30 text-green-400 hover:bg-green-600/30 transition-all text-sm font-medium"
                title="Push enabled videos to backend (Scheduler / Shuffle use this list)"
              >
                <RefreshCw size={15} />
                Sync to Server
              </button>
            )}
            <button
              onClick={() => setShowAddModal(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white transition-all text-sm font-semibold shadow-lg shadow-red-900/30"
            >
              <Plus size={15} />
              Add Channel
            </button>
          </div>
        </div>

        {/* Filter Bar */}
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={enableAllChannels}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-green-900/30 border border-green-700/40 text-green-400 hover:bg-green-900/50 transition-all text-xs font-medium"
          >
            <CheckCircle size={13} />
            Enable All Channels
          </button>
          <button
            onClick={disableAllChannels}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-red-900/30 border border-red-700/40 text-red-400 hover:bg-red-900/50 transition-all text-xs font-medium"
          >
            <XCircle size={13} />
            Disable All Channels
          </button>

          <div className="w-px h-5 bg-gray-700 mx-1" />

          {/* Search */}
          <div className="relative flex-1 max-w-xs">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              type="text"
              placeholder="Search channels by name or ID..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 text-gray-200 rounded-xl pl-9 pr-3 py-2 text-xs focus:outline-none focus:border-gray-500"
            />
          </div>

          <span className="text-gray-600 text-xs ml-auto">{filtered.length} channels shown</span>
        </div>
      </div>

      {/* ━━━ NEW VIDEO NOTIFICATIONS ━━━ */}
      {videoMonitor && videoMonitor.notifications.filter(n => !n.dismissed).length > 0 && (
        <div className="px-6 pt-4 space-y-2 flex-shrink-0">
          {videoMonitor.notifications.filter(n => !n.dismissed).map(notif => (
            <div key={notif.id}
              className="flex items-center gap-3 bg-red-950/40 border border-red-500/40 rounded-2xl px-4 py-3 shadow-lg">
              {/* Thumbnail */}
              {notif.thumbnail && (
                <img src={notif.thumbnail} alt="" className="w-16 h-10 rounded-lg object-cover flex-shrink-0 border border-gray-700" />
              )}
              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-red-400 bg-red-900/40 px-2 py-0.5 rounded-full border border-red-700/40 animate-pulse">
                    🆕 New Video
                  </span>
                  <span className="text-[10px] text-gray-500">{notif.channelName}</span>
                  <span className="text-[10px] text-gray-600 ml-auto">
                    {new Date(notif.detectedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <p className="text-sm text-white font-medium truncate">{notif.videoTitle}</p>
              </div>
              {/* Actions */}
              <div className="flex items-center gap-2 flex-shrink-0">
                <a
                  href={notif.videoUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-gray-800 border border-gray-700 text-gray-300 text-xs hover:border-gray-500 hover:text-white transition-all"
                >
                  <ExternalLink size={11} /> Open
                </a>
                {!notif.engagementStarted && (
                  <button
                    onClick={() => videoMonitor.markEngaged(notif.id)}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-green-700/80 text-white text-xs font-medium hover:bg-green-600 transition-all"
                  >
                    <Zap size={11} /> Start Engagement
                  </button>
                )}
                {notif.engagementStarted && (
                  <span className="text-xs text-green-400 flex items-center gap-1">
                    <Play size={10} /> Queued
                  </span>
                )}
                <button
                  onClick={() => videoMonitor.dismissNotif(notif.id)}
                  className="w-6 h-6 flex items-center justify-center rounded-lg bg-gray-800 border border-gray-700 text-gray-500 hover:text-gray-300 transition-all"
                >
                  <X size={12} />
                </button>
              </div>
            </div>
          ))}
          {videoMonitor.notifications.filter(n => !n.dismissed).length > 1 && (
            <div className="flex justify-end">
              <button onClick={videoMonitor.clearAll}
                className="text-xs text-gray-600 hover:text-gray-400 underline">
                Dismiss all
              </button>
            </div>
          )}
        </div>
      )}

      {/* ━━━ CHANNEL CARDS LIST ━━━ */}
      <div className="flex-1 overflow-y-auto p-6">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64">
            <div className="text-6xl mb-4">📺</div>
            <h3 className="text-gray-400 font-semibold text-lg mb-2">
              {totalChannels === 0 ? 'No Channels Yet' : 'No channels match your search'}
            </h3>
            <p className="text-gray-600 text-sm mb-6">
              {totalChannels === 0
                ? 'Click "Add Channel" to add your first YouTube channel'
                : 'Try adjusting your search query'}
            </p>
            {totalChannels === 0 && (
              <button
                onClick={() => setShowAddModal(true)}
                className="flex items-center gap-2 px-6 py-3 rounded-xl bg-red-600 hover:bg-red-500 text-white text-sm font-semibold transition-all"
              >
                <Plus size={16} />
                Add First Channel
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {filtered.map(channel => {
              const monCfg = getMonitorConfig(channel.channel_id);
              return (
              <div key={channel.id}>
                <ChannelCard
                  channel={channel}
                  permanent={isPermanentChannel(channel.channel_id)}
                  onSync={() => syncChannel(channel.id)}
                  onEdit={() => setEditChannelId(channel.id)}
                  onPlaylist={() => setPlaylistChannelId(channel.id)}
                  onDelete={() => setDeleteChannelId(channel.id)}
                  onToggle={() => toggleChannel(channel.id)}
                  onCardClick={() => handleCardClick(channel.id)}
                  isExpanded={expandedChannelId === channel.id}
                />

                {/* ── Monitor settings row (below card, always visible) ── */}
                <div className={`mx-0.5 -mt-1 rounded-b-2xl border-x border-b px-4 py-2.5 flex items-center gap-3 transition-all ${
                  monCfg.enabled
                    ? 'bg-red-950/20 border-red-500/25'
                    : 'bg-gray-900/60 border-gray-800/60'
                }`}>
                  <Bell size={13} className={monCfg.enabled ? 'text-red-400' : 'text-gray-600'} />
                  <span className={`text-xs font-medium ${monCfg.enabled ? 'text-red-300' : 'text-gray-600'}`}>
                    New video monitor
                  </span>
                  {/* Enabled toggle */}
                  <button
                    onClick={() => { setMonitorConfig(channel.channel_id, { enabled: !monCfg.enabled }); refreshMonitor(); }}
                    className={`relative w-9 h-4.5 h-[18px] rounded-full transition-all duration-200 flex-shrink-0 ${
                      monCfg.enabled ? 'bg-red-500' : 'bg-gray-700 hover:bg-gray-600'
                    }`}
                  >
                    <span className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white shadow transition-all duration-200 ${
                      monCfg.enabled ? 'left-[18px]' : 'left-0.5'
                    }`} />
                  </button>

                  {monCfg.enabled && (
                    <>
                      <div className="w-px h-3 bg-gray-700" />
                      {/* Auto-engage toggle */}
                      <div className="flex items-center gap-2">
                        <Zap size={11} className={monCfg.autoEngage ? 'text-yellow-400' : 'text-gray-600'} />
                        <span className={`text-xs ${monCfg.autoEngage ? 'text-yellow-300' : 'text-gray-600'}`}>
                          Auto engagement
                        </span>
                        <button
                          onClick={() => { setMonitorConfig(channel.channel_id, { autoEngage: !monCfg.autoEngage }); refreshMonitor(); }}
                          className={`relative w-9 h-[18px] rounded-full transition-all duration-200 flex-shrink-0 ${
                            monCfg.autoEngage ? 'bg-yellow-500' : 'bg-gray-700 hover:bg-gray-600'
                          }`}
                        >
                          <span className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white shadow transition-all duration-200 ${
                            monCfg.autoEngage ? 'left-[18px]' : 'left-0.5'
                          }`} />
                        </button>
                      </div>
                      <div className="w-px h-3 bg-gray-700" />
                      {/* Manual force check */}
                      {videoMonitor && (
                        <button
                          onClick={() => void videoMonitor.forceCheck()}
                          className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-all"
                        >
                          <RefreshCw size={10} /> Check now
                        </button>
                      )}
                      <span className="ml-auto text-[10px] text-gray-700">
                        Checks every 5 min
                      </span>
                    </>
                  )}

                  {!monCfg.enabled && (
                    <span className="ml-auto text-[10px] text-gray-700">Off</span>
                  )}
                </div>

                {/* Expandable Video List Panel */}
                {expandedChannelId === channel.id && (
                  <VideoListPanel
                    channel={channel}
                    getVideos={getVideos}
                    toggleVideo={toggleVideo}
                    enableAllVideos={enableAllVideos}
                    disableAllVideos={disableAllVideos}
                  />
                )}
              </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ━━━ MODALS ━━━ */}
      {showAddModal && (
        <AddChannelModal
          onClose={() => setShowAddModal(false)}
          onAdd={addChannel}
        />
      )}
      {editChannel && (
        <EditChannelModal
          channel={editChannel}
          onClose={() => setEditChannelId(null)}
          onSave={updateChannel}
        />
      )}
      {playlistChannel && (
        <PlaylistModal
          channel={playlistChannel}
          playlists={getPlaylists(playlistChannel.id)}
          onClose={() => setPlaylistChannelId(null)}
          onAddPlaylist={addPlaylist}
          onDeletePlaylist={deletePlaylist}
          onTogglePlaylist={togglePlaylist}
        />
      )}
      {deleteChannelData && (
        <DeleteConfirmModal
          channel={deleteChannelData}
          onClose={() => setDeleteChannelId(null)}
          onConfirm={() => {
            deleteChannel(deleteChannelData.id);
            setDeleteChannelId(null);
            if (expandedChannelId === deleteChannelData.id) {
              setExpandedChannelId(null);
            }
          }}
        />
      )}

      {/* ━━━ TOAST NOTIFICATIONS ━━━ */}
      {toasts.length > 0 && (
        <div className="fixed bottom-6 right-6 z-50 space-y-2">
          {toasts.map(toast => (
            <div
              key={toast.id}
              onClick={() => dismissToast(toast.id)}
              className={`px-4 py-3 rounded-xl border shadow-lg cursor-pointer animate-pulse-once text-sm font-medium
                ${toast.type === 'success' ? 'bg-green-900/80 border-green-600/40 text-green-300' : ''}
                ${toast.type === 'error' ? 'bg-red-900/80 border-red-600/40 text-red-300' : ''}
                ${toast.type === 'info' ? 'bg-blue-900/80 border-blue-600/40 text-blue-300' : ''}
              `}
            >
              {toast.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
