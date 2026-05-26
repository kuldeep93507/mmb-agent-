import { useState } from 'react';
import { X, Loader2, CheckCircle } from 'lucide-react';
import type { AutoSync, ChannelStatus, Channel } from '../store/useChannelStore';
import { resolveChannelInput } from '../services/youtubeApi';

interface AddChannelModalProps {
  onClose: () => void;
  onAdd: (channelId: string, autoSync: AutoSync, status: ChannelStatus, includePlaylists?: boolean) => Promise<Channel | null> | Channel | null;
}

type LoadingStep = 'idle' | 'fetching' | 'found' | 'saving' | 'done';

export default function AddChannelModal({ onClose, onAdd }: AddChannelModalProps) {
  const [channelInput, setChannelInput] = useState('');
  const [includePlaylists, setIncludePlaylists] = useState(false);
  const [autoSync, setAutoSync] = useState<AutoSync>('6hr');
  const [status, setStatus] = useState<ChannelStatus>('active');
  const [loadingStep, setLoadingStep] = useState<LoadingStep>('idle');
  const [foundInfo, setFoundInfo] = useState('');
  const [channelAddError, setChannelAddError] = useState('');

  const isActive = status === 'active';

  async function handleSubmit() {
    const trimmed = channelInput.trim();
    if (!trimmed) return;
    setChannelAddError('');

    // Resolve input → UC ID / @handle (InnerTube will resolve @handle to real UC)
    const resolved = resolveChannelInput(trimmed);
    if (!resolved) {
      setChannelAddError('Valid channel nahi mila. UC ID, @handle, ya youtube.com/... URL paste karo.');
      return;
    }

    setLoadingStep('fetching');
    const result = await onAdd(resolved, autoSync, status, includePlaylists);

    if (result) {
      setLoadingStep('found');
      setFoundInfo(`Found: ${result.channel_name} • ${result.total_videos} videos`);
      await delay(800);
      setLoadingStep('done');
      await delay(500);
      onClose();
    } else {
      setLoadingStep('idle');
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-md shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <h2 className="text-white font-bold text-lg flex items-center gap-2">
            <span className="text-xl">➕</span> Add New Channel
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
          {/* Channel ID / URL Input */}
          <div>
            <label className="text-gray-300 text-sm font-medium block mb-2">
              Channel ID or URL
            </label>
            <input
              type="text"
              value={channelInput}
              onChange={e => setChannelInput(e.target.value)}
              placeholder="UCW5YeuERMmlnqo4oq8vwUpg"
              disabled={loadingStep !== 'idle'}
              className="w-full bg-gray-800 border border-gray-700 text-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-gray-500 disabled:opacity-50 font-mono"
            />
            <div className="mt-2 text-gray-600 text-xs space-y-0.5">
              <p>Accepts:</p>
              <p className="pl-2">&bull; UCxxxxxxxxxxxxxxxxxxxxxx (24 chars after UC)</p>
              <p className="pl-2">&bull; youtube.com/channel/UC…</p>
              <p className="pl-2 text-amber-500/90">&bull; youtube.com/@handle — ab seedha support nahi; pehle real channel UC ID nikaalo.</p>
            </div>
            {channelAddError ? (
              <p className="mt-2 text-xs text-red-400 border border-red-800/50 bg-red-950/40 rounded-lg p-2">{channelAddError}</p>
            ) : null}
          </div>

          {/* Include Playlists */}
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={includePlaylists}
              onChange={e => setIncludePlaylists(e.target.checked)}
              disabled={loadingStep !== 'idle'}
              className="w-4 h-4 accent-red-500"
            />
            <label className="text-gray-300 text-sm">Include Playlists?</label>
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
                    name="autoSync"
                    value={opt.value}
                    checked={autoSync === opt.value}
                    onChange={() => setAutoSync(opt.value)}
                    disabled={loadingStep !== 'idle'}
                    className="accent-red-500"
                  />
                  <span className={`text-sm ${autoSync === opt.value ? 'text-white' : 'text-gray-400'}`}>
                    {opt.label}
                    {opt.value === '6hr' && <span className="text-gray-600 ml-2">← default</span>}
                  </span>
                </label>
              ))}
            </div>
          </div>

          {/* Initial Status Toggle */}
          <div>
            <label className="text-gray-300 text-sm font-medium block mb-2">
              Initial Status
            </label>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setStatus(isActive ? 'inactive' : 'active')}
                disabled={loadingStep !== 'idle'}
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

          {/* Loading Steps */}
          {loadingStep !== 'idle' && (
            <div className="bg-gray-800/60 rounded-xl p-4 space-y-2 border border-gray-700/50">
              {/* Step 1: Fetching */}
              <div className="flex items-center gap-2">
                {loadingStep === 'fetching' ? (
                  <Loader2 size={14} className="text-blue-400 animate-spin" />
                ) : (
                  <CheckCircle size={14} className="text-green-400" />
                )}
                <span className={`text-xs ${loadingStep === 'fetching' ? 'text-blue-300' : 'text-green-300'}`}>
                  {loadingStep === 'fetching' ? 'Fetching channel info...' : 'Channel info fetched'}
                </span>
              </div>

              {/* Step 2: Found */}
              {(loadingStep === 'found' || loadingStep === 'saving' || loadingStep === 'done') && (
                <div className="flex items-center gap-2">
                  <CheckCircle size={14} className="text-green-400" />
                  <span className="text-xs text-green-300">✅ {foundInfo}</span>
                </div>
              )}

              {/* Step 3: Saving */}
              {(loadingStep === 'saving' || loadingStep === 'done') && (
                <div className="flex items-center gap-2">
                  {loadingStep === 'saving' ? (
                    <Loader2 size={14} className="text-blue-400 animate-spin" />
                  ) : (
                    <CheckCircle size={14} className="text-green-400" />
                  )}
                  <span className={`text-xs ${loadingStep === 'saving' ? 'text-blue-300' : 'text-green-300'}`}>
                    {loadingStep === 'saving' ? '💾 Saving to database...' : '💾 Saved to database'}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-800 flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            disabled={loadingStep !== 'idle'}
            className="px-4 py-2 rounded-xl bg-gray-800 border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-all text-sm font-medium disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!channelInput.trim() || loadingStep !== 'idle'}
            className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-sm font-semibold transition-all shadow-lg shadow-red-900/30 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {loadingStep !== 'idle' ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Adding...
              </>
            ) : (
              'Add & Fetch →'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
