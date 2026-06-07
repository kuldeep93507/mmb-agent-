import { useState, useEffect, useCallback } from 'react';
import { Activity, Pause, SkipForward, Square, AlertCircle, RefreshCw, Cpu, Globe, Clock, Wifi, WifiOff } from 'lucide-react';
import LiveProgressPanel from './LiveProgressPanel';
import { backendFetch } from '../services/backendOrigin';
import type { Profile } from '../types';
import { fetchEngagementStatus, type EngagementStatusResponse } from '../utils/dashboardApi';
import {
  fetchRecycleStatus,
  stopRecycleLoop,
  pauseRecycleLoop,
  resumeRecycleLoop,
  type RecycleStatus,
} from '../utils/recycleApi';
import { PageShell, Card, CardHeader, Btn } from './ui';

interface OrchestratorStatus {
  current_hour: number;
  hour_weight: number;
  peak_hour: number;
  ram: { percent: number | null; available_gb: number; total_gb: number; note?: string };
  hourly_weights: Record<number, number>;
}

interface MonitorPageProps {
  profiles?: Profile[];
  onRefreshProfiles?: () => void;
  onStartRecycle?: () => Promise<unknown>;
  canStartRecycle?: boolean;
  setActiveTab?: (tab: string) => void;
}

export default function MonitorPage({
  profiles = [],
  onRefreshProfiles,
  onStartRecycle,
  canStartRecycle = false,
  setActiveTab,
}: MonitorPageProps) {
  const [recycleStatus, setRecycleStatus] = useState<RecycleStatus | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [orchStatus, setOrchStatus] = useState<OrchestratorStatus | null>(null);
  const [engStatus, setEngStatus] = useState<EngagementStatusResponse | null>(null);
  const [backendOk, setBackendOk] = useState(true);

  const fetchOrchStatus = useCallback(async () => {
    try {
      const res = await backendFetch('/api/orchestrator/status', { signal: AbortSignal.timeout(5000) });
      if (res.ok) setOrchStatus(await res.json() as OrchestratorStatus);
    } catch { /* non-fatal */ }
  }, []);

  const refreshAll = useCallback(async () => {
    try {
      const [wR, e] = await Promise.all([
        backendFetch('/api/workers'),
        fetchEngagementStatus(),
      ]);
      if (wR.ok) {
        setPollError(null);
        setBackendOk(true);
      } else if (wR.status === 401) {
        setPollError('Backend API key missing — check .env BACKEND_API_KEY and hard-refresh (Ctrl+Shift+R)');
        setBackendOk(false);
      } else {
        setPollError(`Backend error (HTTP ${wR.status})`);
        setBackendOk(false);
      }
      setEngStatus(e);
    } catch (err) {
      setPollError(err instanceof Error ? err.message : 'Backend unreachable — is python server running on port 3100?');
      setBackendOk(false);
    }
    const s = await fetchRecycleStatus();
    if (s) setRecycleStatus(s);
    void fetchOrchStatus();
  }, [fetchOrchStatus]);

  useEffect(() => {
    void refreshAll();
    const iv = setInterval(() => void refreshAll(), 5000);
    return () => clearInterval(iv);
  }, [refreshAll]);

  useEffect(() => {
    const poll = () => { void fetchRecycleStatus().then(s => { if (s) setRecycleStatus(s); }); };
    poll();
    const iv = setInterval(poll, 3000);
    return () => clearInterval(iv);
  }, []);

  const recycleActive = !!(recycleStatus?.enabled && recycleStatus.slots.some(s => s.enabled));
  const isPausedAll = recycleActive && recycleStatus!.slots.filter(s => s.enabled).every(s => s.isPaused);
  const activeProfiles = profiles.filter(p => ['running', 'starting', 'watching'].includes(p.status)).length;
  const engRunning = (engStatus?.running ?? 0) + (engStatus?.pending ?? 0);

  const withBusy = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); } finally {
      setBusy(false);
      const s = await fetchRecycleStatus();
      if (s) setRecycleStatus(s);
    }
  };

  const statBox = (label: string, value: string, sub: string, color: string) => (
    <div style={{
      background: 'var(--mmb-surface2)', borderRadius: 10, padding: '12px 14px', textAlign: 'center',
      border: '1px solid var(--mmb-border)',
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--mmb-muted)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--mmb-muted)', marginTop: 4 }}>{sub}</div>
    </div>
  );

  return (
    <PageShell>
      <div style={{ maxWidth: 1400, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Header */}
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 42, height: 42, borderRadius: 12,
              background: recycleActive ? 'var(--mmb-green-bg)' : 'var(--mmb-surface2)',
              border: `1px solid ${recycleActive ? 'var(--mmb-green)' : 'var(--mmb-border)'}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Activity size={20} style={{ color: recycleActive ? 'var(--mmb-green)' : 'var(--mmb-muted)' }} />
            </div>
            <div>
              <h1 style={{ fontSize: 18, fontWeight: 800, color: 'var(--mmb-text)', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                Live Monitor
                {recycleActive && <span className="mmb-badge-green">24/7 Active</span>}
                {isPausedAll && <span className="mmb-badge-yellow">Paused</span>}
              </h1>
              <p style={{ fontSize: 12, color: 'var(--mmb-muted)', margin: '4px 0 0' }}>
                Workers · engagement · recycle loop — real-time (5s refresh)
              </p>
            </div>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              fontSize: 10, fontWeight: 600, padding: '3px 10px', borderRadius: 99,
              background: backendOk ? 'var(--mmb-green-bg)' : 'var(--mmb-red-bg)',
              color: backendOk ? 'var(--mmb-green)' : 'var(--mmb-red)',
            }}>
              {backendOk ? <Wifi size={10}/> : <WifiOff size={10}/>}
              {backendOk ? 'Live · 5s' : 'Offline'}
            </span>
            <Btn onClick={() => { setRefreshToken(t => t + 1); void refreshAll(); }} icon={<RefreshCw size={12}/>}>Refresh</Btn>
            {recycleActive && !isPausedAll && (
              <Btn onClick={() => void withBusy(pauseRecycleLoop)} disabled={busy} icon={<Pause size={12}/>}>Pause 24/7</Btn>
            )}
            {recycleActive && isPausedAll && (
              <Btn onClick={() => void withBusy(resumeRecycleLoop)} disabled={busy} icon={<SkipForward size={12}/>}>Resume 24/7</Btn>
            )}
            {recycleActive && (
              <Btn onClick={() => void withBusy(() => stopRecycleLoop())} disabled={busy} variant="danger" icon={<Square size={12}/>}>Stop 24/7</Btn>
            )}
            {setActiveTab && (
              <Btn onClick={() => setActiveTab('engagement')}>Engagement →</Btn>
            )}
          </div>
        </div>

        {pollError && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderRadius: 10,
            background: 'var(--mmb-red-bg)', border: '1px solid var(--mmb-red)', fontSize: 13,
          }}>
            <AlertCircle size={16} style={{ color: 'var(--mmb-red)', flexShrink: 0 }}/>
            <p style={{ margin: 0, color: 'var(--mmb-text2)' }}>{pollError}</p>
          </div>
        )}

        {isPausedAll && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderRadius: 10,
            background: 'var(--mmb-yellow-bg)', border: '1px solid var(--mmb-yellow)', fontSize: 13,
          }}>
            <Pause size={16} style={{ color: 'var(--mmb-yellow)', flexShrink: 0 }}/>
            <p style={{ margin: 0, flex: 1, color: 'var(--mmb-text2)' }}>
              24/7 loop is <strong>paused</strong> — resume to restart profiles.
            </p>
            <Btn onClick={() => void withBusy(resumeRecycleLoop)} disabled={busy} icon={<SkipForward size={12}/>}>Resume Now</Btn>
          </div>
        )}

        {/* Live stats row */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
          {statBox('Profiles', String(profiles.length), `${activeProfiles} active now`, 'var(--mmb-accent)')}
          {statBox('Engagement', String(engRunning), `${engStatus?.done ?? 0} done today`, 'var(--mmb-green)')}
          {statBox('Recycle Slots', String(recycleStatus?.slots?.filter(s => s.enabled).length ?? 0), recycleActive ? 'loop running' : 'idle', recycleActive ? 'var(--mmb-green)' : 'var(--mmb-muted)')}
          {statBox('Server RAM', orchStatus?.ram?.percent != null ? `${orchStatus.ram.percent.toFixed(0)}%` : '—', orchStatus?.ram?.available_gb != null ? `${orchStatus.ram.available_gb.toFixed(1)}GB free` : 'orchestrator', orchStatus?.ram?.percent != null && orchStatus.ram.percent >= 90 ? 'var(--mmb-red)' : 'var(--mmb-blue)')}
        </div>

        {/* Orchestrator card */}
        {orchStatus && (
          <Card>
            <CardHeader
              title="Orchestrator Status"
              action={
                <Btn onClick={() => void fetchOrchStatus()} icon={<RefreshCw size={11}/>}>Update</Btn>
              }
            />
            <div style={{ padding: '14px 16px 16px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 16 }}>
                <div style={{ background: 'var(--mmb-surface2)', borderRadius: 10, padding: 12, textAlign: 'center', border: '1px solid var(--mmb-border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, marginBottom: 4 }}>
                    <Clock size={12} style={{ color: 'var(--mmb-blue)' }}/>
                    <span style={{ fontSize: 11, color: 'var(--mmb-muted)' }}>Current Hour</span>
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--mmb-text)' }}>{orchStatus.current_hour}:00</div>
                  <div style={{ fontSize: 11, marginTop: 4, color: orchStatus.hour_weight >= 0.8 ? 'var(--mmb-green)' : orchStatus.hour_weight >= 0.5 ? 'var(--mmb-yellow)' : 'var(--mmb-muted)' }}>
                    Weight {(orchStatus.hour_weight * 100).toFixed(0)}%
                  </div>
                </div>
                <div style={{ background: 'var(--mmb-surface2)', borderRadius: 10, padding: 12, textAlign: 'center', border: '1px solid var(--mmb-border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, marginBottom: 4 }}>
                    <Cpu size={12} style={{ color: 'var(--mmb-yellow)' }}/>
                    <span style={{ fontSize: 11, color: 'var(--mmb-muted)' }}>RAM</span>
                  </div>
                  {orchStatus.ram.percent != null ? (
                    <>
                      <div style={{ fontSize: 18, fontWeight: 800, color: orchStatus.ram.percent >= 92 ? 'var(--mmb-red)' : orchStatus.ram.percent >= 82 ? 'var(--mmb-yellow)' : 'var(--mmb-green)' }}>
                        {orchStatus.ram.percent.toFixed(0)}%
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--mmb-muted)', marginTop: 4 }}>
                        {orchStatus.ram.available_gb.toFixed(1)}GB / {orchStatus.ram.total_gb.toFixed(0)}GB
                      </div>
                    </>
                  ) : (
                    <div style={{ fontSize: 12, color: 'var(--mmb-muted)' }}>{orchStatus.ram.note || 'N/A'}</div>
                  )}
                </div>
                <div style={{ background: 'var(--mmb-surface2)', borderRadius: 10, padding: 12, textAlign: 'center', border: '1px solid var(--mmb-border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, marginBottom: 4 }}>
                    <Globe size={12} style={{ color: 'var(--mmb-green)' }}/>
                    <span style={{ fontSize: 11, color: 'var(--mmb-muted)' }}>Profiles Loaded</span>
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--mmb-green)' }}>{profiles.length}</div>
                  <div style={{ fontSize: 11, color: 'var(--mmb-muted)', marginTop: 4 }}>Proxy · Geo · TZ per profile</div>
                </div>
              </div>

              <div style={{ fontSize: 11, color: 'var(--mmb-muted)', marginBottom: 8 }}>
                24h traffic weights — peak {orchStatus.peak_hour}:00
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 44 }}>
                {Array.from({ length: 24 }, (_, h) => {
                  const w = orchStatus.hourly_weights?.[h] ?? 0.5;
                  const isNow = h === orchStatus.current_hour;
                  const heightPct = Math.max(10, Math.round(w * 100));
                  const barColor = isNow ? 'var(--mmb-accent)' : w >= 0.8 ? 'var(--mmb-green)' : w >= 0.5 ? 'var(--mmb-yellow)' : 'var(--mmb-border2)';
                  return (
                    <div key={h} title={`${h}:00 — ${(w * 100).toFixed(0)}%${isNow ? ' (now)' : ''}`}
                      style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
                      <div style={{ height: `${heightPct}%`, minHeight: 4, borderRadius: 3, background: barColor, transition: 'height .3s' }}/>
                    </div>
                  );
                })}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--mmb-muted)', marginTop: 6 }}>
                <span>0:00</span><span>6:00</span><span>12:00</span><span>18:00</span><span>23:00</span>
              </div>
            </div>
          </Card>
        )}

        {/* Active engagement jobs */}
        {(engStatus?.jobs?.filter(j => ['running', 'pending', 'partial'].includes(j.status)).length ?? 0) > 0 && (
          <Card>
            <CardHeader title="Active Engagement Jobs" action={<span className="mmb-badge-green">{engRunning} live</span>} />
            <div style={{ padding: '0 0 8px' }}>
              {engStatus!.jobs.filter(j => ['running', 'pending', 'partial'].includes(j.status)).slice(0, 8).map(job => (
                <div key={job.id} style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px',
                  borderBottom: '1px solid var(--mmb-border)', fontSize: 12,
                }}>
                  <span style={{
                    width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                    background: job.status === 'running' ? 'var(--mmb-green)' : 'var(--mmb-yellow)',
                    boxShadow: job.status === 'running' ? '0 0 0 0 var(--mmb-green)' : undefined,
                    animation: job.status === 'running' ? 'mmb-pulse-dot 1.5s ease-out infinite' : undefined,
                  }}/>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, color: 'var(--mmb-text)' }}>{job.profileName || job.profileId.slice(0, 12)}</div>
                    <div style={{ color: 'var(--mmb-muted)', fontSize: 11 }}>
                      {job.videosOk ?? 0}/{job.videoCount ?? '?'} videos · {job.status}
                      {job.log?.length ? (
                        <span style={{ display: 'block', marginTop: 4, color: 'var(--mmb-text)', opacity: 0.85 }}>
                          {job.log[job.log.length - 1]?.msg?.slice(0, 120)}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

        <LiveProgressPanel
          profiles={profiles}
          hideWhenIdle={false}
          showRecycleControls
          showMonitorActions
          refreshToken={refreshToken}
          onStartRecycle={onStartRecycle as (() => Promise<void>) | undefined}
          canStartRecycle={canStartRecycle}
          onRefreshProfiles={onRefreshProfiles}
          engagementJobs={engStatus?.jobs || []}
          runLabel="Live Monitor"
        />
      </div>
    </PageShell>
  );
}
