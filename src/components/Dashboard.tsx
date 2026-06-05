import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Users, Play, Globe, BarChart3, Eye, Clock,
  StopCircle, RefreshCw, AlertTriangle, ChevronRight,
  Tv, Calendar, Shuffle, Link2, Settings, WifiOff, Wifi,
  ThumbsUp, Bell, MessageSquare,
} from 'lucide-react';
import type { Profile } from '../types';
import { backendFetch } from '../services/backendOrigin';
import {
  fetchBackendHealth, fetchConcurrency, fetchAnalytics, fetchEngagementStatus,
  formatWatchTime, type BackendHealth,
} from '../utils/dashboardApi';
import { stopScheduleRun } from '../utils/shuffleApi';

/* ─── Types ────────────────────────────────────────────────────────────────── */
interface WorkerRow {
  profileId: string; profileName?: string; status: string;
  currentVideo: string | null; progress: string;
  startedAt?: number; uptime?: number;
}
interface DashboardProps { profiles: Profile[]; setActiveTab: (tab: string) => void; }

/* ─── Helpers ──────────────────────────────────────────────────────────────── */
const LIVE_SET = new Set(['running','watching','searching','connecting','starting','waiting']);
const isLive = (s: string) => LIVE_SET.has(s);

function workerMeta(s: string) {
  if (['watching','running'].includes(s))                return { color:'#16a34a', bg:'#dcfce7', label:'Watching'  };
  if (['starting','connecting','searching'].includes(s)) return { color:'#4f46e5', bg:'#eef2ff', label: s.charAt(0).toUpperCase()+s.slice(1) };
  if (s === 'waiting')                                   return { color:'#d97706', bg:'#fef3c7', label:'Queued'    };
  if (['error','crashed'].includes(s))                   return { color:'#dc2626', bg:'#fee2e2', label:'Error'     };
  return                                                        { color:'#6b7280', bg:'var(--mmb-surface2)', label: s.charAt(0).toUpperCase()+s.slice(1) };
}

function fmtUp(ms?: number) {
  if (!ms||ms<1000) return '';
  const s=Math.floor(ms/1000); if(s<60) return `${s}s`;
  const m=Math.floor(s/60); return m<60?`${m}m`:`${Math.floor(m/60)}h${m%60}m`;
}

const TRAFFIC_CFG = [
  { key:'trafficYouTube',  label:'YouTube Search', color:'#ef4444' },
  { key:'trafficGoogle',   label:'Google',         color:'#3b82f6' },
  { key:'trafficBing',     label:'Bing',           color:'#8b5cf6' },
  { key:'trafficDirect',   label:'Direct URL',     color:'#f59e0b' },
  { key:'trafficChannel',  label:'Channel Page',   color:'#22c55e' },
  { key:'trafficBacklink', label:'Backlink',       color:'#ec4899' },
] as const;

/* ─── Sub-components ───────────────────────────────────────────────────────── */
function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: 'var(--mmb-surface)',
      border: '1px solid var(--mmb-border)',
      borderRadius: 12,
      boxShadow: 'var(--mmb-shadow)',
      ...style,
    }}>
      {children}
    </div>
  );
}

function CardHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'14px 16px 0', marginBottom: 12 }}>
      <span style={{ fontSize:13, fontWeight:700, color:'var(--mmb-text)' }}>{title}</span>
      {action}
    </div>
  );
}

function Btn({ onClick, children, danger, disabled, small }: { onClick?:()=>void; children:React.ReactNode; danger?:boolean; disabled?:boolean; small?:boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      display:'flex', alignItems:'center', gap:5,
      padding: small ? '5px 10px' : '7px 14px',
      borderRadius: 8, border: danger ? '1px solid var(--mmb-red)' : '1px solid var(--mmb-border)',
      background: danger ? 'var(--mmb-red-bg)' : 'var(--mmb-surface)',
      color: danger ? 'var(--mmb-red)' : 'var(--mmb-text2)',
      fontSize: 12, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? .6 : 1, transition: 'all .15s', flexShrink: 0,
    }}>
      {children}
    </button>
  );
}

function PrimaryBtn({ onClick, children, disabled }: { onClick?:()=>void; children:React.ReactNode; disabled?:boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      display:'flex', alignItems:'center', gap:5,
      padding:'7px 16px', borderRadius:8, border:'none',
      background:'var(--mmb-accent)', color:'#fff',
      fontSize:12, fontWeight:600, cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? .6 : 1, transition:'all .15s', flexShrink:0,
    }}>
      {children}
    </button>
  );
}

function StatusDot({ color, pulse }: { color:string; pulse?:boolean }) {
  return (
    <span style={{
      display:'inline-block', width:7, height:7, borderRadius:'50%', background:color,
      boxShadow: pulse ? `0 0 0 0 ${color}` : 'none',
      animation: pulse ? 'mmb-pulse-dot 1.5s ease-out infinite' : 'none',
    }}/>
  );
}

/* ─── KPI Card ─────────────────────────────────────────────────────────────── */
function KpiCard({ label, val, sub, icon: Icon, accentColor, live }:{
  label:string; val:string; sub:string; icon:React.ElementType; accentColor:string; live?:boolean;
}) {
  return (
    <Card style={{ overflow:'hidden' }}>
      <div style={{ height:3, background:accentColor, borderRadius:'12px 12px 0 0' }}/>
      <div style={{ padding:'12px 14px' }}>
        <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:8 }}>
          <div style={{ fontSize:10, fontWeight:700, color:'var(--mmb-muted)', textTransform:'uppercase', letterSpacing:'.05em' }}>
            {label}
          </div>
          <div style={{
            width:26, height:26, borderRadius:7,
            background:`${accentColor}18`,
            display:'flex', alignItems:'center', justifyContent:'center',
          }}>
            <Icon size={13} style={{ color: accentColor }} />
          </div>
        </div>
        <div style={{ display:'flex', alignItems:'baseline', gap:6 }}>
          <div style={{ fontSize:22, fontWeight:800, color:'var(--mmb-text)', lineHeight:1 }}>{val}</div>
          {live && (
            <span style={{ display:'flex', alignItems:'center', gap:4, fontSize:10, color:'var(--mmb-green)', fontWeight:600 }}>
              <StatusDot color="var(--mmb-green)" pulse/> live
            </span>
          )}
        </div>
        <div style={{ fontSize:11, color:'var(--mmb-muted)', marginTop:4 }}>{sub}</div>
      </div>
    </Card>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════════
   DASHBOARD
═══════════════════════════════════════════════════════════════════════════════ */
export default function Dashboard({ profiles, setActiveTab }: DashboardProps) {
  const [workers, setWorkers]    = useState<WorkerRow[]>([]);
  const [wStats,  setWStats]     = useState({total:0,running:0,done:0,error:0,waiting:0});
  const [health,  setHealth]     = useState<BackendHealth|null>(null);
  const [conc,    setConc]       = useState<{limit:number;running:number;available:number}|null>(null);
  const [engStatus,setEngStatus] = useState<Awaited<ReturnType<typeof import('../utils/dashboardApi').fetchEngagementStatus>>>(null);
  const [data,    setData]       = useState<Awaited<ReturnType<typeof fetchAnalytics>>>(null);
  const [offline, setOffline]    = useState(false);
  const [stopping,setStopping]   = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [wR,h,c,a,e] = await Promise.all([
        backendFetch('/api/workers'), fetchBackendHealth(),
        fetchConcurrency(), fetchAnalytics('today'),
        fetchEngagementStatus(),
      ]);
      if (!wR.ok) throw new Error();
      const wd = await wR.json();
      setWorkers(wd.workers||[]); setWStats(wd.stats||{total:0,running:0,done:0,error:0,waiting:0});
      setHealth(h);
      setConc(h?.concurrency ?? c);
      setData(a);
      setEngStatus(e);
      setOffline(false);
    } catch { setOffline(true); }
  }, []);

  useEffect(() => { refresh(); const id=setInterval(refresh,5000); return ()=>clearInterval(id); }, [refresh]);

  /* Derived */
  const liveW    = workers.filter(w => isLive(w.status));
  const now      = Date.now();
  const pExpired = profiles.filter(p=>p.proxy.expiresAt>0&&p.proxy.expiresAt<now).length;
  const pWarn    = profiles.filter(p=>p.proxy.expiresAt>now&&p.proxy.expiresAt<now+7200000).length;
  const totalLive= Math.max(liveW.length, profiles.filter(p=>['running','starting'].includes(p.status)).length);

  const totalTraffic = TRAFFIC_CFG.reduce((s,{key})=>s+(data?.[key]??0),0);
  const trafficRows  = useMemo(()=>
    TRAFFIC_CFG.map(({key,label,color})=>({label,color,value:data?.[key]??0}))
               .filter(r=>r.value>0).sort((a,b)=>b.value-a.value)
  ,[data]);

  const recent = useMemo(()=>(data?.recentActivity||[]).slice(-8).reverse(),[data]);

  const stopAll = async () => {
    if (!window.confirm('Stop all running workers?')) return;
    setStopping(true); await stopScheduleRun(''); await refresh(); setStopping(false);
  };

  const avgSessionMin = data?.totalSessions
    ? Math.round((data.totalWatchTime || 0) / data.totalSessions / 60)
    : 0;
  const engRunning = (engStatus?.running ?? 0) + (engStatus?.pending ?? 0);

  /* KPIs */
  const kpis = [
    { label:'Live Workers', val: totalLive.toString(),
      sub: totalLive>0?`${liveW.length} watching now`:`${profiles.length} profiles ready`,
      icon:Play, accentColor:'#16a34a', live:totalLive>0 },
    { label:"Today's Views", val:(data?.totalViews??0).toLocaleString(),
      sub:`${data?.totalSessions??0} sessions · ${engRunning} engagement jobs`,
      icon:Eye, accentColor:'#2563eb', live: engRunning>0 },
    { label:'Watch Time', val: data?formatWatchTime(Math.round(data.totalWatchTime||0)):'—',
      sub:`avg ${avgSessionMin}m per session`,
      icon:Clock, accentColor:'#7c3aed' },
    { label:'Proxy Health',
      val: pExpired>0?`${pExpired} Error`:pWarn>0?`${pWarn} Warn`:'OK',
      sub: pExpired>0?`${pExpired} expired!`:pWarn>0?`${pWarn} expiring soon`:`${profiles.length} profiles tracked`,
      icon:Globe,
      accentColor: pExpired>0?'#dc2626':pWarn>0?'#d97706':'#16a34a' },
  ];

  return (
    <div style={{ flex:1, overflowY:'auto', background:'var(--mmb-bg)', padding:'16px 20px' }}>
      <div style={{ maxWidth:1400, margin:'0 auto', display:'flex', flexDirection:'column', gap:14 }}>

        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:10 }}>
          <div style={{ display:'flex', alignItems:'center', gap:12 }}>
            <h1 style={{ fontSize:18, fontWeight:800, color:'var(--mmb-text)', margin:0 }}>Dashboard</h1>
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
              <span style={{ fontSize:11, color:'var(--mmb-muted)' }}>
                {new Date().toLocaleDateString('en-IN', { weekday:'short', month:'short', day:'numeric' })}
              </span>
              <span style={{
                display:'flex', alignItems:'center', gap:4,
                fontSize:10, fontWeight:600, padding:'2px 8px', borderRadius:99,
                background: offline ? 'var(--mmb-red-bg)' : 'var(--mmb-green-bg)',
                color: offline ? 'var(--mmb-red)' : 'var(--mmb-green)',
              }}>
                {offline ? <WifiOff size={9}/> : <Wifi size={9}/>}
                {offline ? 'Offline' : 'Live · 5s'}
              </span>
            </div>
          </div>
          <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
            <Btn onClick={refresh}><RefreshCw size={12}/>Refresh</Btn>
            {(liveW.length>0||wStats.waiting>0) && (
              <Btn onClick={stopAll} disabled={stopping} danger>
                <StopCircle size={12}/>{stopping?'Stopping…':'Stop All'}
              </Btn>
            )}
            <PrimaryBtn onClick={() => setActiveTab('scheduler')}>
              <Play size={12}/> Start Run
            </PrimaryBtn>
          </div>
        </div>

        {/* ── Status bar ──────────────────────────────────────────────────── */}
        {health && (
          <Card style={{ padding:'8px 16px' }}>
            <div style={{ display:'flex', flexWrap:'wrap', alignItems:'center', gap:'4px 16px', fontSize:11, color:'var(--mmb-muted)' }}>
              <div style={{ display:'flex', alignItems:'center', gap:5 }}>
                <StatusDot color="var(--mmb-green)" pulse />
                <span>API <strong style={{ color:'var(--mmb-green)' }}>OK</strong></span>
              </div>
              <span style={{ color:'var(--mmb-border)' }}>|</span>
              <span>Schedules <strong style={{ color:'var(--mmb-accent)' }}>{health.schedules??0}</strong></span>
              <span style={{ color:'var(--mmb-border)' }}>|</span>
              <span>Running <strong style={{ color:'var(--mmb-green)' }}>{wStats.running}</strong></span>
              <span style={{ color:'var(--mmb-border)' }}>|</span>
              <span>Waiting <strong style={{ color:'var(--mmb-yellow)' }}>{wStats.waiting}</strong></span>
              <span style={{ color:'var(--mmb-border)' }}>|</span>
              <span>Done <strong style={{ color:'var(--mmb-text)' }}>{wStats.done}</strong></span>
              {conc && <><span style={{ color:'var(--mmb-border)' }}>|</span>
              <span>Slots <strong style={{ color:'var(--mmb-accent)' }}>{conc.running}/{conc.limit}</strong></span></>}
              {(health.engagement?.running ?? 0) > 0 && <><span style={{ color:'var(--mmb-border)' }}>|</span>
              <span>Engagement <strong style={{ color:'var(--mmb-green)' }}>{health.engagement?.running}</strong></span></>}
              {health.recycleEnabled && <><span style={{ color:'var(--mmb-border)' }}>|</span>
              <span>24/7 <strong style={{ color:'var(--mmb-green)' }}>ON</strong></span></>}
              {wStats.error>0 && <><span style={{ color:'var(--mmb-border)' }}>|</span>
              <span>Errors <strong style={{ color:'var(--mmb-red)' }}>{wStats.error}</strong></span></>}
              {health.uptime && <><span style={{ color:'var(--mmb-border)' }}>|</span>
              <span>Uptime <strong style={{ color:'var(--mmb-text2)' }}>{fmtUp(health.uptime)}</strong></span></>}
            </div>
          </Card>
        )}

        {/* ── Proxy alert ─────────────────────────────────────────────────── */}
        {(pExpired>0||pWarn>0) && (
          <div style={{
            display:'flex', alignItems:'center', gap:10, padding:'10px 16px', borderRadius:10,
            background:'var(--mmb-yellow-bg)', border:'1px solid var(--mmb-yellow)', fontSize:13,
          }}>
            <AlertTriangle size={14} style={{ color:'var(--mmb-yellow)', flexShrink:0 }}/>
            <span style={{ flex:1, color:'var(--mmb-text2)' }}>
              {pExpired>0 && <><strong>{pExpired} proxy expired</strong>&nbsp;</>}
              {pWarn>0 && `· ${pWarn} expiring within 2h`}
            </span>
            <button onClick={()=>setActiveTab('profiles')} style={{
              display:'flex', alignItems:'center', gap:3, fontSize:11, fontWeight:700,
              color:'var(--mmb-yellow)', background:'transparent', border:'none', cursor:'pointer',
            }}>Fix <ChevronRight size={11}/></button>
          </div>
        )}

        {/* ── KPI Row ─────────────────────────────────────────────────────── */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(220px, 1fr))', gap:12 }}>
          {kpis.map(k => <KpiCard key={k.label} {...k} />)}
        </div>

        {/* ── Main 2-col ──────────────────────────────────────────────────── */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(320px, 1fr))', gap:12 }}>
          {/* Live Workers */}
          <Card>
            <CardHeader title="🟢 Live Workers"
              action={
                <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                  <span className="mmb-badge-green">{liveW.length} Active</span>
                  <button onClick={()=>setActiveTab('monitor')} style={{
                    fontSize:11, fontWeight:600, color:'var(--mmb-accent)',
                    background:'transparent', border:'none', cursor:'pointer',
                  }}>Monitor →</button>
                </div>
              }
            />
            <div style={{ padding:'0 0 12px' }}>
              {liveW.length === 0 ? (
                <div style={{ textAlign:'center', padding:'30px', color:'var(--mmb-muted)', fontSize:13 }}>
                  No active workers
                </div>
              ) : (
                liveW.slice(0,6).map(w => {
                  const meta = workerMeta(w.status);
                  return (
                    <div key={w.profileId} style={{
                      display:'flex', alignItems:'center', gap:12,
                      padding:'10px 16px', borderBottom:'1px solid var(--mmb-border)',
                    }}>
                      <div style={{ width:7, height:7, borderRadius:'50%', background:meta.color, flexShrink:0 }}/>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontSize:13, fontWeight:600, color:'var(--mmb-text)', marginBottom:2 }}>
                          {w.profileName || w.profileId}
                        </div>
                        <div style={{ fontSize:11, color:'var(--mmb-muted)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                          {w.currentVideo || 'Connecting…'}
                        </div>
                      </div>
                      <div style={{ display:'flex', alignItems:'center', gap:6, flexShrink:0 }}>
                        {w.startedAt && <span style={{ fontSize:11, color:'var(--mmb-muted)' }}>{fmtUp(Date.now()-w.startedAt)}</span>}
                        <span style={{ fontSize:11, fontWeight:600, padding:'2px 8px', borderRadius:99, background:meta.bg, color:meta.color }}>
                          {meta.label}
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
              {/* Footer counts */}
              <div style={{ display:'flex', gap:16, padding:'10px 16px 0', fontSize:12, color:'var(--mmb-muted)' }}>
                <span><StatusDot color="var(--mmb-green)"/>&nbsp;{wStats.running} running</span>
                <span><StatusDot color="var(--mmb-yellow)"/>&nbsp;{wStats.waiting} waiting</span>
                <span><StatusDot color="#6b7280"/>&nbsp;{wStats.done} done</span>
                {wStats.error>0 && <span><StatusDot color="var(--mmb-red)"/>&nbsp;{wStats.error} error</span>}
              </div>
            </div>
          </Card>

          {/* Traffic Sources */}
          <Card>
            <CardHeader title="📊 Traffic Sources"
              action={<span style={{ fontSize:11, color:'var(--mmb-muted)' }}>Today · {totalTraffic.toLocaleString()}</span>}
            />
            <div style={{ padding:'0 16px 16px', display:'flex', flexDirection:'column', gap:10 }}>
              {trafficRows.length === 0 ? (
                <div style={{ textAlign:'center', padding:'20px', color:'var(--mmb-muted)', fontSize:12 }}>No data yet</div>
              ) : trafficRows.map(({ label, color, value }) => (
                <div key={label}>
                  <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4, fontSize:12 }}>
                    <span style={{ color:'var(--mmb-text2)', display:'flex', alignItems:'center', gap:6 }}>
                      <span style={{ width:8, height:8, borderRadius:'50%', background:color, display:'inline-block' }}/>
                      {label}
                    </span>
                    <span style={{ color:'var(--mmb-accent)', fontWeight:700 }}>
                      {totalTraffic>0?Math.round((value/totalTraffic)*100):0}%
                    </span>
                  </div>
                  <div style={{ height:5, background:'var(--mmb-border)', borderRadius:99, overflow:'hidden' }}>
                    <div style={{
                      height:'100%', borderRadius:99, background:color,
                      width:`${totalTraffic>0?(value/totalTraffic)*100:0}%`,
                      transition:'width .4s ease',
                    }}/>
                  </div>
                </div>
              ))}
              {totalTraffic>0 && (
                <div style={{ borderTop:'1px solid var(--mmb-border)', paddingTop:10, display:'flex', justifyContent:'space-between', fontSize:12 }}>
                  <span style={{ color:'var(--mmb-muted)' }}>Total today</span>
                  <span style={{ fontWeight:700, color:'var(--mmb-accent)' }}>{totalTraffic.toLocaleString()}</span>
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* ── Bottom 3-col ────────────────────────────────────────────────── */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(280px, 1fr))', gap:12 }}>
          {/* Recent Events */}
          <Card>
            <CardHeader title="📋 Recent Events"/>
            <div style={{ padding:'0 0 12px' }}>
              {recent.length===0 ? (
                <div style={{ textAlign:'center', padding:'20px', color:'var(--mmb-muted)', fontSize:12 }}>No events yet</div>
              ) : recent.map((ev:any,i:number)=>(
                <div key={i} style={{
                  display:'flex', alignItems:'center', gap:10,
                  padding:'8px 16px', borderBottom:'1px solid var(--mmb-border)',
                  fontSize:12,
                }}>
                  <span style={{ color:'var(--mmb-muted)', fontVariantNumeric:'tabular-nums', minWidth:40, flexShrink:0 }}>
                    {(() => { try { return new Date(ev.time ?? ev.ts ?? 0).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}); } catch { return '—'; } })()}
                  </span>
                  <span style={{ fontSize:13 }}>
                    {ev.action==='view'||ev.type==='view'?'👁':ev.action==='like'||ev.type==='like'?'❤️':ev.action==='subscribe'||ev.type==='subscribe'?'🔔':ev.action==='comment'||ev.type==='comment'?'💬':'📌'}
                  </span>
                  <div style={{ flex:1, minWidth:0, overflow:'hidden' }}>
                    <span style={{ color:'var(--mmb-accent)', fontWeight:600 }}>
                      {profiles.find(p=>p.id===ev.profileId)?.name || (ev.profileId ? ev.profileId.slice(0,10)+'…' : '—')}
                    </span>
                    {' '}
                    <span style={{ color:'var(--mmb-muted)' }}>{ev.action ?? ev.type}</span>
                    {ev.value!=null && ev.value>0 && <span style={{ color:'var(--mmb-text2)' }}> +{ev.value}</span>}
                  </div>
                </div>
              ))}
            </div>
          </Card>

          {/* Ad Performance */}
          <Card>
            <CardHeader title="📺 Ad Performance"/>
            <div style={{ padding:'8px 12px 12px', display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
              {[
                { label:'Ads Shown',    val:(data?.totalAds??0),        color:'var(--mmb-accent)', bg:'var(--mmb-accent-bg)' },
                { label:'Skipped',      val:(data?.adsSkipped??0),       color:'var(--mmb-yellow)', bg:'var(--mmb-yellow-bg)' },
                { label:'Full Watch',   val:(data?.adsWatchedFull??0),   color:'var(--mmb-green)', bg:'var(--mmb-green-bg)' },
                { label:'Ad Watch Time',val:formatWatchTime(Math.round(data?.adWatchTime??0)), color:'var(--mmb-blue)', bg:'var(--mmb-blue-bg)' },
              ].map(({label,val,color,bg})=>(
                <div key={label} style={{
                  background:bg, borderRadius:8, padding:'10px 8px',
                  textAlign:'center',
                }}>
                  <div style={{ fontSize:18, fontWeight:800, color, lineHeight:1 }}>{val}</div>
                  <div style={{ fontSize:10, color:'var(--mmb-muted)', marginTop:3 }}>{label}</div>
                </div>
              ))}
            </div>
          </Card>

          {/* Engagement */}
          <Card>
            <CardHeader title="💙 Engagement"
              action={
                <button onClick={()=>setActiveTab('engagement')} style={{
                  fontSize:11, fontWeight:600, color:'var(--mmb-accent)',
                  background:'transparent', border:'none', cursor:'pointer',
                }}>View All →</button>
              }
            />
            <div style={{ padding:'8px 12px 12px', display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
              {[
                { icon:ThumbsUp, label:'Likes', val:data?.totalLikes??0, color:'#ef4444', bg:'var(--mmb-red-bg)' },
                { icon:Bell, label:'Subscribes', val:data?.totalSubscribes??0, color:'#f59e0b', bg:'var(--mmb-yellow-bg)' },
                { icon:MessageSquare, label:'Comments', val:data?.totalComments??0, color:'#16a34a', bg:'var(--mmb-green-bg)' },
                { icon:Eye, label:'Sessions', val:data?.totalSessions??0, color:'#4f46e5', bg:'var(--mmb-accent-bg)' },
              ].map(({icon:Icon,label,val,color,bg})=>(
                <div key={label} style={{ background:bg, borderRadius:8, padding:'10px 8px', textAlign:'center' }}>
                  <Icon size={14} style={{ color, margin:'0 auto 4px', display:'block' }}/>
                  <div style={{ fontSize:18, fontWeight:800, color, lineHeight:1 }}>{val.toLocaleString()}</div>
                  <div style={{ fontSize:10, color:'var(--mmb-muted)', marginTop:3 }}>{label}</div>
                </div>
              ))}
            </div>
          </Card>
        </div>

        {/* ── Quick nav ───────────────────────────────────────────────────── */}
        <div style={{ display:'flex', flexWrap:'wrap', gap:8 }}>
          <span style={{ fontSize:12, color:'var(--mmb-muted)', alignSelf:'center', marginRight:4 }}>Quick Jump:</span>
          {[
            {id:'scheduler',l:'Scheduler',i:Calendar},{id:'video-shuffle',l:'Video Shuffle',i:Shuffle},
            {id:'profiles',l:'Profiles',i:Users},{id:'analytics',l:'Analytics',i:BarChart3},
            {id:'channels',l:'Channels',i:Tv},{id:'backlinks',l:'Backlinks',i:Link2},
            {id:'settings',l:'Settings',i:Settings},
          ].map(({id,l,i:Icon})=>(
            <button key={id} onClick={()=>setActiveTab(id)} style={{
              display:'flex', alignItems:'center', gap:5, padding:'6px 12px',
              borderRadius:8, border:'1px solid var(--mmb-border)',
              background:'var(--mmb-surface)', color:'var(--mmb-text2)',
              fontSize:12, fontWeight:500, cursor:'pointer', transition:'all .15s',
            }}>
              <Icon size={12}/>{l}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
