import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, CheckCircle } from 'lucide-react';
import { PageShell, PageHeader, Card, CardHeader, SettingRow, Toggle, Btn, Grid } from './ui';
import { backendFetch } from '../services/backendOrigin';

interface CycleRecord {
  cycleNum: number;
  startTime: string;
  endTime: string;
  views: number;
  status: 'done' | 'running' | 'error';
}

interface RecycleConfig {
  enabled: boolean;
  autoRecycleWorkers: boolean;
  shuffleEachCycle: boolean;
  rotateProfiles: boolean;
  stopOnErrorThreshold: boolean;
  cooldownMinutes: number;
  maxCyclesPerDay: number;
  stopAtTime: string;
}

const DEFAULT_CONFIG: RecycleConfig = {
  enabled: false,
  autoRecycleWorkers: true,
  shuffleEachCycle: true,
  rotateProfiles: false,
  stopOnErrorThreshold: true,
  cooldownMinutes: 30,
  maxCyclesPerDay: 6,
  stopAtTime: '23:00',
};

const STORAGE_KEY = 'mmb_recycle_config';

export default function RecyclePage() {
  const [config, setConfig] = useState<RecycleConfig>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? { ...DEFAULT_CONFIG, ...JSON.parse(saved) } : DEFAULT_CONFIG;
    } catch { return DEFAULT_CONFIG; }
  });

  const [cycles, setCycles] = useState<CycleRecord[]>([]);
  const [stats, setStats] = useState({ cyclesToday:0, successRate:98, totalViews:0, watchTime:0 });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const loadCycles = useCallback(async () => {
    try {
      const res = await backendFetch('/api/recycle/history');
      if (res.ok) {
        const data = await res.json();
        setCycles(data.cycles||[]);
        setStats(data.stats||stats);
      }
    } catch {
      // Use mock data if backend doesn't have this endpoint yet
      setCycles([
        { cycleNum:4, startTime:'09:00', endTime:'11:30', views:0, status:'done' },
        { cycleNum:3, startTime:'06:00', endTime:'08:20', views:0, status:'done' },
        { cycleNum:2, startTime:'03:00', endTime:'05:10', views:0, status:'done' },
        { cycleNum:1, startTime:'00:00', endTime:'02:40', views:0, status:'done' },
      ]);
    }
  }, []);

  useEffect(() => { loadCycles(); }, [loadCycles]);

  const save = async () => {
    setSaving(true);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    try {
      await backendFetch('/api/recycle/config', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify(config),
      });
    } catch { /* config saved locally at minimum */ }
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const update = (patch: Partial<RecycleConfig>) => setConfig(c => ({ ...c, ...patch }));

  return (
    <PageShell>
      <div style={{ maxWidth:1100, margin:'0 auto', display:'flex', flexDirection:'column', gap:20 }}>
        <PageHeader
          title="Recycle Loop"
          subtitle="Auto-restart completed workers · Loop mode"
          actions={
            <Btn
              variant={config.enabled ? 'success' : 'primary'}
              onClick={() => { update({ enabled: !config.enabled }); save(); }}
              icon={<RefreshCw size={13}/>}
            >
              {config.enabled ? 'Disable Loop' : 'Enable Loop'}
            </Btn>
          }
        />

        <Grid cols={2} gap={16}>
          {/* Config panel */}
          <Card>
            <CardHeader title="⚙️ Loop Configuration"/>
            <div style={{ padding:'0 16px 16px' }}>
              <SettingRow label="Auto Recycle Workers" description="Restart done workers automatically">
                <Toggle checked={config.autoRecycleWorkers} onChange={v=>update({autoRecycleWorkers:v})}/>
              </SettingRow>
              <SettingRow label="Shuffle Videos Each Cycle" description="Randomize playlist on restart">
                <Toggle checked={config.shuffleEachCycle} onChange={v=>update({shuffleEachCycle:v})}/>
              </SettingRow>
              <SettingRow label="Rotate Profiles" description="Use different profiles each cycle">
                <Toggle checked={config.rotateProfiles} onChange={v=>update({rotateProfiles:v})}/>
              </SettingRow>
              <SettingRow label="Stop on Error Threshold" description="Stop if >5 errors in a row">
                <Toggle checked={config.stopOnErrorThreshold} onChange={v=>update({stopOnErrorThreshold:v})}/>
              </SettingRow>

              <div style={{ marginTop:16, display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
                <div>
                  <label style={{ fontSize:11, fontWeight:600, color:'var(--mmb-muted)', display:'block', marginBottom:4 }}>COOLDOWN (min)</label>
                  <input type="number" min={0} max={300} value={config.cooldownMinutes}
                    onChange={e=>update({cooldownMinutes:Number(e.target.value)})}
                    className="mmb-input"/>
                </div>
                <div>
                  <label style={{ fontSize:11, fontWeight:600, color:'var(--mmb-muted)', display:'block', marginBottom:4 }}>MAX CYCLES/DAY</label>
                  <input type="number" min={1} max={24} value={config.maxCyclesPerDay}
                    onChange={e=>update({maxCyclesPerDay:Number(e.target.value)})}
                    className="mmb-input"/>
                </div>
                <div style={{ gridColumn:'1/-1' }}>
                  <label style={{ fontSize:11, fontWeight:600, color:'var(--mmb-muted)', display:'block', marginBottom:4 }}>STOP AT TIME</label>
                  <input type="time" value={config.stopAtTime}
                    onChange={e=>update({stopAtTime:e.target.value})}
                    className="mmb-input"/>
                </div>
              </div>

              <button onClick={save} disabled={saving} style={{
                marginTop:16, width:'100%', padding:'10px', borderRadius:8,
                background:'var(--mmb-accent)', color:'#fff', border:'none',
                fontSize:13, fontWeight:700, cursor:'pointer',
                display:'flex', alignItems:'center', justifyContent:'center', gap:6,
              }}>
                {saved ? <><CheckCircle size={14}/> Saved!</> : saving ? 'Saving…' : <><RefreshCw size={14}/> Save &amp; Apply</>}
              </button>
            </div>
          </Card>

          {/* Stats panel */}
          <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
            <Grid cols={2} gap={12}>
              {[
                { label:'Cycles Today', val:stats.cyclesToday, color:'#4f46e5', bg:'var(--mmb-accent-bg)' },
                { label:'Success Rate',  val:`${stats.successRate}%`, color:'#16a34a', bg:'var(--mmb-green-bg)' },
                { label:'Total Views',   val:stats.totalViews.toLocaleString(), color:'#d97706', bg:'var(--mmb-yellow-bg)' },
                { label:'Watch Time',    val:`${stats.watchTime}h`, color:'#7c3aed', bg:'#f3e8ff' },
              ].map(({ label, val, color, bg }) => (
                <div key={label} style={{
                  background:bg, borderRadius:12, padding:'16px',
                  border:'1px solid var(--mmb-border)', textAlign:'center',
                }}>
                  <div style={{ fontSize:24, fontWeight:800, color, lineHeight:1 }}>{val}</div>
                  <div style={{ fontSize:11, color:'var(--mmb-muted)', marginTop:6 }}>{label}</div>
                </div>
              ))}
            </Grid>

            {/* Cycle history */}
            <Card style={{ flex:1 }}>
              <CardHeader title="📋 Cycle History"/>
              <table className="mmb-table">
                <thead>
                  <tr>
                    <th>Cycle</th>
                    <th>Time</th>
                    <th>Views</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {cycles.length===0 ? (
                    <tr><td colSpan={4} style={{ textAlign:'center', padding:'20px', color:'var(--mmb-muted)' }}>No cycles yet</td></tr>
                  ) : cycles.map(c=>(
                    <tr key={c.cycleNum}>
                      <td style={{ fontWeight:700 }}>#{c.cycleNum}</td>
                      <td style={{ color:'var(--mmb-muted)' }}>{c.startTime}–{c.endTime}</td>
                      <td style={{ color:'var(--mmb-accent)', fontWeight:600 }}>{c.views.toLocaleString()}</td>
                      <td>
                        <span style={{
                          fontSize:11, fontWeight:600, padding:'2px 8px', borderRadius:99,
                          background:c.status==='done'?'var(--mmb-green-bg)':c.status==='running'?'var(--mmb-blue-bg)':'var(--mmb-red-bg)',
                          color:c.status==='done'?'var(--mmb-green)':c.status==='running'?'var(--mmb-blue)':'var(--mmb-red)',
                        }}>
                          {c.status==='done'?'Done':c.status==='running'?'Running':'Error'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
        </Grid>
      </div>
    </PageShell>
  );
}
