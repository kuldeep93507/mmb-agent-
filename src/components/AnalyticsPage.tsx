import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Eye, Clock, Users, ThumbsUp, Bell, MessageSquare,
  Download, AlertCircle, Search, Zap,
} from 'lucide-react';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts';
import type { Profile } from '../types';
import RateLimitDashboard from './RateLimitDashboard';
import {
  fetchAnalytics, exportAnalyticsJson, formatWatchTime,
  type AnalyticsResponse, type AnalyticsTimeFilter,
} from '../utils/analyticsApi';
import { PageShell, PageHeader, Card, CardHeader, Badge, Btn } from './ui';

interface AnalyticsPageProps { profiles: Profile[]; setActiveTab?: (tab: string) => void; }

const FILTERS: { key: AnalyticsTimeFilter; label: string }[] = [
  { key:'today',     label:'Today'   },
  { key:'yesterday', label:'Yesterday' },
  { key:'7d',        label:'7 Days'  },
  { key:'30d',       label:'30 Days' },
  { key:'all',       label:'All Time'},
];


const PAGE_SIZE = 20;
type SortKey = 'name'|'views'|'watchTime'|'likes';

export default function AnalyticsPage({ profiles, setActiveTab }: AnalyticsPageProps) {
  const [filter, setFilter]     = useState<AnalyticsTimeFilter>('today');
  const [data,   setData]       = useState<AnalyticsResponse|null>(null);
  const [loading,setLoading]    = useState(false);
  const [error,  setError]      = useState<string|null>(null);
  const [search, setSearch]     = useState('');
  const [sortKey,setSortKey]    = useState<SortKey>('views');
  const [page,   setPage]       = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    const d = await fetchAnalytics(filter);
    if (d) { setData(d); setError(null); } else setError('Backend connect fail. Running hai?');
    setLoading(false);
  }, [filter]);

  useEffect(() => { load(); const id=setInterval(load,5000); return ()=>clearInterval(id); }, [load]);
  useEffect(() => { setPage(0); }, [filter, search, sortKey]);

  const profileById = useMemo(()=>{ const m=new Map<string,Profile>(); profiles.forEach(p=>m.set(p.id,p)); return m; },[profiles]);

  const profileRows = useMemo(() => {
    const ids = new Set([...profiles.map(p=>p.id), ...Object.keys(data?.perProfile||{})]);
    const rows = [...ids].map(id => {
      const p = profileById.get(id);
      const s = data?.perProfile?.[id] || {views:0,watchTime:0,likes:0,subscribes:0,comments:0};
      return { id, name:p?.name||`${id.slice(0,12)}…`, os:p?.os||'—', status:p?.status||'idle', orphan:!p, ...s };
    });
    const q = search.trim().toLowerCase();
    const filtered = q ? rows.filter(r=>r.name.toLowerCase().includes(q)||r.id.toLowerCase().includes(q)) : rows;
    filtered.sort((a,b)=> sortKey==='name' ? a.name.localeCompare(b.name) : (b[sortKey] as number)-(a[sortKey] as number));
    return filtered;
  }, [profiles, data, profileById, search, sortKey]);

  const pageCount = Math.max(1, Math.ceil(profileRows.length/PAGE_SIZE));
  const pagedRows = profileRows.slice(page*PAGE_SIZE, (page+1)*PAGE_SIZE);

  // Build chart data from dailyTrend (watchTime stored in seconds)
  const chartData = (data?.dailyTrend||[]).slice(-14).map(d=>({
    date: d.date.slice(5),
    views: d.views,
    watchTime: Math.round((d.watchTime||0)/60),
  }));

  const trafficTotal = (data?.trafficYouTube||0)+(data?.trafficGoogle||0)+(data?.trafficBing||0)
    +(data?.trafficDirect||0)+(data?.trafficChannel||0)+(data?.trafficBacklink||0)+(data?.trafficDirectFallback||0);

  const trafficRows = [
    { label:'YouTube',  value:data?.trafficYouTube||0,  color:'#ef4444' },
    { label:'Google',   value:data?.trafficGoogle||0,   color:'#3b82f6' },
    { label:'Bing',     value:data?.trafficBing||0,     color:'#8b5cf6' },
    { label:'Direct',   value:data?.trafficDirect||0,   color:'#f59e0b' },
    { label:'Channel',  value:data?.trafficChannel||0,  color:'#22c55e' },
    { label:'Backlink', value:data?.trafficBacklink||0, color:'#ec4899' },
  ].filter(r=>r.value>0).sort((a,b)=>b.value-a.value);

  return (
    <PageShell>
      <div style={{ maxWidth:1280, margin:'0 auto', display:'flex', flexDirection:'column', gap:20 }}>
        <PageHeader
          title="Analytics"
          subtitle={`Live metrics · auto-refresh 5s · ${new Date().toLocaleDateString('en-IN', { weekday:'short', month:'short', day:'numeric' })}`}
          actions={
            <>
              <span style={{
                display:'inline-flex', alignItems:'center', gap:5,
                fontSize:10, fontWeight:600, padding:'3px 10px', borderRadius:99,
                background: error ? 'var(--mmb-red-bg)' : 'var(--mmb-green-bg)',
                color: error ? 'var(--mmb-red)' : 'var(--mmb-green)',
              }}>
                <span style={{ width:6, height:6, borderRadius:'50%', background:'currentColor', animation: error ? 'none' : 'mmb-pulse-dot 1.5s ease-out infinite' }}/>
                {error ? 'Offline' : 'Live'}
              </span>
              {/* Filter buttons */}
              <div style={{ display:'flex', gap:4 }}>
                {FILTERS.map(f=>(
                  <button key={f.key} onClick={()=>setFilter(f.key)} style={{
                    padding:'6px 12px', borderRadius:8, fontSize:12, fontWeight:600,
                    border:'none', cursor:'pointer', transition:'all .15s',
                    background: filter===f.key ? 'var(--mmb-accent)' : 'var(--mmb-surface)',
                    color: filter===f.key ? '#fff' : 'var(--mmb-muted)',
                    boxShadow: filter===f.key ? 'none' : 'var(--mmb-shadow)',
                  }}>
                    {f.label}
                  </button>
                ))}
              </div>
              {setActiveTab && (
                <Btn onClick={()=>setActiveTab('engagement')} icon={<Zap size={12}/>}>Engagement →</Btn>
              )}
              {data && (
                <Btn onClick={()=>exportAnalyticsJson(data, filter)} icon={<Download size={12}/>}>Export</Btn>
              )}
              {loading && <span style={{ fontSize:11, color:'var(--mmb-yellow)', fontWeight:600 }}>Syncing…</span>}
              {error && (
                <span style={{ fontSize:11, color:'var(--mmb-red)', display:'flex', alignItems:'center', gap:4 }}>
                  <AlertCircle size={11}/>{error}
                  <button onClick={load} style={{ background:'none', border:'none', color:'var(--mmb-accent)', cursor:'pointer', fontSize:11, fontWeight:600 }}>Retry</button>
                </span>
              )}
            </>
          }
        />

        {/* KPI row */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(160px, 1fr))', gap:12 }}>
          {[
            { label:'Total Views',  val:(data?.totalViews??0).toLocaleString(),     icon:Eye,          color:'#2563eb' },
            { label:'Watch Time',   val:formatWatchTime(Math.round(data?.totalWatchTime??0)), icon:Clock, color:'#7c3aed' },
            { label:'Sessions',     val:(data?.totalSessions??0).toLocaleString(),  icon:Users,        color:'#0891b2' },
            { label:'Likes',        val:(data?.totalLikes??0).toLocaleString(),     icon:ThumbsUp,     color:'#dc2626' },
            { label:'Subscribes',   val:(data?.totalSubscribes??0).toLocaleString(),icon:Bell,         color:'#d97706' },
            { label:'Comments',     val:(data?.totalComments??0).toLocaleString(),  icon:MessageSquare,color:'#16a34a' },
          ].map(({ label, val, icon:Icon, color }) => (
            <Card key={label} style={{ overflow:'hidden' }}>
              <div style={{ height:3, background:color }}/>
              <div style={{ padding:'12px' }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:8 }}>
                  <span style={{ fontSize:10, fontWeight:700, color:'var(--mmb-muted)', textTransform:'uppercase', letterSpacing:'.05em' }}>{label}</span>
                  <div style={{ width:24, height:24, borderRadius:6, background:`${color}18`, display:'flex', alignItems:'center', justifyContent:'center' }}>
                    <Icon size={12} style={{ color }}/>
                  </div>
                </div>
                <div style={{ fontSize:20, fontWeight:800, color:'var(--mmb-text)' }}>{val}</div>
              </div>
            </Card>
          ))}
        </div>

        {/* Chart + Traffic 2-col */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(320px, 1fr))', gap:16 }}>
          {/* Views area chart */}
          <Card>
            <CardHeader title="📈 Views — Last 14 Days"
              action={
                <div style={{ display:'flex', gap:12, fontSize:11, color:'var(--mmb-muted)' }}>
                  <span style={{ display:'flex', alignItems:'center', gap:4 }}>
                    <span style={{ width:10, height:3, background:'#4f46e5', display:'inline-block', borderRadius:2 }}/>Views
                  </span>
                  <span style={{ display:'flex', alignItems:'center', gap:4 }}>
                    <span style={{ width:10, height:3, background:'#22c55e', display:'inline-block', borderRadius:2 }}/>Watch(min)
                  </span>
                </div>
              }
            />
            <div style={{ padding:'16px', height:220 }}>
              {chartData.length===0 ? (
                <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100%', color:'var(--mmb-muted)', fontSize:13 }}>
                  No trend data yet
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ top:4, right:4, bottom:0, left:0 }}>
                    <defs>
                      <linearGradient id="gViews" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor="#4f46e5" stopOpacity={0.2}/>
                        <stop offset="95%" stopColor="#4f46e5" stopOpacity={0}/>
                      </linearGradient>
                      <linearGradient id="gWatch" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor="#22c55e" stopOpacity={0.2}/>
                        <stop offset="95%" stopColor="#22c55e" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--mmb-border)" vertical={false}/>
                    <XAxis dataKey="date" tick={{ fontSize:10, fill:'var(--mmb-muted)' }} axisLine={false} tickLine={false}/>
                    <YAxis tick={{ fontSize:10, fill:'var(--mmb-muted)' }} axisLine={false} tickLine={false} width={35}/>
                    <Tooltip
                      contentStyle={{ background:'var(--mmb-surface)', border:'1px solid var(--mmb-border)', borderRadius:8, fontSize:12 }}
                      labelStyle={{ color:'var(--mmb-text)', fontWeight:600 }}
                    />
                    <Area type="monotone" dataKey="views" stroke="#4f46e5" strokeWidth={2} fill="url(#gViews)" dot={false}/>
                    <Area type="monotone" dataKey="watchTime" stroke="#22c55e" strokeWidth={2} fill="url(#gWatch)" dot={false}/>
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </Card>

          {/* Traffic breakdown */}
          <Card>
            <CardHeader title="🚦 Traffic Breakdown"/>
            <div style={{ padding:'12px 16px 16px', display:'flex', flexDirection:'column', gap:10 }}>
              {trafficRows.length===0 ? (
                <div style={{ textAlign:'center', padding:'30px', color:'var(--mmb-muted)', fontSize:12 }}>No traffic data</div>
              ) : trafficRows.map(({ label, value, color }) => (
                <div key={label}>
                  <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4, fontSize:12 }}>
                    <span style={{ color:'var(--mmb-text2)', display:'flex', alignItems:'center', gap:5 }}>
                      <span style={{ width:8, height:8, borderRadius:'50%', background:color, display:'inline-block' }}/>
                      {label}
                    </span>
                    <span style={{ fontWeight:700, color:'var(--mmb-accent)' }}>
                      {value} <span style={{ fontWeight:400, color:'var(--mmb-muted)' }}>({trafficTotal>0?Math.round((value/trafficTotal)*100):0}%)</span>
                    </span>
                  </div>
                  <div style={{ height:5, background:'var(--mmb-border)', borderRadius:99, overflow:'hidden' }}>
                    <div style={{ height:'100%', borderRadius:99, background:color, width:`${trafficTotal>0?(value/trafficTotal)*100:0}%`, transition:'width .4s' }}/>
                  </div>
                </div>
              ))}
              {trafficTotal>0 && (
                <div style={{ borderTop:'1px solid var(--mmb-border)', paddingTop:8, display:'flex', justifyContent:'space-between', fontSize:12 }}>
                  <span style={{ color:'var(--mmb-muted)' }}>Total</span>
                  <strong style={{ color:'var(--mmb-accent)' }}>{trafficTotal.toLocaleString()}</strong>
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* Per-profile table */}
        <Card>
          <CardHeader
            title={`👤 Top Profiles (${profileRows.length})`}
            action={
              <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                <div style={{ position:'relative' }}>
                  <Search size={12} style={{ position:'absolute', left:8, top:'50%', transform:'translateY(-50%)', color:'var(--mmb-muted)' }}/>
                  <input
                    type="text" placeholder="Search…" value={search} onChange={e=>setSearch(e.target.value)}
                    style={{
                      paddingLeft:28, paddingRight:8, paddingTop:5, paddingBottom:5,
                      borderRadius:6, border:'1px solid var(--mmb-border)',
                      background:'var(--mmb-surface)', color:'var(--mmb-text)',
                      fontSize:12, outline:'none', width:140,
                    }}
                  />
                </div>
                <select
                  value={sortKey} onChange={e=>setSortKey(e.target.value as SortKey)}
                  style={{ borderRadius:6, border:'1px solid var(--mmb-border)', background:'var(--mmb-surface)', color:'var(--mmb-text)', fontSize:12, padding:'5px 8px', outline:'none' }}
                >
                  <option value="views">Views</option>
                  <option value="watchTime">Watch Time</option>
                  <option value="likes">Likes</option>
                  <option value="name">Name</option>
                </select>
              </div>
            }
          />
          <table className="mmb-table">
            <thead>
              <tr>
                <th>Profile</th>
                <th>Views</th>
                <th>Watch Time</th>
                <th>Likes</th>
                <th>Subscribes</th>
                <th>Comments</th>
              </tr>
            </thead>
            <tbody>
              {pagedRows.map(r => (
                <tr key={r.id}>
                  <td>
                    <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                      <span style={{ width:6, height:6, borderRadius:'50%', background:r.status==='running'?'var(--mmb-green)':'var(--mmb-border2)', display:'inline-block' }}/>
                      <span style={{ fontWeight:600, color:'var(--mmb-text)' }}>{r.name}</span>
                      {r.orphan && <Badge color="yellow">removed</Badge>}
                    </div>
                  </td>
                  <td><strong style={{ color:'var(--mmb-accent)' }}>{r.views.toLocaleString()}</strong></td>
                  <td style={{ color:'var(--mmb-blue)' }}>{formatWatchTime(Math.round(r.watchTime||0))}</td>
                  <td style={{ color:'var(--mmb-red)' }}>❤ {r.likes}</td>
                  <td style={{ color:'var(--mmb-yellow)' }}>🔔 {r.subscribes}</td>
                  <td style={{ color:'var(--mmb-green)' }}>💬 {r.comments}</td>
                </tr>
              ))}
              {pagedRows.length===0 && (
                <tr><td colSpan={6} style={{ textAlign:'center', padding:'30px', color:'var(--mmb-muted)' }}>No data for this period.</td></tr>
              )}
            </tbody>
          </table>
          {pageCount>1 && (
            <div style={{ display:'flex', justifyContent:'center', alignItems:'center', gap:8, padding:'12px', borderTop:'1px solid var(--mmb-border)' }}>
              <button disabled={page===0} onClick={()=>setPage(p=>p-1)} style={{ padding:'4px 12px', borderRadius:6, border:'1px solid var(--mmb-border)', background:'var(--mmb-surface)', color:'var(--mmb-text)', fontSize:12, cursor:'pointer', opacity:page===0?.4:1 }}>← Prev</button>
              <span style={{ fontSize:12, color:'var(--mmb-muted)' }}>{page+1} / {pageCount}</span>
              <button disabled={page>=pageCount-1} onClick={()=>setPage(p=>p+1)} style={{ padding:'4px 12px', borderRadius:6, border:'1px solid var(--mmb-border)', background:'var(--mmb-surface)', color:'var(--mmb-text)', fontSize:12, cursor:'pointer', opacity:page>=pageCount-1?.4:1 }}>Next →</button>
            </div>
          )}
        </Card>

        {/* Recent activity */}
        {(data?.recentActivity?.length??0)>0 && (
          <Card>
            <CardHeader title="⚡ Recent Activity"/>
            <div style={{ maxHeight:240, overflowY:'auto' }}>
              {data!.recentActivity!.slice(-30).reverse().map((e:any,i:number)=>(
                <div key={`${e.time}-${i}`} style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 16px', borderBottom:'1px solid var(--mmb-border)', fontSize:12 }}>
                  <span style={{ color:'var(--mmb-muted)', minWidth:120, flexShrink:0 }}>
                    {(() => { try { const t = e.time ?? e.ts ?? 0; return new Date(typeof t === 'number' ? t : Date.parse(String(t))).toLocaleString(); } catch { return '—'; } })()}
                  </span>
                  <span style={{ color:'var(--mmb-accent)', fontWeight:600 }}>{profileById.get(e.profileId)?.name||e.profileId.slice(0,10)}</span>
                  <span style={{ color:'var(--mmb-text2)' }}>{e.action}</span>
                  {e.value>0 && <span style={{ color:'var(--mmb-muted)' }}>+{e.value}</span>}
                </div>
              ))}
            </div>
          </Card>
        )}

        <RateLimitDashboard profiles={profiles}/>
      </div>
    </PageShell>
  );
}
