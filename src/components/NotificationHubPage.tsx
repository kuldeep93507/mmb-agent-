import { useCallback, useEffect, useState } from 'react';
import {
  Bell, Plus, Play, Trash2, Clock, Save, RefreshCw,
  CheckCircle, XCircle, Network, ChevronDown, ChevronUp, Settings2,
} from 'lucide-react';
import type { Profile } from '../types';
import type { Channel, Video } from '../store/useChannelStore';
import ShuffleRunSettingsPanel from './ShuffleRunSettingsPanel';
import ProfilePickerPanel from './shared/ProfilePickerPanel';
import ChannelVideoPicker, { type PickableVideo } from './shared/ChannelVideoPicker';
import {
  fetchFleetMachines,
  fetchNotificationPlans,
  runNotificationPlan,
  saveNotificationPlans,
  buildRunSettingsPayload,
  type NotificationPlan,
} from '../utils/notificationHubApi';

const genId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

type EditorTab = 'general' | 'profiles' | 'videos' | 'schedule';

const DEFAULT_PLAN = (): NotificationPlan => ({
  id: genId(),
  name: 'New upload plan',
  enabled: true,
  profileIds: [],
  videos: [],
  channelIds: [],
  dailyTimes: ['09:00', '14:00', '18:00'],
  gapMin: 10,
  gapMax: 25,
  useFleet: false,
  fleetMachineIds: [],
  runSettings: buildRunSettingsPayload(),
});

interface Props {
  profiles: Profile[];
  channels: Channel[];
  getVideos: (channelId: number, filter?: string) => Video[];
}

export default function NotificationHubPage({ profiles, channels, getVideos }: Props) {
  const [plans, setPlans] = useState<NotificationPlan[]>([]);
  const [status, setStatus] = useState<{ serverTime: string; serverDate: string } | null>(null);
  const [hubMeta, setHubMeta] = useState<{ id: string; nextSlot?: string }[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<NotificationPlan>(DEFAULT_PLAN());
  const [editorTab, setEditorTab] = useState<EditorTab>('general');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newTime, setNewTime] = useState('12:00');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [machines, setMachines] = useState<{ id: string; name: string; online: boolean }[]>([]);

  const load = useCallback(async () => {
    const data = await fetchNotificationPlans();
    if (data) {
      setPlans(data.plans.map(p => ({ ...p, channelIds: p.channelIds || [] })));
      setStatus({ serverTime: data.status.serverTime, serverDate: data.status.serverDate });
      setHubMeta((data.status.plans as typeof hubMeta) || []);
    }
    setMachines(await fetchFleetMachines());
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const t = setInterval(() => void load(), 30000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (plans.length > 0 && !selectedId) {
      setSelectedId(plans[0].id);
      setDraft({ ...plans[0], runSettings: plans[0].runSettings || buildRunSettingsPayload() });
    }
  }, [plans, selectedId]);

  const syncDraftVideos = (videos: PickableVideo[]) => {
    const channelIds = [...new Set(videos.map(v => v.channelId).filter((x): x is number => x != null))];
    setDraft(d => ({ ...d, videos, channelIds }));
  };

  const selectPlan = (p: NotificationPlan) => {
    setSelectedId(p.id);
    setDraft({ ...p, runSettings: p.runSettings || buildRunSettingsPayload() });
    setMsg('');
  };

  const addPlan = () => {
    const p = DEFAULT_PLAN();
    setPlans(prev => [...prev, p]);
    setSelectedId(p.id);
    setDraft(p);
    setEditorTab('general');
  };

  const deletePlan = (id: string) => {
    if (!window.confirm('Delete this notification plan?')) return;
    const next = plans.filter(p => p.id !== id);
    setPlans(next);
    if (selectedId === id) {
      setSelectedId(next[0]?.id ?? null);
      setDraft(next[0] ? { ...next[0] } : DEFAULT_PLAN());
    }
  };

  const saveAll = async () => {
    setBusy(true);
    const enriched = { ...draft, runSettings: buildRunSettingsPayload() };
    const toSave = plans.some(p => p.id === draft.id)
      ? plans.map(p => (p.id === draft.id ? enriched : { ...p, runSettings: p.runSettings || buildRunSettingsPayload() }))
      : [...plans, enriched];
    const ok = await saveNotificationPlans(toSave);
    setPlans(toSave);
    setMsg(ok ? '✅ Plans saved' : '❌ Save failed');
    setBusy(false);
    if (ok) await load();
  };

  const runNow = async () => {
    setBusy(true);
    const enriched = { ...draft, runSettings: buildRunSettingsPayload() };
    await saveNotificationPlans(
      plans.map(p => (p.id === draft.id ? enriched : p)),
    );
    const res = await runNotificationPlan(draft.id);
    setMsg(res.success
      ? `✅ Notification run start (${draft.useFleet ? 'Fleet' : 'Local'})`
      : `❌ ${res.error}`);
    setBusy(false);
    await load();
  };

  const addTimeSlot = () => {
    const [h, m] = newTime.split(':').map(Number);
    const norm = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    if (draft.dailyTimes.includes(norm)) return;
    setDraft(d => ({ ...d, dailyTimes: [...d.dailyTimes, norm].sort() }));
  };

  const statusRow = plans.find(p => p.id === selectedId);
  const editorTabs: { id: EditorTab; label: string; badge?: number }[] = [
    { id: 'general', label: 'General' },
    { id: 'profiles', label: 'Profiles', badge: draft.profileIds.length },
    { id: 'videos', label: 'Videos', badge: draft.videos.length },
    { id: 'schedule', label: 'Schedule', badge: draft.dailyTimes.length },
  ];

  return (
    <div className="h-full flex flex-col bg-gray-950 text-gray-100 overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 px-4 py-3 border-b border-gray-800 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold flex items-center gap-2">
            <Bell className="text-amber-400" size={20} />
            Notification Hub
          </h1>
          {status && (
            <p className="text-[10px] text-gray-600 font-mono mt-0.5">
              Server {status.serverDate} {status.serverTime}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => void load()} disabled={busy}
            className="px-2.5 py-1.5 rounded-lg bg-gray-800 text-gray-300 text-xs flex items-center gap-1">
            <RefreshCw size={12} /> Refresh
          </button>
          <button type="button" onClick={addPlan}
            className="px-2.5 py-1.5 rounded-lg bg-amber-600/25 text-amber-300 border border-amber-600/30 text-xs flex items-center gap-1">
            <Plus size={12} /> New Plan
          </button>
        </div>
      </div>

      {msg && (
        <div className={`mx-4 mt-2 text-xs px-3 py-2 rounded-lg border flex-shrink-0 ${
          msg.startsWith('✅') ? 'bg-emerald-900/20 border-emerald-800 text-emerald-300' : 'bg-red-900/20 border-red-800 text-red-300'
        }`}>{msg}</div>
      )}

      <div className="flex-1 flex min-h-0">
        {/* Plans rail */}
        <aside className="w-52 flex-shrink-0 border-r border-gray-800 overflow-y-auto p-2 space-y-1 hidden md:block">
          {plans.length === 0 && (
            <p className="text-xs text-gray-600 p-2">New Plan se shuru karo</p>
          )}
          {plans.map(p => {
            const meta = hubMeta.find(h => h.id === p.id);
            return (
              <button key={p.id} type="button" onClick={() => selectPlan(p)}
                className={`w-full text-left p-2.5 rounded-lg border text-xs transition ${
                  selectedId === p.id ? 'border-amber-500/50 bg-amber-900/15' : 'border-transparent hover:bg-gray-900'
                }`}>
                <div className="flex items-center gap-1.5">
                  {p.enabled ? <CheckCircle size={12} className="text-emerald-400" /> : <XCircle size={12} className="text-gray-600" />}
                  <span className="font-medium text-white truncate flex-1">{p.name}</span>
                </div>
                <div className="text-[10px] text-gray-600 mt-1 pl-4">
                  {p.profileIds.length}p · {p.videos.length}v · {p.dailyTimes.length}t
                </div>
                {meta?.nextSlot && <div className="text-[10px] text-amber-500/90 pl-4">→ {meta.nextSlot}</div>}
              </button>
            );
          })}
        </aside>

        {/* Main editor */}
        <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* Mobile plan picker */}
          <div className="md:hidden p-2 border-b border-gray-800">
            <select value={selectedId || ''} onChange={e => {
              const p = plans.find(x => x.id === e.target.value);
              if (p) selectPlan(p);
            }} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-2 text-sm text-white">
              {plans.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>

          {/* Editor tabs */}
          <div className="flex-shrink-0 flex gap-1 px-3 pt-2 overflow-x-auto border-b border-gray-800">
            {editorTabs.map(t => (
              <button key={t.id} type="button" onClick={() => setEditorTab(t.id)}
                className={`px-3 py-2 text-xs font-medium rounded-t-lg whitespace-nowrap flex items-center gap-1.5 border-b-2 -mb-px ${
                  editorTab === t.id ? 'border-amber-500 text-amber-200 bg-gray-900/50' : 'border-transparent text-gray-500'
                }`}>
                {t.label}
                {t.badge != null && t.badge > 0 && (
                  <span className="px-1.5 py-0.5 rounded-full bg-gray-800 text-[10px]">{t.badge}</span>
                )}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {editorTab === 'general' && (
              <div className="max-w-xl space-y-4">
                <label className="block text-xs text-gray-500">
                  Plan name
                  <input value={draft.name} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
                    className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm" />
                </label>
                <label className="flex items-center gap-2 text-sm text-gray-300">
                  <input type="checkbox" checked={draft.enabled}
                    onChange={e => setDraft(d => ({ ...d, enabled: e.target.checked }))}
                    className="rounded border-gray-600" />
                  Auto-run on daily times
                </label>
                <div className="p-3 rounded-xl bg-amber-900/10 border border-amber-800/30 text-xs text-amber-200/90 leading-relaxed">
                  <strong>Flow:</strong> Profile notification bell → target video dhundho (title + channel match) → click → watch.
                  Isliye <strong>Channels se video pick</strong> karna best hai — title + channelName save hota hai.
                </div>
                <label className="flex items-center gap-2 text-sm text-gray-300">
                  <input type="checkbox" checked={draft.useFleet}
                    onChange={e => setDraft(d => ({ ...d, useFleet: e.target.checked }))}
                    className="rounded border-gray-600" />
                  <Network size={14} className="text-blue-400" />
                  Fleet laptops par broadcast
                </label>
                {draft.useFleet && (
                  <div className="grid grid-cols-2 gap-1.5 max-h-32 overflow-y-auto">
                    {machines.map(m => (
                      <label key={m.id} className={`flex items-center gap-2 p-2 rounded-lg border text-xs ${
                        draft.fleetMachineIds.includes(m.id) ? 'border-blue-500/40 bg-blue-900/10' : 'border-gray-800'
                      } ${!m.online ? 'opacity-50' : ''}`}>
                        <input type="checkbox" checked={draft.fleetMachineIds.includes(m.id)} disabled={!m.online}
                          onChange={() => setDraft(d => ({
                            ...d,
                            fleetMachineIds: d.fleetMachineIds.includes(m.id)
                              ? d.fleetMachineIds.filter(x => x !== m.id)
                              : [...d.fleetMachineIds, m.id],
                          }))} />
                        <span className="truncate">{m.name}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}

            {editorTab === 'profiles' && (
              <ProfilePickerPanel
                profiles={profiles}
                selectedIds={draft.profileIds}
                onChange={ids => setDraft(d => ({ ...d, profileIds: ids }))}
                maxHeight="min(420px, 55vh)"
              />
            )}

            {editorTab === 'videos' && (
              <ChannelVideoPicker
                channels={channels}
                getVideos={getVideos}
                videos={draft.videos}
                onChange={syncDraftVideos}
              />
            )}

            {editorTab === 'schedule' && (
              <div className="max-w-lg space-y-4">
                <div>
                  <span className="text-xs text-gray-500 flex items-center gap-1 mb-2"><Clock size={12} /> Daily run times</span>
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {draft.dailyTimes.map(t => (
                      <span key={t} className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-gray-800 border border-gray-700 text-xs font-mono">
                        {t}
                        <button type="button" onClick={() => setDraft(d => ({ ...d, dailyTimes: d.dailyTimes.filter(x => x !== t) }))}
                          className="text-gray-500 hover:text-red-400">×</button>
                      </span>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <input type="time" value={newTime} onChange={e => setNewTime(e.target.value)}
                      className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-sm" />
                    <button type="button" onClick={addTimeSlot}
                      className="px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-xs text-gray-300">Add</button>
                  </div>
                  <p className="text-[10px] text-gray-600 mt-2">Upload ke baad jitni baar chahiye utni slots — 09:00, 14:00, 18:00 etc.</p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <label className="text-xs text-gray-500">Gap min (sec)
                    <input type="number" min={0} value={draft.gapMin}
                      onChange={e => setDraft(d => ({ ...d, gapMin: Number(e.target.value) || 0 }))}
                      className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-sm" />
                  </label>
                  <label className="text-xs text-gray-500">Gap max (sec)
                    <input type="number" min={0} value={draft.gapMax}
                      onChange={e => setDraft(d => ({ ...d, gapMax: Number(e.target.value) || 0 }))}
                      className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-sm" />
                  </label>
                </div>
              </div>
            )}
          </div>

          {/* Footer actions */}
          <div className="flex-shrink-0 p-3 border-t border-gray-800 flex flex-wrap gap-2 items-center bg-gray-900/50">
            <button type="button" onClick={() => void saveAll()} disabled={busy}
              className="px-4 py-2 rounded-xl bg-gray-800 border border-gray-700 text-sm flex items-center gap-2 hover:bg-gray-750 disabled:opacity-50">
              <Save size={14} /> Save
            </button>
            <button type="button" onClick={() => void runNow()}
              disabled={busy || !draft.profileIds.length || !draft.videos.length}
              className="px-4 py-2 rounded-xl bg-amber-600 text-white text-sm flex items-center gap-2 hover:bg-amber-500 disabled:opacity-50">
              <Play size={14} /> Run Now
            </button>
            {selectedId && (
              <button type="button" onClick={() => deletePlan(selectedId)} className="ml-auto text-red-400 hover:text-red-300 p-2">
                <Trash2 size={16} />
              </button>
            )}
            {statusRow?.lastRunAt && (
              <span className="text-[10px] text-gray-600 w-full sm:w-auto">
                Last: {new Date(statusRow.lastRunAt).toLocaleString()}
              </span>
            )}
          </div>
        </main>
      </div>

      {/* Collapsible run settings — no overlap on small screens */}
      <div className="flex-shrink-0 border-t border-gray-800 bg-gray-900/80">
        <button type="button" onClick={() => setSettingsOpen(o => !o)}
          className="w-full flex items-center justify-between px-4 py-2 text-xs text-gray-400 hover:text-white">
          <span className="flex items-center gap-2"><Settings2 size={14} /> Run Settings (watch, volume, actions)</span>
          {settingsOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
        {settingsOpen && (
          <div className="px-4 pb-4 max-h-[40vh] overflow-y-auto">
            <ShuffleRunSettingsPanel compact />
          </div>
        )}
      </div>
    </div>
  );
}
