import { useState } from 'react';
import { X } from 'lucide-react';
import type { Channel, AutoSync, ChannelStatus } from '../store/useChannelStore';

interface EditChannelModalProps {
  channel: Channel;
  onClose: () => void;
  onSave: (id: number, updates: Partial<Pick<Channel, 'auto_sync' | 'status' | 'channel_name'>>) => void;
}

export default function EditChannelModal({ channel, onClose, onSave }: EditChannelModalProps) {
  const [channelName, setChannelName] = useState(channel.channel_name);
  const [autoSync, setAutoSync] = useState<AutoSync>(channel.auto_sync);
  const [status, setStatus] = useState<ChannelStatus>(channel.status === 'syncing' ? 'active' : channel.status);

  const isActive = status === 'active';

  function handleSave() {
    onSave(channel.id, {
      channel_name: channelName,
      auto_sync: autoSync,
      status,
    });
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-md shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <h2 className="text-white font-bold text-lg flex items-center gap-2">
            <span className="text-xl">✏️</span> Edit Channel
          </h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300 transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-5">
          {/* Channel ID — readonly */}
          <div>
            <label className="text-gray-300 text-sm font-medium block mb-2">
              Channel ID <span className="text-gray-600">(read-only)</span>
            </label>
            <input
              type="text"
              value={channel.channel_id}
              readOnly
              className="w-full bg-gray-800/50 border border-gray-700/50 text-gray-500 rounded-xl px-4 py-2.5 text-sm font-mono cursor-not-allowed"
            />
          </div>

          {/* Display Name — editable */}
          <div>
            <label className="text-gray-300 text-sm font-medium block mb-2">
              Display Name
            </label>
            <input
              type="text"
              value={channelName}
              onChange={e => setChannelName(e.target.value)}
              placeholder="Channel display name"
              className="w-full bg-gray-800 border border-gray-700 text-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-gray-500"
            />
          </div>

          {/* Auto-sync Interval */}
          <div>
            <label className="text-gray-300 text-sm font-medium block mb-2">
              Auto-sync interval
            </label>
            <div className="space-y-1.5">
              {([
                { value: '1hr', label: 'Every 1 hour' },
                { value: '6hr', label: 'Every 6 hours' },
                { value: '12hr', label: 'Every 12 hours' },
                { value: 'daily', label: 'Daily' },
                { value: 'manual', label: 'Manual only' },
              ] as { value: AutoSync; label: string }[]).map(opt => (
                <label key={opt.value} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="editAutoSync"
                    value={opt.value}
                    checked={autoSync === opt.value}
                    onChange={() => setAutoSync(opt.value)}
                    className="accent-red-500"
                  />
                  <span className={`text-sm ${autoSync === opt.value ? 'text-white' : 'text-gray-400'}`}>
                    {opt.label}
                  </span>
                </label>
              ))}
            </div>
          </div>

          {/* Status Toggle */}
          <div>
            <label className="text-gray-300 text-sm font-medium block mb-2">
              Status
            </label>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setStatus(isActive ? 'inactive' : 'active')}
                className={`relative w-11 h-6 rounded-full transition-all duration-200
                  ${isActive ? 'bg-green-600' : 'bg-gray-600'}`}
              >
                <div
                  className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-md transition-all duration-200
                    ${isActive ? 'left-[22px]' : 'left-0.5'}`}
                />
              </button>
              <span className={`text-sm font-medium ${isActive ? 'text-green-400' : 'text-gray-500'}`}>
                {isActive ? 'Active' : 'Inactive'}
              </span>
            </div>
          </div>
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
            onClick={handleSave}
            className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-sm font-semibold transition-all shadow-lg shadow-red-900/30"
          >
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}
