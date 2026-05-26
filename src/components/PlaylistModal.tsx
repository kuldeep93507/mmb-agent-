import { useState } from 'react';
import { X, Trash2, Plus } from 'lucide-react';
import type { Channel, Playlist } from '../store/useChannelStore';

interface PlaylistModalProps {
  channel: Channel;
  playlists: Playlist[];
  onClose: () => void;
  onAddPlaylist: (channelId: number, playlistId: string, playlistName: string) => void;
  onDeletePlaylist: (id: number) => void;
  onTogglePlaylist: (id: number) => void;
}

export default function PlaylistModal({
  channel,
  playlists,
  onClose,
  onAddPlaylist,
  onDeletePlaylist,
  onTogglePlaylist,
}: PlaylistModalProps) {
  const [newPlaylistInput, setNewPlaylistInput] = useState('');

  function handleAddPlaylist() {
    if (!newPlaylistInput.trim()) return;

    // Extract playlist ID from URL or use as-is
    let playlistId = newPlaylistInput.trim();
    const match = playlistId.match(/[?&]list=(PL[\w-]+)/);
    if (match) playlistId = match[1];

    onAddPlaylist(channel.id, playlistId, '');
    setNewPlaylistInput('');
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-md shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <h2 className="text-white font-bold text-lg flex items-center gap-2">
            <span className="text-xl">📋</span> Playlists — {channel.channel_name}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300 transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Playlist List */}
        <div className="px-6 py-4">
          <p className="text-gray-400 text-sm font-medium mb-3">Existing Playlists:</p>

          {playlists.length === 0 ? (
            <div className="py-6 text-center">
              <p className="text-gray-600 text-sm">No playlists added yet</p>
            </div>
          ) : (
            <div className="space-y-3 max-h-64 overflow-y-auto">
              {playlists.map(playlist => {
                const isActive = playlist.status === 'active';
                return (
                  <div
                    key={playlist.id}
                    className="bg-gray-800/60 border border-gray-700/50 rounded-xl p-3"
                  >
                    {/* Playlist Name + Video Count */}
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`text-sm font-medium ${isActive ? 'text-white' : 'text-gray-500'}`}>
                        {isActive ? '✅' : '❌'} {playlist.playlist_name}
                      </span>
                      <span className="text-gray-500 text-xs">
                        ({playlist.video_count} videos)
                      </span>
                    </div>

                    {/* Playlist ID */}
                    <div className="text-gray-600 text-xs font-mono mb-2 truncate">
                      {playlist.playlist_id}
                    </div>

                    {/* Toggle + Remove */}
                    <div className="flex items-center gap-3">
                      {/* Toggle */}
                      <button
                        onClick={() => onTogglePlaylist(playlist.id)}
                        className={`relative w-9 h-5 rounded-full transition-all duration-200
                          ${isActive ? 'bg-green-600' : 'bg-gray-600'}`}
                      >
                        <div
                          className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-all duration-200
                            ${isActive ? 'left-[18px]' : 'left-0.5'}`}
                        />
                      </button>

                      <div className="flex-1" />

                      {/* Remove */}
                      <button
                        onClick={() => onDeletePlaylist(playlist.id)}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-red-900/20 border border-red-700/30 text-red-400 hover:bg-red-900/30 hover:border-red-600/50 transition-all"
                      >
                        <Trash2 size={11} />
                        Remove
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Add New Playlist Section */}
        <div className="px-6 py-4 border-t border-gray-800">
          <p className="text-gray-400 text-sm font-medium mb-2">Add New Playlist:</p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newPlaylistInput}
              onChange={e => setNewPlaylistInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAddPlaylist()}
              placeholder="Paste Playlist ID or URL"
              className="flex-1 bg-gray-800 border border-gray-700 text-gray-200 rounded-xl px-4 py-2.5 text-sm font-mono focus:outline-none focus:border-gray-500"
            />
            <button
              onClick={handleAddPlaylist}
              disabled={!newPlaylistInput.trim()}
              className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white text-sm font-semibold transition-all shadow-lg shadow-red-900/30 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Plus size={14} />
              Add
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-gray-800 flex items-center justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-gray-800 border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-all text-sm font-medium"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
