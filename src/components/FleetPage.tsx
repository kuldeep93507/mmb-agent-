import { useState, useEffect, useCallback, Fragment } from 'react';
import {
  Network, Laptop, Play, Square, Plus, Zap, Wifi, WifiOff,
  ChevronDown, ChevronRight, Shuffle, Check, Film, Tv, RefreshCw, Copy, KeyRound, Trash2,
} from 'lucide-react';
import { backendFetch } from '../services/backendOrigin';
import type { Channel, Video } from '../store/useChannelStore';
import ChannelVideoPicker, { type PickableVideo } from './shared/ChannelVideoPicker';
import { useDisabledTrafficSources } from '../hooks/useDisabledTrafficSources';
import { fleetTrafficId } from '../utils/trafficSourceControl';
import { AdControlSettings } from './shared/AdControlSettings';

/* ──────────────────────────────────────────────────────────────────────────
 * FLEET PAGE — multi-laptop control (Overview + Engagement + Shuffle broadcast)
 * ────────────────────────────────────────────────────────────────────────── */

const profKey = (machineId: string, profileId: string) => `${machineId}:${profileId}`;

function shortVideoLabel(raw: string, max = 48): string {
  const s = (raw || '').trim();
  if (!s || s === '—') return '—';
  if (s.startsWith('http')) {
    try {
      const u = new URL(s);
      const v = u.searchParams.get('v');
      return v ? `youtu.be/${v}` : s.replace(/^https?:\/\//, '').slice(0, max);
    } catch { /* ignore */ }
  }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

interface FleetProfile { id: string; name: string; status: 'running' | 'idle' | 'error'; video: string; views: number; }
interface FleetMachine { id: string; name: string; ip: string; online: boolean; profiles: FleetProfile[]; }

const TRAFFIC = ['🎲 Random (per profile)', 'YouTube Search', 'Direct', 'Google', 'Bing', 'Channel Page', 'Notification', 'Homepage'];
const QUALITY = ['auto', '144p', '240p', '360p', '480p', '720p', '1080p'];
// short action keys for the per-profile matrix columns
const ACT = [
  { k: 'like', e: '👍' }, { k: 'dislike', e: '👎' }, { k: 'sub', e: '📺' }, { k: 'bell', e: '🔔' },
  { k: 'comment', e: '💬' }, { k: 'adskip', e: '⏭' }, { k: 'seek', e: '⏩' }, { k: 'quality', e: '🎬' },
  { k: 'autoplay', e: '▶' }, { k: 'captions', e: '🇨' }, { k: 'desc', e: '📄' }, { k: 'links', e: '🔗' },
];
const DEFAULT_ON = new Set(['like', 'sub', 'bell', 'comment', 'adskip', 'seek', 'quality', 'autoplay', 'desc']);

type Tab = 'overview' | 'engagement' | 'shuffle';
const TABS: { id: Tab; label: string; icon: typeof Network }[] = [
  { id: 'overview', label: 'Overview', icon: Laptop },
  { id: 'engagement', label: 'Engagement', icon: Zap },
  { id: 'shuffle', label: 'Video Shuffle', icon: Shuffle },
];

interface FleetPageProps {
  channels?: Channel[];
  getVideos?: (channelId: number, filter?: string) => Video[];
}

export default function FleetPage({ channels: storeChannels = [], getVideos }: FleetPageProps) {
  const { isEnabled: isTrafficOn } = useDisabledTrafficSources();
  const fleetTrafficOptions = TRAFFIC.filter(t => isTrafficOn(fleetTrafficId(t)));
  const [machines, setMachines] = useState<FleetMachine[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [newIp, setNewIp] = useState('');
  const [newKey, setNewKey] = useState('');
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [tab, setTab] = useState<Tab>('overview');

  // ── Real fleet data from backend ──────────────────────────────────────────
  const loadFleet = useCallback(async () => {
    setLoading(true);
    try {
      const r = await backendFetch('/api/fleet/status');
      const d = await r.json();
      if (d.success && Array.isArray(d.machines)) {
        setMachines(d.machines.map((m: any): FleetMachine => ({
          id: m.id, name: m.name, ip: m.address || '', online: !!m.online,
          profiles: (m.profiles || []).map((p: any): FleetProfile => ({
            id: p.id, name: p.name || p.id,
            status: p.status === 'running' || p.status === 'watching' ? 'running' : p.status === 'error' ? 'error' : 'idle',
            video: p.video || '—', views: p.views || 0,
          })),
        })));
      }
    } catch { /* backend down — keep last */ }
    setLoading(false);
  }, []);

  useEffect(() => { void loadFleet(); const t = setInterval(() => void loadFleet(), 8000); return () => clearInterval(t); }, [loadFleet]);

  useEffect(() => {
    if (!machines.length) return;
    setSelMachines(prev => {
      if (prev.size > 0) return prev;
      return new Set(machines.filter(m => m.online).map(m => m.id));
    });
    setExpanded(prev => {
      if (prev.size > 0 && ![...prev].every(id => id === 'm1')) return prev;
      const first = machines[0]?.id;
      return first ? new Set([first]) : prev;
    });
    setEngExpanded(prev => {
      if (prev.size > 0 && ![...prev].every(id => id === 'm1')) return prev;
      const first = machines[0]?.id;
      return first ? new Set([first]) : prev;
    });
  }, [machines]);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [engExpanded, setEngExpanded] = useState<Set<string>>(new Set());
  const [selProfiles, setSelProfiles] = useState<Set<string>>(new Set());
  const [selMachines, setSelMachines] = useState<Set<string>>(new Set());

  // Engagement global defaults
  const [traffic, setTraffic] = useState('🎲 Random (per profile)');
  const [quality, setQuality] = useState('360p');
  const [watchMin, setWatchMin] = useState(80); const [watchMax, setWatchMax] = useState(100);
  const [volMin, setVolMin] = useState(60); const [volMax, setVolMax] = useState(80);
  const [gapMin, setGapMin] = useState(10); const [gapMax, setGapMax] = useState(25);
  const [adSkipMaxSec, setAdSkipMaxSec] = useState(60);
  const [midRollAdWaitSec, setMidRollAdWaitSec] = useState(10);
  const [adClickEnabled, setAdClickEnabled] = useState(false);
  const [adClickDelayMinSec, setAdClickDelayMinSec] = useState(10);
  const [adClickDelayMaxSec, setAdClickDelayMaxSec] = useState(15);
  const [adClickVisitSec, setAdClickVisitSec] = useState(20);
  const [adSkipEnabled, setAdSkipEnabled] = useState(true);
  const [laptopStaggerMin, setLaptopStaggerMin] = useState(0);
  const [laptopStaggerMax, setLaptopStaggerMax] = useState(0);
  /** Per-laptop profile start gap override (empty = use global gapMin/gapMax) */
  const [machineGaps, setMachineGaps] = useState<Record<string, { min: number; max: number }>>({});
  const [smartComment, setSmartComment] = useState(true);
  // PER-PROFILE action overrides: profileId -> Set of action keys ON
  const [profActs, setProfActs] = useState<Record<string, Set<string>>>({});
  const [profTraffic, setProfTraffic] = useState<Record<string, string>>({});

  // Shared video queue (engagement + shuffle) — multi-channel picker
  const [pickableVideos, setPickableVideos] = useState<PickableVideo[]>([]);
  // Shuffle: extra channel pool (sab videos) when explicit queue empty
  const [selChannels, setSelChannels] = useState<Set<number>>(new Set());
  const [assignMode, setAssignMode] = useState<'shuffle' | 'same' | 'roundrobin'>('shuffle');
  const [shufTraffic, setShufTraffic] = useState('🎲 Random (per profile)');
  const [shufWatchMin, setShufWatchMin] = useState(70); const [shufWatchMax, setShufWatchMax] = useState(95);
  const [shufActs, setShufActs] = useState<Set<string>>(new Set(DEFAULT_ON));

  useEffect(() => {
    if (!fleetTrafficOptions.length) return;
    if (!fleetTrafficOptions.includes(traffic)) setTraffic(fleetTrafficOptions[0]);
    if (!fleetTrafficOptions.includes(shufTraffic)) setShufTraffic(fleetTrafficOptions[0]);
  }, [fleetTrafficOptions, traffic, shufTraffic]);

  // This laptop's own connection info (address + API key)
  const [thisLaptop, setThisLaptop] = useState<{ hostname: string; suggestedAddress: string; apiKey: string; lanIps: string[]; tailscaleIps: string[] } | null>(null);
  const [copied, setCopied] = useState('');
  const loadThisLaptop = useCallback(async () => {
    try { const r = await backendFetch('/api/fleet/this-laptop'); const d = await r.json(); if (d.success) setThisLaptop(d); } catch { /* ignore */ }
  }, []);
  useEffect(() => { void loadThisLaptop(); }, [loadThisLaptop]);
  const copy = (text: string, what: string) => { try { void navigator.clipboard.writeText(text); setCopied(what); setTimeout(() => setCopied(''), 1500); } catch { /* ignore */ } };
  const regenKey = async () => {
    try { await backendFetch('/api/fleet/this-laptop/regenerate', { method: 'POST' }); await loadThisLaptop(); } catch { /* ignore */ }
  };

  const activeChannels = storeChannels.filter(c => c.status === 'active' || c.status === 'syncing');
  const channelVideoCounts = useCallback((chId: number) => (getVideos ? getVideos(chId).length : 0), [getVideos]);

  const toggleSet = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) =>
    setter(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleMachineProfiles = (m: FleetMachine) => setSelProfiles(p => {
    const n = new Set(p);
    const keys = m.profiles.map(pr => profKey(m.id, pr.id));
    const all = keys.every(k => n.has(k));
    keys.forEach(k => all ? n.delete(k) : n.add(k));
    return n;
  });
  const actsFor = (machineId: string, pid: string) => profActs[profKey(machineId, pid)] ?? DEFAULT_ON;
  const toggleProfAct = (machineId: string, pid: string, k: string) => setProfActs(prev => {
    const key = profKey(machineId, pid);
    const cur = new Set(prev[key] ?? DEFAULT_ON);
    cur.has(k) ? cur.delete(k) : cur.add(k);
    return { ...prev, [key]: cur };
  });
  const setColForMachine = (m: FleetMachine, k: string, on: boolean) => setProfActs(prev => {
    const next = { ...prev };
    m.profiles.forEach(pr => {
      const key = profKey(m.id, pr.id);
      const cur = new Set(next[key] ?? DEFAULT_ON);
      on ? cur.add(k) : cur.delete(k);
      next[key] = cur;
    });
    return next;
  });

  const addLaptop = async () => {
    if (!newIp.trim()) return;
    try {
      await backendFetch('/api/fleet/machines', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), address: newIp.trim(), apiKey: newKey.trim() }),
      });
    } catch { /* ignore */ }
    setNewName(''); setNewIp(''); setNewKey(''); setTestResult(null); setShowAdd(false);
    await loadFleet();
  };

  const testConnection = async () => {
    if (!newIp.trim()) { setTestResult({ ok: false, text: 'Address daalo pehle' }); return; }
    setTestBusy(true); setTestResult(null);
    try {
      const r = await backendFetch('/api/fleet/test-connection', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: newIp.trim(), apiKey: newKey.trim() }),
      });
      const d = await r.json();
      if (d.ok) {
        const extra = d.agent ? ` · ${d.agent.hostname} · ${d.agent.profilesTotal} profiles` : '';
        setTestResult({ ok: true, text: `✓ Connected${extra}` });
      } else {
        setTestResult({ ok: false, text: d.error || d.message || 'Connection fail' });
      }
    } catch (e) {
      setTestResult({ ok: false, text: String(e) });
    }
    setTestBusy(false);
  };

  const removeLaptop = async (id: string) => {
    try { await backendFetch(`/api/fleet/machines/${id}`, { method: 'DELETE' }); } catch { /* ignore */ }
    await loadFleet();
  };

  // ── Broadcast a fleet action (real fan-out to selected laptops) ────────────
  const [bcResult, setBcResult] = useState<{ kind: string; sent: number; ok: number; failed: number; results: any[] } | null>(null);
  const [bcBusy, setBcBusy] = useState(false);
  const [machineBusy, setMachineBusy] = useState<Record<string, 'start' | 'stop' | null>>({});
  const [overviewMsg, setOverviewMsg] = useState('');

  const gapForMachine = (machineId: string) => machineGaps[machineId] ?? { min: gapMin, max: gapMax };

  const buildFleetPayload = (ids: string[], kind: 'engagement' | 'shuffle') => {
    const actionList = (machineId: string, pid: string) => [...actsFor(machineId, pid)];
    const perMachineProfiles: Record<string, string[]> = {};
    const perMachineProfileActions: Record<string, Record<string, string[]>> = {};
    const perMachineProfileTraffic: Record<string, Record<string, string>> = {};
    for (const mid of ids) {
      const m = machines.find(x => x.id === mid);
      if (!m) continue;
      const selectedOnMachine = m.profiles.filter(p => selProfiles.has(profKey(mid, p.id))).map(p => p.id);
      perMachineProfiles[mid] = selectedOnMachine;
      perMachineProfileActions[mid] = {};
      perMachineProfileTraffic[mid] = {};
      for (const p of m.profiles) {
        if (!perMachineProfiles[mid].includes(p.id)) continue;
        perMachineProfileActions[mid][p.id] = actionList(mid, p.id);
        const tr = profTraffic[profKey(mid, p.id)];
        if (tr && tr !== 'inherit') perMachineProfileTraffic[mid][p.id] = tr;
      }
    }
    const first = machines.find(x => x.id === ids[0]);
    const firstPid = first?.profiles[0]?.id ?? '';
    const perMachineGap: Record<string, { gapMin: number; gapMax: number }> = {};
    for (const mid of ids) {
      const g = gapForMachine(mid);
      perMachineGap[mid] = { gapMin: g.min, gapMax: g.max };
    }
    const videoUrls = pickableVideos.map(v => v.url).filter(Boolean);
    const channelIdsFromVideos = pickableVideos.map(v => v.channelId).filter((x): x is number => x != null);
    const allChannelIds = [...new Set([...selChannels, ...channelIdsFromVideos])].map(String);
    return {
      source: 'fleet', kind,
      videos: videoUrls,
      videoMeta: pickableVideos.map(v => ({ url: v.url, title: v.title, channelName: v.channelName })),
      channelIds: allChannelIds,
      traffic: kind === 'shuffle' ? shufTraffic : traffic,
      watchMin: kind === 'shuffle' ? shufWatchMin : watchMin,
      watchMax: kind === 'shuffle' ? shufWatchMax : watchMax,
      volMin, volMax, gapMin, gapMax, quality, smartComment,
      adSkipEnabled, adSkipMaxSec, midRollAdWaitSec,
      adClickEnabled, adClickDelayMinSec, adClickDelayMaxSec, adClickVisitSec,
      adSkipDelaySec: adSkipMaxSec, adSkipDelayMaxSec: adSkipMaxSec,
      laptopStaggerMin, laptopStaggerMax,
      perMachineGap,
      assignMode: kind === 'shuffle' ? assignMode : undefined,
      actions: actionList(ids[0], firstPid),
      runAllIfEmpty: false,
      perMachineProfiles,
      perMachineProfileActions,
      perMachineProfileTraffic,
    };
  };

  const fleetBroadcast = async (
    ids: string[],
    path: string,
    payload: Record<string, unknown>,
    kind: string,
  ) => {
    const r = await backendFetch('/api/fleet/broadcast', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ machineIds: ids, path, payload }),
    });
    const d = await r.json();
    return { kind, sent: d.sent ?? 0, ok: d.ok ?? 0, failed: d.failed ?? 0, results: d.results ?? [] };
  };

  const broadcastAction = async (kind: 'engagement' | 'shuffle') => {
    if (selMachineProfiles === 0) {
      setBcResult({ kind, sent: 0, ok: 0, failed: 0, results: [{ ok: false, name: 'Fleet', error: 'Pehle profiles select karo (✓ checkbox)' }] });
      return;
    }
    const ids = [...selMachines];
    if (ids.length === 0) { setBcResult({ kind, sent: 0, ok: 0, failed: 0, results: [{ ok: false, name: '—', error: 'Koi laptop selected nahi' }] }); return; }
    if (pickableVideos.length === 0 && selChannels.size === 0) {
      setBcResult({ kind, sent: 0, ok: 0, failed: 0, results: [{ ok: false, name: '—', error: 'Koi video ya channel select nahi' }] });
      return;
    }
    setBcBusy(true); setBcResult(null);
    try {
      setBcResult(await fleetBroadcast(ids, '/api/agent/run-engagement', buildFleetPayload(ids, kind), kind));
    } catch (e) {
      setBcResult({ kind, sent: ids.length, ok: 0, failed: ids.length, results: [{ ok: false, name: 'network', error: String(e) }] });
    }
    setBcBusy(false);
  };

  const startMachine = async (m: FleetMachine) => {
    if (!m.online) return;
    if (pickableVideos.length === 0 && selChannels.size === 0) {
      setOverviewMsg('❌ Pehle Engagement tab mein video ya channel add karo');
      return;
    }
    setMachineBusy(p => ({ ...p, [m.id]: 'start' }));
    setOverviewMsg('');
    try {
      const result = await fleetBroadcast([m.id], '/api/agent/run-engagement', buildFleetPayload([m.id], 'engagement'), 'start');
      setOverviewMsg(result.ok ? `✓ ${m.name} — engagement start ho gaya` : `✕ ${m.name} — start fail`);
      await loadFleet();
    } catch (e) {
      setOverviewMsg(`✕ ${m.name}: ${String(e)}`);
    }
    setMachineBusy(p => ({ ...p, [m.id]: null }));
  };

  const stopMachine = async (m: FleetMachine, stopAllOnMachine = false) => {
    if (!m.online) return;
    setMachineBusy(p => ({ ...p, [m.id]: 'stop' }));
    setOverviewMsg('');
    const selected = m.profiles.filter(p => selProfiles.has(profKey(m.id, p.id))).map(p => p.id);
    const perMachineProfiles: Record<string, string[]> = {
      [m.id]: stopAllOnMachine ? m.profiles.map(p => p.id) : (selected.length ? selected : m.profiles.filter(p => p.status === 'running').map(p => p.id)),
    };
    try {
      const result = await fleetBroadcast([m.id], '/api/agent/stop', {
        stopAll: stopAllOnMachine || perMachineProfiles[m.id].length === 0,
        perMachineProfiles,
      }, 'stop');
      setOverviewMsg(result.ok ? `✓ ${m.name} — stop command bheji` : `✕ ${m.name} — stop fail`);
      await loadFleet();
    } catch (e) {
      setOverviewMsg(`✕ ${m.name}: ${String(e)}`);
    }
    setMachineBusy(p => ({ ...p, [m.id]: null }));
  };

  const stopAllFleet = async () => {
    const ids = machines.filter(m => m.online).map(m => m.id);
    if (!ids.length) { setOverviewMsg('❌ Koi online laptop nahi'); return; }
    setBcBusy(true);
    setOverviewMsg('');
    try {
      const result = await fleetBroadcast(ids, '/api/agent/stop', { stopAll: true }, 'stop-all');
      setOverviewMsg(`✓ Stop all — ${result.ok}/${result.sent} laptops OK`);
      await loadFleet();
    } catch (e) {
      setOverviewMsg(`✕ Stop all fail: ${String(e)}`);
    }
    setBcBusy(false);
  };

  const onlineCount = machines.filter(m => m.online).length;
  const totalProfiles = machines.reduce((a, m) => a + m.profiles.length, 0);
  const totalRunning = machines.reduce((a, m) => a + m.profiles.filter(p => p.status === 'running').length, 0);
  const dot = (s: string) => s === 'running' ? 'var(--mmb-green)' : s === 'error' ? 'var(--mmb-red)' : 'var(--mmb-border2)';
  const selMachineList = machines.filter(m => selMachines.has(m.id));
  const selMachineProfiles = selMachineList.reduce(
    (a, m) => a + m.profiles.filter(p => selProfiles.has(profKey(m.id, p.id))).length,
    0,
  );
  const channelVideoPool = activeChannels.filter(c => selChannels.has(c.id)).reduce((a, c) => a + channelVideoCounts(c.id), 0);
  const toggleChannelPool = (id: number) => setSelChannels(p => {
    const n = new Set(p);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-4 border-b border-gray-800 bg-gray-950/50 flex-shrink-0">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div style={{ width: 44, height: 44, borderRadius: 13, background: 'var(--mmb-grad)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 8px 22px var(--mmb-accent-glow)' }}><Network size={22} color="#fff" /></div>
            <div>
              <h1 className="text-2xl font-bold flex items-center gap-2"><span className="mmb-gradient-text">Fleet Control</span><span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full" style={{ background: 'var(--mmb-green-bg)', color: 'var(--mmb-green)' }}>Live</span></h1>
              <p className="text-gray-500 text-sm mt-0.5">{onlineCount}/{machines.length} laptops · {totalRunning}/{totalProfiles} running · per-profile control</p>
            </div>
          </div>
          <button onClick={() => setShowAdd(true)} className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium" style={{ background: 'var(--mmb-grad)', border: 'none', color: '#fff', boxShadow: '0 4px 12px var(--mmb-accent-glow)' }}><Plus size={14} /> Add Laptop</button>
        </div>
        <div className="flex gap-1 mt-4">
          {TABS.map(t => { const active = tab === t.id; return (<button key={t.id} onClick={() => setTab(t.id)} className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold" style={{ background: active ? 'var(--mmb-grad-soft)' : 'transparent', color: active ? 'var(--mmb-accent)' : 'var(--mmb-muted)', border: active ? '1px solid var(--mmb-border)' : '1px solid transparent', cursor: 'pointer' }}><t.icon size={14} /> {t.label}</button>); })}
        </div>
      </div>

      {/* FULL WIDTH content */}
      <div className="flex-1 overflow-y-auto p-6 space-y-4" style={{ width: '100%' }}>
        {/* OVERVIEW */}
        {tab === 'overview' && (<>
          {/* THIS LAPTOP — apna address + key (dusre laptop pe add karne ke liye) */}
          {thisLaptop && (
            <div className="mmb-card" style={{ padding: 16, background: 'var(--mmb-grad-soft)' }}>
              <div className="flex items-center gap-2 mb-3"><KeyRound size={15} className="text-violet-400" /><span className="font-semibold text-sm" style={{ color: 'var(--mmb-text)' }}>Ye Laptop ({thisLaptop.hostname})</span><span className="text-[10px]" style={{ color: 'var(--mmb-muted)' }}>— isko dusre laptop ke Fleet page pe "Add Laptop" mein daalo</span></div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 12 }}>
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--mmb-muted)' }}>Address (ye copy karo)</div>
                  <div className="flex items-center gap-2">
                    <code className="text-xs px-2.5 py-2 rounded-lg flex-1" style={{ background: 'var(--mmb-surface)', border: '1px solid var(--mmb-border)', color: 'var(--mmb-text)' }}>{thisLaptop.suggestedAddress}</code>
                    <button onClick={() => copy(thisLaptop.suggestedAddress, 'addr')} className="px-2.5 py-2 rounded-lg" style={{ background: 'var(--mmb-surface)', border: '1px solid var(--mmb-border)', color: 'var(--mmb-text2)', cursor: 'pointer' }}>{copied === 'addr' ? <Check size={13} className="text-green-400" /> : <Copy size={13} />}</button>
                  </div>
                  <div className="text-[10px] mt-1" style={{ color: 'var(--mmb-muted)' }}>
                    {thisLaptop.tailscaleIps.length > 0 && <>Tailscale: {thisLaptop.tailscaleIps.join(', ')} · </>}LAN: {thisLaptop.lanIps.join(', ') || '—'}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--mmb-muted)' }}>API Key (ye copy karo)</div>
                  <div className="flex items-center gap-2">
                    <code className="text-xs px-2.5 py-2 rounded-lg flex-1" style={{ background: 'var(--mmb-surface)', border: '1px solid var(--mmb-border)', color: 'var(--mmb-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{thisLaptop.apiKey}</code>
                    <button onClick={() => copy(thisLaptop.apiKey, 'key')} className="px-2.5 py-2 rounded-lg" style={{ background: 'var(--mmb-surface)', border: '1px solid var(--mmb-border)', color: 'var(--mmb-text2)', cursor: 'pointer' }}>{copied === 'key' ? <Check size={13} className="text-green-400" /> : <Copy size={13} />}</button>
                    <button onClick={() => void regenKey()} title="Naya key generate karo" className="px-2.5 py-2 rounded-lg" style={{ background: 'var(--mmb-surface)', border: '1px solid var(--mmb-border)', color: 'var(--mmb-muted)', cursor: 'pointer' }}><RefreshCw size={13} /></button>
                  </div>
                  <div className="text-[10px] mt-1" style={{ color: 'var(--mmb-muted)' }}>🔄 Regenerate = naya key (purana band ho jayega — phir dusre laptops pe update karna)</div>
                </div>
              </div>
            </div>
          )}
          {/* Stagger — user controls clash avoidance */}
          <div className="mmb-card" style={{ padding: 16 }}>
            <SectionTitle icon={<Zap size={15} className="text-amber-400" />} title="Stagger / Start Delay (tum decide karo — clash na ho)" />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 16 }}>
              <RangeField label="⏳ Profile Start Gap — same laptop pe profiles ke beech (s)" min={gapMin} max={gapMax} setMin={setGapMin} setMax={setGapMax} hi={180} />
              <RangeField label="💻 Laptop Stagger — fleet launch pe har laptop ke beech (s)" min={laptopStaggerMin} max={laptopStaggerMax} setMin={setLaptopStaggerMin} setMax={setLaptopStaggerMax} hi={300} />
            </div>
            <p className="text-[11px] mt-2" style={{ color: 'var(--mmb-muted)' }}>
              Profile gap = ek laptop pe Profile_1 → Profile_2 delay. Laptop stagger = Laptop-1 start → Laptop-2 start delay. 0 = turant (parallel).
            </p>
          </div>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <p className="text-xs" style={{ color: 'var(--mmb-muted)' }}>Laptop pe click → profiles · Start = Engagement settings se chalao · Stop = running band</p>
            <div className="flex items-center gap-2">
              {overviewMsg && <span className="text-xs" style={{ color: overviewMsg.startsWith('✓') ? 'var(--mmb-green)' : 'var(--mmb-red)' }}>{overviewMsg}</span>}
              {totalRunning > 0 && (
                <button onClick={() => void stopAllFleet()} disabled={bcBusy} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-40" style={{ background: 'var(--mmb-red-bg)', border: '1px solid var(--mmb-border)', color: 'var(--mmb-red)' }}>
                  <Square size={12} /> Stop All Running
                </button>
              )}
              <button onClick={() => void loadFleet()} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium" style={{ background: 'var(--mmb-surface2)', border: '1px solid var(--mmb-border)', color: 'var(--mmb-text2)' }}><RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh</button>
            </div>
          </div>
          {machines.length === 0 && (
            <div className="mmb-card" style={{ padding: 40, textAlign: 'center' }}>
              <Network size={40} style={{ color: 'var(--mmb-border2)', margin: '0 auto 12px' }} />
              <div className="font-semibold text-sm mb-1" style={{ color: 'var(--mmb-text)' }}>Koi laptop add nahi hai</div>
              <div className="text-xs mb-4" style={{ color: 'var(--mmb-muted)' }}>Upar "Add Laptop" se laptops jodo (Tailscale IP + API key) — phir yahan dikhenge.</div>
              <button onClick={() => setShowAdd(true)} className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold text-white" style={{ background: 'var(--mmb-grad)', border: 'none' }}><Plus size={15} /> Add Laptop</button>
            </div>
          )}
          {machines.map(m => { const exp = expanded.has(m.id); const running = m.profiles.filter(p => p.status === 'running').length; return (
            <div key={m.id} className="mmb-card" style={{ padding: 0, overflow: 'hidden', opacity: m.online ? 1 : 0.65 }}>
              <div className="flex items-center gap-3 px-4 py-3" style={{ borderBottom: exp ? '1px solid var(--mmb-border)' : 'none' }}>
                <button onClick={() => toggleSet(setExpanded, m.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--mmb-muted)' }}>{exp ? <ChevronDown size={18} /> : <ChevronRight size={18} />}</button>
                <Laptop size={18} style={{ color: 'var(--mmb-text2)' }} />
                <div className="min-w-0 flex-1"><div className="font-semibold text-sm" style={{ color: 'var(--mmb-text)' }}>{m.name}</div><div className="font-mono text-[10px]" style={{ color: 'var(--mmb-muted)' }}>{m.ip} · {running}/{m.profiles.length} running</div></div>
                <span className="flex items-center gap-1 text-[11px] font-semibold" style={{ color: m.online ? 'var(--mmb-green)' : 'var(--mmb-red)' }}>{m.online ? <Wifi size={12} /> : <WifiOff size={12} />} {m.online ? 'Online' : 'Offline'}</span>
                <button
                  disabled={!m.online || machineBusy[m.id] === 'start'}
                  onClick={() => void startMachine(m)}
                  title="Engagement tab ki settings se is laptop pe chalao"
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold text-white disabled:opacity-40"
                  style={{ background: 'var(--mmb-green)', border: 'none' }}
                ><Play size={11} /> {machineBusy[m.id] === 'start' ? '…' : 'Start'}</button>
                <button
                  disabled={!m.online || machineBusy[m.id] === 'stop' || running === 0}
                  onClick={() => void stopMachine(m)}
                  title="Selected ya running profiles band karo"
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-40"
                  style={{ background: 'var(--mmb-surface2)', border: '1px solid var(--mmb-border)', color: 'var(--mmb-text2)' }}
                ><Square size={11} /> {machineBusy[m.id] === 'stop' ? '…' : 'Stop'}</button>
                <button onClick={() => void removeLaptop(m.id)} title="Remove laptop from fleet" className="px-2 py-1.5 rounded-lg" style={{ background: 'var(--mmb-surface2)', border: '1px solid var(--mmb-border)', color: 'var(--mmb-muted)', cursor: 'pointer' }}><Trash2 size={12} /></button>
              </div>
              {exp && (<div>
                <div className="flex items-center justify-between px-4 py-2 flex-wrap gap-2" style={{ background: 'var(--mmb-surface2)' }}>
                  <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--mmb-muted)' }}>{m.profiles.length} Profiles</span>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[10px]" style={{ color: 'var(--mmb-muted)' }}>Is laptop ka profile gap (s):</span>
                    <input type="number" min={0} max={180} value={gapForMachine(m.id).min}
                      onChange={e => setMachineGaps(p => ({ ...p, [m.id]: { min: Number(e.target.value), max: gapForMachine(m.id).max } }))}
                      className="mmb-input" style={{ width: 52, padding: '2px 6px', fontSize: 11 }} />
                    <span style={{ color: 'var(--mmb-muted)' }}>–</span>
                    <input type="number" min={0} max={300} value={gapForMachine(m.id).max}
                      onChange={e => setMachineGaps(p => ({ ...p, [m.id]: { min: gapForMachine(m.id).min, max: Number(e.target.value) } }))}
                      className="mmb-input" style={{ width: 52, padding: '2px 6px', fontSize: 11 }} />
                    <button onClick={() => toggleMachineProfiles(m)} className="text-[11px] font-semibold" style={{ color: 'var(--mmb-accent)', background: 'none', border: 'none', cursor: 'pointer' }}>Select all</button>
                  </div>
                </div>
                <table className="mmb-table"><thead><tr><th /><th>Profile</th><th>Live video</th><th /></tr></thead><tbody>{m.profiles.map(p => (
                  <tr key={p.id}>
                    <td style={{ width: 30 }}><input type="checkbox" checked={selProfiles.has(profKey(m.id, p.id))} onChange={() => toggleSet(setSelProfiles, profKey(m.id, p.id))} /></td>
                    <td><span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: dot(p.status), marginRight: 8 }} />{p.name}</td>
                    <td style={{ maxWidth: 280 }} title={p.video}>
                      {p.status === 'running' ? (
                        p.video && p.video !== '—' ? (
                          <span style={{ color: 'var(--mmb-green)', fontWeight: 500 }}>▶ {shortVideoLabel(p.video)}</span>
                        ) : (
                          <span style={{ color: 'var(--mmb-muted)' }}>Starting…</span>
                        )
                      ) : (
                        <span style={{ color: 'var(--mmb-muted)' }}>{shortVideoLabel(p.video)}</span>
                      )}
                    </td>
                    <td style={{ color: 'var(--mmb-accent)', fontWeight: 600 }}>{p.views > 0 ? `👁 ${p.views}` : '—'}</td>
                  </tr>
                ))}</tbody></table>
              </div>)}
            </div>
          ); })}
        </>)}

        {/* ENGAGEMENT — global defaults + PER-PROFILE matrix */}
        {tab === 'engagement' && (<>
          <SelectMachines machines={machines} sel={selMachines} toggle={(id) => toggleSet(setSelMachines, id)} />
          {/* global defaults */}
          <div className="mmb-card" style={{ padding: 16 }}>
            <SectionTitle icon={<Zap size={15} className="text-violet-400" />} title="Global Defaults (har profile inherit karega — neeche override kar sakta hai)" />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 12, marginBottom: 14 }}>
              <Field label="🌐 Traffic Source"><select value={traffic} onChange={e => setTraffic(e.target.value)} className="mmb-input">{fleetTrafficOptions.map(t => <option key={t}>{t}</option>)}</select></Field>
              <Field label="🎬 Quality"><select value={quality} onChange={e => setQuality(e.target.value)} className="mmb-input">{QUALITY.map(q => <option key={q}>{q}</option>)}</select></Field>
              <Field label="💬 Comment"><button onClick={() => setSmartComment(v => !v)} className="mmb-input" style={{ textAlign: 'left', cursor: 'pointer' }}>{smartComment ? '✓ AI Smart Comments' : '✕ Templates only'}</button></Field>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 16 }}>
              <RangeField label="⏱ Watch %" min={watchMin} max={watchMax} setMin={setWatchMin} setMax={setWatchMax} />
              <RangeField label="🔊 Volume %" min={volMin} max={volMax} setMin={setVolMin} setMax={setVolMax} />
              <RangeField label="⏳ Start Gap (s)" min={gapMin} max={gapMax} setMin={setGapMin} setMax={setGapMax} hi={120} />
            </div>
            <div className="mt-3">
              <AdControlSettings
                compact
                values={{
                  adSkipEnabled,
                  adSkipMaxSec,
                  midRollAdWaitSec,
                  adClickEnabled,
                  adClickDelayMinSec,
                  adClickDelayMaxSec,
                  adClickVisitSec,
                }}
                onChange={(patch) => {
                  if (patch.adSkipEnabled !== undefined) setAdSkipEnabled(patch.adSkipEnabled);
                  if (patch.adSkipMaxSec !== undefined) setAdSkipMaxSec(patch.adSkipMaxSec);
                  if (patch.midRollAdWaitSec !== undefined) setMidRollAdWaitSec(patch.midRollAdWaitSec);
                  if (patch.adClickEnabled !== undefined) setAdClickEnabled(patch.adClickEnabled);
                  if (patch.adClickDelayMinSec !== undefined) setAdClickDelayMinSec(patch.adClickDelayMinSec);
                  if (patch.adClickDelayMaxSec !== undefined) setAdClickDelayMaxSec(patch.adClickDelayMaxSec);
                  if (patch.adClickVisitSec !== undefined) setAdClickVisitSec(patch.adClickVisitSec);
                }}
              />
            </div>
            {traffic.startsWith('🎲') && <p className="text-[11px] mt-2" style={{ color: 'var(--mmb-accent)' }}>🎲 Random: har profile alag-alag traffic source uthayega (natural lage).</p>}
          </div>

          <FleetVideoPickerCard
            pickableVideos={pickableVideos}
            onChange={setPickableVideos}
            channels={storeChannels}
            getVideos={getVideos}
          />

          {/* PER-PROFILE matrix */}
          <PerProfileMatrix machines={selMachineList} expanded={engExpanded} onToggleExpand={(id) => toggleSet(setEngExpanded, id)}
            selProfiles={selProfiles} onToggleProfile={(id) => toggleSet(setSelProfiles, id)} onToggleMachineProfiles={toggleMachineProfiles}
            actsFor={actsFor} toggleProfAct={toggleProfAct} setColForMachine={setColForMachine}
            profTraffic={profTraffic} setProfTraffic={setProfTraffic}
            fleetTrafficOptions={fleetTrafficOptions}
            onAllOn={() => { const next: Record<string, Set<string>> = {}; selMachineList.forEach(m => m.profiles.forEach(pr => { next[profKey(m.id, pr.id)] = new Set(ACT.map(a => a.k)); })); setProfActs(next); }}
            onAllOff={() => { const next: Record<string, Set<string>> = {}; selMachineList.forEach(m => m.profiles.forEach(pr => { next[profKey(m.id, pr.id)] = new Set(); })); setProfActs(next); }} />
          <BroadcastResult result={bcResult} kind="engagement" />
          <PushBar label="Launch Engagement on Fleet" count={selMachines.size} profiles={selMachineProfiles} icon={Zap} onClick={() => void broadcastAction('engagement')} busy={bcBusy} />
        </>)}

        {/* SHUFFLE — video queue + channel picker + assignment */}
        {tab === 'shuffle' && (<>
          <SelectMachines machines={machines} sel={selMachines} toggle={(id) => toggleSet(setSelMachines, id)} />
          <FleetVideoPickerCard
            pickableVideos={pickableVideos}
            onChange={setPickableVideos}
            channels={storeChannels}
            getVideos={getVideos}
          />
          <div className="mmb-card" style={{ padding: 16 }}>
            <SectionTitle icon={<Tv size={15} className="text-emerald-400" />} title="Shuffle pool — poora channel (bina specific video pick)" />
            {activeChannels.length === 0 ? (
              <p className="text-xs" style={{ color: 'var(--mmb-muted)' }}>Channels page se channel add karo — phir yahan pool select karo.</p>
            ) : (<>
              <div className="flex flex-wrap gap-2">
                {activeChannels.map(c => { const on = selChannels.has(c.id); return (
                  <button key={c.id} type="button" onClick={() => toggleChannelPool(c.id)} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold" style={{ background: on ? 'var(--mmb-grad)' : 'var(--mmb-surface2)', color: on ? '#fff' : 'var(--mmb-muted)', border: '1px solid var(--mmb-border)', cursor: 'pointer' }}>{on && <Check size={13} />} <Tv size={13} /> {c.channel_name} <span style={{ opacity: 0.7 }}>({channelVideoCounts(c.id)})</span></button>
                ); })}
              </div>
              <p className="text-xs mt-2" style={{ color: 'var(--mmb-muted)' }}>{channelVideoPool} videos pool · upar specific videos pick karo YA yahan channel pool</p>
            </>)}
          </div>
          <div className="mmb-card" style={{ padding: 16 }}>
            <SectionTitle icon={<Shuffle size={15} className="text-red-400" />} title="Shuffle kaise hoga?" />
            <div className="flex gap-2 flex-wrap mb-3">
              {([['shuffle', '🔀 Shuffle — har profile ko random video'], ['roundrobin', '🔁 Round-robin — bari-bari'], ['same', '➡ Same — sabko ek hi video']] as const).map(([k, label]) => (
                <button key={k} onClick={() => setAssignMode(k)} className="px-3 py-2 rounded-lg text-xs font-semibold" style={{ background: assignMode === k ? 'var(--mmb-grad-soft)' : 'var(--mmb-surface2)', color: assignMode === k ? 'var(--mmb-accent)' : 'var(--mmb-muted)', border: '1px solid var(--mmb-border)', cursor: 'pointer' }}>{label}</button>
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 14 }}>
              <Field label="🌐 Traffic Source"><select value={shufTraffic} onChange={e => setShufTraffic(e.target.value)} className="mmb-input">{fleetTrafficOptions.map(t => <option key={t}>{t}</option>)}</select></Field>
              <RangeField label="⏱ Watch %" min={shufWatchMin} max={shufWatchMax} setMin={setShufWatchMin} setMax={setShufWatchMax} />
            </div>
            {/* assignment preview */}
            <div className="text-[11px] font-semibold uppercase tracking-wider mt-3 mb-1.5" style={{ color: 'var(--mmb-muted)' }}>Preview — assignment mode ({assignMode})</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))', gap: 8 }}>
              {selMachineList.slice(0, 2).flatMap(m => m.profiles.slice(0, 3).map((pr, i) => {
                const pool = pickableVideos.length
                  ? pickableVideos.map(v => v.title || v.url)
                  : activeChannels.filter(c => selChannels.has(c.id)).flatMap(c => (getVideos ? getVideos(c.id).slice(0, 3).map(v => v.title) : []));
                const label = assignMode === 'same'
                  ? (pool[0] || '—')
                  : (pool[(i + m.profiles.indexOf(pr)) % Math.max(pool.length, 1)] || '—');
                return (
                <div key={profKey(m.id, pr.id)} className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs" style={{ background: 'var(--mmb-surface2)' }}>
                  <span style={{ color: 'var(--mmb-text2)', minWidth: 80 }}>{m.name.split(' ')[0]}/{pr.name.split('_').pop()}</span>
                  <span style={{ color: 'var(--mmb-muted)' }}>→</span>
                  <Film size={11} className="text-red-400" />
                  <span style={{ color: 'var(--mmb-accent)' }}>{String(label).slice(0, 42)}</span>
                </div>
              );}))}
            </div>
          </div>
          {/* Per-profile actions during shuffle (same matrix as engagement) */}
          <div className="text-[11px] font-semibold uppercase tracking-wider px-1" style={{ color: 'var(--mmb-muted)' }}>Watch ke saath har profile pe ye actions (per-profile)</div>
          <PerProfileMatrix machines={selMachineList} expanded={engExpanded} onToggleExpand={(id) => toggleSet(setEngExpanded, id)}
            selProfiles={selProfiles} onToggleProfile={(id) => toggleSet(setSelProfiles, id)} onToggleMachineProfiles={toggleMachineProfiles}
            actsFor={actsFor} toggleProfAct={toggleProfAct} setColForMachine={setColForMachine}
            profTraffic={profTraffic} setProfTraffic={setProfTraffic}
            fleetTrafficOptions={fleetTrafficOptions}
            onAllOn={() => { const next: Record<string, Set<string>> = {}; selMachineList.forEach(m => m.profiles.forEach(pr => { next[profKey(m.id, pr.id)] = new Set(ACT.map(a => a.k)); })); setProfActs(next); }}
            onAllOff={() => { const next: Record<string, Set<string>> = {}; selMachineList.forEach(m => m.profiles.forEach(pr => { next[profKey(m.id, pr.id)] = new Set(); })); setProfActs(next); }} />
          <BroadcastResult result={bcResult} kind="shuffle" />
          <PushBar label="Run Shuffle on Fleet" count={selMachines.size} profiles={selMachineProfiles} icon={Shuffle} onClick={() => void broadcastAction('shuffle')} busy={bcBusy} />
        </>)}

        <p className="text-center text-xs pt-2" style={{ color: 'var(--mmb-muted)' }}>✅ Overview + laptop registry + engagement/shuffle broadcast = LIVE. Actions, volume, gap, traffic, channels agent tak jaate hain.</p>
      </div>

      {/* Add Laptop modal */}
      {showAdd && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }} onClick={() => { setShowAdd(false); setTestResult(null); }}>
          <div className="mmb-card" style={{ padding: 20, width: 420, maxWidth: '90vw' }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-1"><Laptop size={18} style={{ color: 'var(--mmb-accent)' }} /><span className="font-bold text-base" style={{ color: 'var(--mmb-text)' }}>Add Laptop to Fleet</span></div>
            <p className="text-xs mb-4" style={{ color: 'var(--mmb-muted)' }}>Address = us laptop ke backend ka IP:port. <b>Same WiFi/LAN</b> ho to LAN IP (192.168.x.x:3100). <b>Alag network</b> ho to Tailscale IP (100.x:3100). Khud ke liye 127.0.0.1:3100.</p>
            <div className="space-y-3">
              <Field label="Laptop name"><input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Laptop-6 (Office)" className="mmb-input" /></Field>
              <Field label="Address (LAN ya Tailscale IP : Port)"><input value={newIp} onChange={e => { setNewIp(e.target.value); setTestResult(null); }} placeholder="192.168.1.20:3100  ya  100.64.0.16:3100" className="mmb-input" /></Field>
              <Field label="API key (us laptop ke backend ki key)"><input value={newKey} onChange={e => { setNewKey(e.target.value); setTestResult(null); }} placeholder="mmb-local-dev-2025" className="mmb-input" /></Field>
            </div>
            {testResult && (
              <p className="text-xs mt-3 px-3 py-2 rounded-lg" style={{ background: testResult.ok ? 'var(--mmb-green-bg)' : 'var(--mmb-red-bg)', color: testResult.ok ? 'var(--mmb-green)' : 'var(--mmb-red)' }}>
                {testResult.text}
              </p>
            )}
            <p className="text-[10px] mt-2" style={{ color: 'var(--mmb-muted)' }}>💡 API key = har laptop ke backend ki auth key (abhi sabki same: <span className="font-mono">mmb-local-dev-2025</span>). Settings → API mein change kar sakte ho.</p>
            <div className="flex gap-2 mt-5">
              <button onClick={() => { setShowAdd(false); setTestResult(null); }} className="flex-1 px-4 py-2 rounded-lg text-sm font-semibold" style={{ background: 'var(--mmb-surface2)', border: '1px solid var(--mmb-border)', color: 'var(--mmb-text2)' }}>Cancel</button>
              <button onClick={() => void testConnection()} disabled={testBusy || !newIp.trim()} className="flex-1 px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-40" style={{ background: 'var(--mmb-surface2)', border: '1px solid var(--mmb-border)', color: 'var(--mmb-accent)' }}>{testBusy ? 'Testing…' : 'Test Connection'}</button>
              <button onClick={() => void addLaptop()} className="flex-1 px-4 py-2 rounded-lg text-sm font-bold text-white" style={{ background: 'var(--mmb-grad)', border: 'none' }}>Add Laptop</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function BroadcastResult({ result, kind }: { result: { kind: string; sent: number; ok: number; failed: number; results: any[] } | null; kind: string }) {
  if (!result || result.kind !== kind) return null;
  return (
    <div className="mmb-card" style={{ padding: 14 }}>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-sm font-semibold" style={{ color: 'var(--mmb-text)' }}>Broadcast result</span>
        <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'var(--mmb-green-bg)', color: 'var(--mmb-green)' }}>{result.ok} ok</span>
        {result.failed > 0 && <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'var(--mmb-red-bg)', color: 'var(--mmb-red)' }}>{result.failed} fail</span>}
        <span className="text-xs" style={{ color: 'var(--mmb-muted)' }}>· {result.sent} laptops ko bheja</span>
      </div>
      <div className="space-y-1">
        {result.results.map((r, i) => (
          <div key={i} className="flex items-center gap-2 text-xs px-2 py-1 rounded-lg" style={{ background: 'var(--mmb-surface2)' }}>
            <span style={{ color: r.ok ? 'var(--mmb-green)' : 'var(--mmb-red)' }}>{r.ok ? '✓' : '✕'}</span>
            <span style={{ color: 'var(--mmb-text2)', minWidth: 120 }}>{r.name}</span>
            <span style={{ color: 'var(--mmb-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.ok ? 'accepted' : (r.error || 'failed')}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function pdot(s: string) { return s === 'running' ? 'var(--mmb-green)' : s === 'error' ? 'var(--mmb-red)' : 'var(--mmb-border2)'; }

function PerProfileMatrix(props: {
  machines: FleetMachine[];
  expanded: Set<string>; onToggleExpand: (id: string) => void;
  selProfiles: Set<string>; onToggleProfile: (key: string) => void; onToggleMachineProfiles: (m: FleetMachine) => void;
  actsFor: (machineId: string, pid: string) => Set<string>; toggleProfAct: (machineId: string, pid: string, k: string) => void; setColForMachine: (m: FleetMachine, k: string, on: boolean) => void;
  profTraffic: Record<string, string>; setProfTraffic: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  fleetTrafficOptions: string[];
  onAllOn: () => void; onAllOff: () => void;
}) {
  const { machines, expanded, onToggleExpand, selProfiles, onToggleProfile, onToggleMachineProfiles, actsFor, toggleProfAct, setColForMachine, profTraffic, setProfTraffic, fleetTrafficOptions, onAllOn, onAllOff } = props;
  return (
    <div className="mmb-card" style={{ padding: 0, overflow: 'hidden' }}>
      <div className="px-4 py-3 flex items-center justify-between flex-wrap gap-2" style={{ borderBottom: '1px solid var(--mmb-border)' }}>
        <div><span className="font-semibold text-sm" style={{ color: 'var(--mmb-text)' }}>Per-Profile Actions</span><span className="text-xs ml-2" style={{ color: 'var(--mmb-muted)' }}>har profile ka apna action set</span></div>
        <div className="flex items-center gap-2">
          <button onClick={onAllOn} className="text-[11px] font-semibold px-2.5 py-1 rounded-lg" style={{ color: 'var(--mmb-green)', border: '1px solid var(--mmb-border)', background: 'none', cursor: 'pointer' }}>✓ All actions ON</button>
          <button onClick={onAllOff} className="text-[11px] font-semibold px-2.5 py-1 rounded-lg" style={{ color: 'var(--mmb-red)', border: '1px solid var(--mmb-border)', background: 'none', cursor: 'pointer' }}>✕ All OFF</button>
        </div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="mmb-table" style={{ minWidth: 900 }}>
          <thead><tr>
            <th style={{ width: 30 }}>✓</th><th style={{ minWidth: 150 }}>Profile</th><th style={{ minWidth: 130 }}>Traffic</th>
            {ACT.map(a => <th key={a.k} style={{ textAlign: 'center' }} title={a.k}>{a.e}</th>)}
          </tr></thead>
          <tbody>
            {machines.map(m => {
              const open = expanded.has(m.id);
              return (
                <Fragment key={m.id}>
                  <tr style={{ background: 'var(--mmb-surface2)', cursor: 'pointer' }} onClick={() => onToggleExpand(m.id)}>
                    <td onClick={e => e.stopPropagation()} style={{ textAlign: 'center' }}><input type="checkbox" title="Select all profiles" checked={m.profiles.length > 0 && m.profiles.every(pr => selProfiles.has(profKey(m.id, pr.id)))} onChange={() => onToggleMachineProfiles(m)} /></td>
                    <td colSpan={2} style={{ fontWeight: 700, color: 'var(--mmb-text)' }}>{open ? '▾' : '▸'} {m.name} <span style={{ color: 'var(--mmb-muted)', fontWeight: 400 }}>({m.profiles.length})</span></td>
                    {ACT.map(a => { const allOn = m.profiles.every(pr => actsFor(m.id, pr.id).has(a.k)); return <td key={a.k} style={{ textAlign: 'center' }}><input type="checkbox" checked={allOn} onChange={e => { e.stopPropagation(); setColForMachine(m, a.k, e.target.checked); }} onClick={e => e.stopPropagation()} /></td>; })}
                  </tr>
                  {open && m.profiles.map(pr => (
                    <tr key={pr.id}>
                      <td style={{ textAlign: 'center' }}><input type="checkbox" checked={selProfiles.has(profKey(m.id, pr.id))} onChange={() => onToggleProfile(profKey(m.id, pr.id))} /></td>
                      <td><span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: pdot(pr.status), marginRight: 8 }} />{pr.name}</td>
                      <td><select value={profTraffic[profKey(m.id, pr.id)] ?? 'inherit'} onChange={e => setProfTraffic(p => ({ ...p, [profKey(m.id, pr.id)]: e.target.value }))} className="mmb-input" style={{ padding: '3px 6px', fontSize: 11 }}><option value="inherit">↑ Inherit</option>{fleetTrafficOptions.map((t: string) => <option key={t} value={t}>{t.replace('🎲 Random (per profile)', '🎲 Random')}</option>)}</select></td>
                      {ACT.map(a => { const on = actsFor(m.id, pr.id).has(a.k); return <td key={a.k} style={{ textAlign: 'center' }}><input type="checkbox" checked={on} onChange={() => toggleProfAct(m.id, pr.id, a.k)} /></td>; })}
                    </tr>
                  ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FleetVideoPickerCard({ pickableVideos, onChange, channels, getVideos }: {
  pickableVideos: PickableVideo[];
  onChange: (v: PickableVideo[]) => void;
  channels: Channel[];
  getVideos?: (channelId: number, filter?: string) => Video[];
}) {
  return (
    <div className="mmb-card" style={{ padding: 16 }}>
      <SectionTitle icon={<Film size={15} className="text-red-400" />} title={`Video Queue (${pickableVideos.length}) — multi-channel pick`} />
      {getVideos ? (
        <ChannelVideoPicker channels={channels} getVideos={getVideos} videos={pickableVideos} onChange={onChange} />
      ) : (
        <p className="text-xs" style={{ color: 'var(--mmb-muted)' }}>Channels load ho rahe hain…</p>
      )}
    </div>
  );
}

function SectionTitle({ icon, title }: { icon: React.ReactNode; title: string }) {
  return <div className="flex items-center gap-2 mb-4">{icon}<span className="font-semibold text-sm" style={{ color: 'var(--mmb-text)' }}>{title}</span></div>;
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className="text-xs block mb-1" style={{ color: 'var(--mmb-muted)' }}>{label}</label>{children}</div>;
}
function RangeField({ label, min, max, setMin, setMax, hi = 100 }: { label: string; min: number; max: number; setMin: (n: number) => void; setMax: (n: number) => void; hi?: number }) {
  return (
    <div>
      <label className="text-xs block mb-1" style={{ color: 'var(--mmb-muted)' }}>{label} <b style={{ color: 'var(--mmb-text2)' }}>{min}–{max}</b></label>
      <div className="flex items-center gap-1.5">
        <input type="number" min={0} max={hi} value={min} onChange={e => { const v = Number(e.target.value); setMin(v); if (v > max) setMax(v); }} className="mmb-input" style={{ width: 64 }} />
        <span style={{ color: 'var(--mmb-muted)' }}>–</span>
        <input type="number" min={0} max={hi} value={max} onChange={e => { const v = Number(e.target.value); setMax(v); if (v < min) setMin(v); }} className="mmb-input" style={{ width: 64 }} />
      </div>
    </div>
  );
}
function SelectMachines({ machines, sel, toggle }: { machines: FleetMachine[]; sel: Set<string>; toggle: (id: string) => void }) {
  return (
    <div className="mmb-card" style={{ padding: 12 }}>
      <div className="text-[11px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--mmb-muted)' }}>Kaunse laptops pe?</div>
      <div className="flex gap-2 flex-wrap">{machines.map(m => { const on = sel.has(m.id); return (
        <button key={m.id} onClick={() => toggle(m.id)} disabled={!m.online} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-40" style={{ background: on ? 'var(--mmb-grad)' : 'var(--mmb-surface2)', color: on ? '#fff' : 'var(--mmb-muted)', border: '1px solid var(--mmb-border)', cursor: m.online ? 'pointer' : 'not-allowed' }}>{on && <Check size={12} />} {m.name} <span style={{ opacity: 0.7 }}>({m.profiles.length})</span></button>
      ); })}</div>
    </div>
  );
}
function PushBar({ label, count, profiles, icon: Icon, onClick, busy }: { label: string; count: number; profiles: number; icon: typeof Network; onClick?: () => void; busy?: boolean }) {
  return (
    <div className="mmb-card" style={{ padding: 12, display: 'flex', alignItems: 'center', gap: 10, position: 'sticky', bottom: 0 }}>
      <span className="text-sm" style={{ color: 'var(--mmb-muted)' }}>→ <b style={{ color: 'var(--mmb-text)' }}>{count}</b> laptops · <b style={{ color: 'var(--mmb-text)' }}>{profiles}</b> profiles</span>
      <button onClick={onClick} disabled={busy} className="ml-auto flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-50" style={{ background: 'var(--mmb-grad)', boxShadow: '0 6px 18px var(--mmb-accent-glow)', border: 'none' }}>{busy ? <RefreshCw size={15} className="animate-spin" /> : <Icon size={15} />} {label}</button>
    </div>
  );
}
