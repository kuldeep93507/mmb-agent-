import { X, AlertTriangle } from 'lucide-react';
import type { Channel } from '../store/useChannelStore';

interface DeleteConfirmModalProps {
  channel: Channel & { total_videos: number };
  onClose: () => void;
  onConfirm: () => void;
}

export default function DeleteConfirmModal({ channel, onClose, onConfirm }: DeleteConfirmModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-sm shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <h2 className="text-white font-bold text-lg flex items-center gap-2">
            <AlertTriangle size={20} className="text-yellow-400" />
            Delete Channel?
          </h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300 transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          {/* Channel Name */}
          <div className="text-center">
            <span className="text-white font-semibold text-lg">"{channel.channel_name}"</span>
          </div>

          {/* Warning */}
          <div className="bg-red-900/20 border border-red-700/30 rounded-xl p-4">
            <p className="text-gray-300 text-sm mb-3">This will permanently delete:</p>
            <ul className="space-y-1.5 text-sm">
              <li className="text-red-300 flex items-center gap-2">
                <span className="text-red-400">&bull;</span> The channel
              </li>
              <li className="text-red-300 flex items-center gap-2">
                <span className="text-red-400">&bull;</span> {channel.total_videos} videos from database
              </li>
              <li className="text-red-300 flex items-center gap-2">
                <span className="text-red-400">&bull;</span> All playlist data
              </li>
              <li className="text-red-300 flex items-center gap-2">
                <span className="text-red-400">&bull;</span> All watch history for this channel
              </li>
            </ul>
          </div>

          <p className="text-gray-500 text-xs text-center">
            This action cannot be undone.
          </p>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-800 flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-gray-800 border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-all text-sm font-medium"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-sm font-semibold transition-all shadow-lg shadow-red-900/30 flex items-center gap-2"
          >
            🗑️ Yes, Delete
          </button>
        </div>
      </div>
    </div>
  );
}
