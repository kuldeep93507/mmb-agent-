import { useState, useCallback } from 'react';
import {
  Shield, Save, RotateCcw, CheckCircle,
  Eye, EyeOff, Plus, Trash2, RefreshCw, Globe, Zap, Info,
  ChevronDown, ChevronUp, Copy, Check,
} from 'lucide-react';
import { backendFetch, getAuthHeaders } from '../services/backendOrigin';
import { US_STATE_CITIES, PROXY_LIVES } from '../data/proxyData';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProxyGlobalConfig {
  server: string;
  port: number;
  password: string;
  prefix: string;
  defaultLife: string;
  defaultState: string;
  defaultCity: string;
  rotateOnExpiry: boolean;
  autoRenewMinutes: number;
}

interface CustomProxy {
  id: string;
  label: string;
  server: string;
  port: number;
  username: string;
  password: string;
  notes: string;
}

type TestStatus = 'idle' | 'testing' | 'ok' | 'fail';

const STORAGE_KEY = 'mmb_proxy_global_config';
const CUSTOM_KEY = 'mmb_custom_proxies';

const DEFAULT_CONFIG: ProxyGlobalConfig = {
  server: 'us.smartproxy.net',
  port: 3120,
  password: 'xEdCpOSFn3nd4ixu',
  prefix: 'smart-pwgbkxcy3lyi',
  defaultLife: '10min',
  defaultState: 'TX',
  defaultCity: 'DALLAS',
  rotateOnExpiry: true,
  autoRenewMinutes: 10,
};

function loadConfig(): ProxyGlobalConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...DEFAULT_CONFIG };
}

function loadCustomProxies(): CustomProxy[] {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return [];
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ProxySettingsPage() {
  const [config, setConfig] = useState<ProxyGlobalConfig>(loadConfig);
  const [customProxies, setCustomProxies] = useState<CustomProxy[]>(loadCustomProxies);
  const [saved, setSaved] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [testStatus, setTestStatus] = useState<TestStatus>('idle');
  const [testResult, setTestResult] = useState<string>('');
  const [showCustomForm, setShowCustomForm] = useState(false);
  const [newProxy, setNewProxy] = useState<Omit<CustomProxy, 'id'>>({
    label: '', server: '', port: 3128, username: '', password: '', notes: '',
  });
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [expandedSection, setExpandedSection] = useState<string>('global');

  const states = Object.keys(US_STATE_CITIES);
  const cities = US_STATE_CITIES[config.defaultState] || [];

  const set = (key: keyof ProxyGlobalConfig, val: unknown) =>
    setConfig(prev => ({ ...prev, [key]: val }));

  // Save to localStorage + backend
  const handleSave = useCallback(async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(customProxies));
    try {
      await backendFetch('/api/proxy/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ global: config, custom: customProxies }),
      });
    } catch { /* backend optional */ }
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }, [config, customProxies]);

  // Test proxy connection
  const handleTest = async () => {
    setTestStatus('testing');
    setTestResult('');
    try {
      const username = `${config.prefix}_area-US_state-${config.defaultState}_life-${config.defaultLife}_session-test123`;
      const res = await backendFetch('/api/proxy/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({
          server: config.server,
          port: config.port,
          username,
          password: config.password,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setTestStatus('ok');
        setTestResult(`✅ Connected! IP: ${data.ip || 'N/A'} | Latency: ${data.latency || '—'}ms`);
      } else {
        setTestStatus('fail');
        setTestResult(`❌ Failed: ${data.error || 'Connection refused'}`);
      }
    } catch {
      setTestStatus('fail');
      setTestResult('❌ Backend unreachable — check if server is running');
    }
    setTimeout(() => setTestStatus('idle'), 8000);
  };

  // Reset to defaults
  const handleReset = () => {
    setConfig({ ...DEFAULT_CONFIG });
    setSaved(false);
  };

  // Copy to clipboard
  const copyText = (text: string, id: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  // Add custom proxy
  const addCustomProxy = () => {
    if (!newProxy.server || !newProxy.username) return;
    const proxy: CustomProxy = { ...newProxy, id: crypto.randomUUID() };
    setCustomProxies(prev => [...prev, proxy]);
    setNewProxy({ label: '', server: '', port: 3128, username: '', password: '', notes: '' });
    setShowCustomForm(false);
  };

  // Delete custom proxy
  const deleteCustomProxy = (id: string) => {
    setCustomProxies(prev => prev.filter(p => p.id !== id));
  };

  // Build preview username string
  const previewUsername = `${config.prefix}_area-US_state-${config.defaultState}_life-${config.defaultLife}_session-mmb001`;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: 'var(--mmb-bg)', color: 'var(--mmb-text)' }}>

      {/* ── Header ── */}
      <div style={{
        padding: '20px 24px 16px',
        borderBottom: '1px solid var(--mmb-border)',
        background: 'var(--mmb-surface)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 40, height: 40, borderRadius: 10,
              background: 'linear-gradient(135deg, #4f46e5, #7c3aed)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 4px 12px rgba(79,70,229,.3)',
            }}>
              <Shield size={20} color="#fff" />
            </div>
            <div>
              <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--mmb-text)', margin: 0 }}>
                Proxy Settings
              </h1>
              <p style={{ fontSize: 12, color: 'var(--mmb-muted)', margin: 0 }}>
                SmartProxy global config • Per-profile overrides • Health check
              </p>
            </div>
          </div>

          {/* Action Buttons */}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={handleReset}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '8px 14px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
                background: 'transparent', border: '1px solid var(--mmb-border)',
                color: 'var(--mmb-muted)',
              }}
            >
              <RotateCcw size={13} /> Reset
            </button>
            <button
              onClick={handleSave}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer',
                background: saved ? '#16a34a' : 'var(--mmb-accent)',
                border: 'none', color: '#fff',
                transition: 'background .2s',
              }}
            >
              {saved ? <><Check size={13} /> Saved!</> : <><Save size={13} /> Save Config</>}
            </button>
          </div>
        </div>
      </div>

      {/* ── Body ── */}
      <div style={{ flex: 1, padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* ══ Section 1: SmartProxy Global Config ══ */}
        <Section
          title="SmartProxy Global Configuration"
          subtitle="Default proxy used for all profiles"
          icon={<Globe size={16} />}
          expanded={expandedSection === 'global'}
          onToggle={() => setExpandedSection(s => s === 'global' ? '' : 'global')}
        >
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>

            {/* Server */}
            <Field label="Proxy Server" hint="SmartProxy hostname">
              <input
                value={config.server}
                onChange={e => set('server', e.target.value)}
                placeholder="us.smartproxy.net"
                style={inputStyle}
              />
            </Field>

            {/* Port */}
            <Field label="Port" hint="Default: 3120">
              <input
                type="number"
                value={config.port}
                onChange={e => set('port', parseInt(e.target.value) || 3120)}
                style={inputStyle}
              />
            </Field>

            {/* Username Prefix */}
            <Field label="Username Prefix" hint="Your SmartProxy sub-user prefix">
              <input
                value={config.prefix}
                onChange={e => set('prefix', e.target.value)}
                placeholder="smart-xxxxxxxx"
                style={inputStyle}
              />
            </Field>

            {/* Password */}
            <Field label="Password" hint="SmartProxy account password">
              <div style={{ position: 'relative' }}>
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={config.password}
                  onChange={e => set('password', e.target.value)}
                  style={{ ...inputStyle, paddingRight: 36 }}
                />
                <button
                  onClick={() => setShowPassword(s => !s)}
                  style={{
                    position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
                    background: 'none', border: 'none', cursor: 'pointer', color: 'var(--mmb-muted)',
                  }}
                >
                  {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </Field>

            {/* Default Life */}
            <Field label="Default Session Life" hint="How long each proxy session lasts">
              <select value={config.defaultLife} onChange={e => set('defaultLife', e.target.value)} style={inputStyle}>
                <option value="10min">10 Minutes</option>
                <option value="30min">30 Minutes</option>
                {PROXY_LIVES.map(l => (
                  <option key={l} value={l}>{l === '1hr' ? '1 Hour' : l === '2hr' ? '2 Hours' : l === '4hr' ? '4 Hours' : l === '8hr' ? '8 Hours' : '24 Hours'}</option>
                ))}
              </select>
            </Field>

            {/* Auto Renew */}
            <Field label="Auto-Renew Before Expiry" hint="Minutes before expiry to auto-renew">
              <input
                type="number"
                min={1} max={60}
                value={config.autoRenewMinutes}
                onChange={e => set('autoRenewMinutes', parseInt(e.target.value) || 10)}
                style={inputStyle}
              />
            </Field>

            {/* Default State */}
            <Field label="Default State" hint="US state for new profiles">
              <select
                value={config.defaultState}
                onChange={e => {
                  set('defaultState', e.target.value);
                  const cities = US_STATE_CITIES[e.target.value] || [];
                  set('defaultCity', cities[0] || '');
                }}
                style={inputStyle}
              >
                {states.map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </Field>

            {/* Default City */}
            <Field label="Default City" hint="City within selected state">
              <select value={config.defaultCity} onChange={e => set('defaultCity', e.target.value)} style={inputStyle}>
                {cities.map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </Field>
          </div>

          {/* Rotate on Expiry Toggle */}
          <div style={{
            marginTop: 16, padding: '12px 16px', borderRadius: 10,
            background: 'var(--mmb-surface2)', border: '1px solid var(--mmb-border)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--mmb-text)' }}>Auto-Rotate Proxy on Expiry</div>
              <div style={{ fontSize: 11, color: 'var(--mmb-muted)', marginTop: 2 }}>
                Automatically get a new proxy when current session expires
              </div>
            </div>
            <Toggle value={config.rotateOnExpiry} onChange={v => set('rotateOnExpiry', v)} />
          </div>
        </Section>

        {/* ══ Section 2: Preview & Test ══ */}
        <Section
          title="Preview & Test Connection"
          subtitle="See generated username and test live connection"
          icon={<Zap size={16} />}
          expanded={expandedSection === 'test'}
          onToggle={() => setExpandedSection(s => s === 'test' ? '' : 'test')}
        >
          {/* Username Preview */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: 'var(--mmb-muted)', marginBottom: 6, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em' }}>
              Generated Username (Sample)
            </div>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '10px 14px', borderRadius: 8, fontSize: 12,
              background: 'var(--mmb-surface2)', border: '1px solid var(--mmb-border)',
              fontFamily: 'monospace', color: 'var(--mmb-accent)', wordBreak: 'break-all',
            }}>
              <span style={{ flex: 1 }}>{previewUsername}</span>
              <button
                onClick={() => copyText(previewUsername, 'username')}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--mmb-muted)', flexShrink: 0 }}
              >
                {copiedId === 'username' ? <Check size={13} color="#22c55e" /> : <Copy size={13} />}
              </button>
            </div>
          </div>

          {/* Full connection string */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: 'var(--mmb-muted)', marginBottom: 6, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em' }}>
              Full Connection String
            </div>
            <div style={{
              padding: '10px 14px', borderRadius: 8, fontSize: 12,
              background: '#0f172a', border: '1px solid var(--mmb-border)',
              fontFamily: 'monospace', color: '#86efac', wordBreak: 'break-all',
            }}>
              {`http://${previewUsername}:${config.password}@${config.server}:${config.port}`}
            </div>
          </div>

          {/* Test Button + Result */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button
              onClick={handleTest}
              disabled={testStatus === 'testing'}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '10px 20px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                cursor: testStatus === 'testing' ? 'not-allowed' : 'pointer',
                background: testStatus === 'testing' ? 'var(--mmb-surface2)' : 'var(--mmb-accent)',
                border: 'none', color: '#fff',
              }}
            >
              {testStatus === 'testing'
                ? <><RefreshCw size={14} className="animate-spin" /> Testing...</>
                : <><CheckCircle size={14} /> Test Connection</>
              }
            </button>

            {testResult && (
              <div style={{
                flex: 1, padding: '8px 14px', borderRadius: 8, fontSize: 12,
                background: testStatus === 'ok' ? 'rgba(34,197,94,.1)' : 'rgba(239,68,68,.1)',
                border: `1px solid ${testStatus === 'ok' ? 'rgba(34,197,94,.3)' : 'rgba(239,68,68,.3)'}`,
                color: testStatus === 'ok' ? '#86efac' : '#fca5a5',
              }}>
                {testResult}
              </div>
            )}
          </div>
        </Section>

        {/* ══ Section 3: Custom Proxy Pool ══ */}
        <Section
          title="Custom Proxy Pool"
          subtitle="Add your own proxies for specific profiles"
          icon={<Shield size={16} />}
          expanded={expandedSection === 'custom'}
          onToggle={() => setExpandedSection(s => s === 'custom' ? '' : 'custom')}
          badge={customProxies.length > 0 ? String(customProxies.length) : undefined}
        >
          {/* Proxy List */}
          {customProxies.length === 0 && !showCustomForm && (
            <div style={{
              textAlign: 'center', padding: '32px 16px',
              color: 'var(--mmb-muted)', fontSize: 13,
            }}>
              <Globe size={32} style={{ margin: '0 auto 12px', opacity: .3 }} />
              <div>No custom proxies added yet</div>
              <div style={{ fontSize: 11, marginTop: 4 }}>Add proxies to use for specific profiles</div>
            </div>
          )}

          {customProxies.map(proxy => (
            <div key={proxy.id} style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '10px 14px', borderRadius: 8, marginBottom: 8,
              background: 'var(--mmb-surface2)', border: '1px solid var(--mmb-border)',
            }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--mmb-text)' }}>{proxy.label || proxy.server}</div>
                <div style={{ fontSize: 11, color: 'var(--mmb-muted)', fontFamily: 'monospace', marginTop: 2 }}>
                  {proxy.server}:{proxy.port} — {proxy.username}
                </div>
                {proxy.notes && (
                  <div style={{ fontSize: 11, color: 'var(--mmb-muted)', marginTop: 2, fontStyle: 'italic' }}>{proxy.notes}</div>
                )}
              </div>
              <button
                onClick={() => copyText(`http://${proxy.username}:${proxy.password}@${proxy.server}:${proxy.port}`, proxy.id)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--mmb-muted)', padding: 4 }}
                title="Copy connection string"
              >
                {copiedId === proxy.id ? <Check size={14} color="#22c55e" /> : <Copy size={14} />}
              </button>
              <button
                onClick={() => deleteCustomProxy(proxy.id)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', padding: 4 }}
                title="Delete"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}

          {/* Add Custom Proxy Form */}
          {showCustomForm && (
            <div style={{
              padding: 16, borderRadius: 10, marginBottom: 12,
              background: 'var(--mmb-surface2)', border: '1px solid var(--mmb-accent)',
            }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--mmb-text)', marginBottom: 12 }}>Add New Proxy</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <Field label="Label / Name">
                  <input value={newProxy.label} onChange={e => setNewProxy(p => ({ ...p, label: e.target.value }))} placeholder="e.g. US Proxy 1" style={inputStyle} />
                </Field>
                <Field label="Server">
                  <input value={newProxy.server} onChange={e => setNewProxy(p => ({ ...p, server: e.target.value }))} placeholder="proxy.example.com" style={inputStyle} />
                </Field>
                <Field label="Port">
                  <input type="number" value={newProxy.port} onChange={e => setNewProxy(p => ({ ...p, port: parseInt(e.target.value) || 3128 }))} style={inputStyle} />
                </Field>
                <Field label="Username">
                  <input value={newProxy.username} onChange={e => setNewProxy(p => ({ ...p, username: e.target.value }))} placeholder="username" style={inputStyle} />
                </Field>
                <Field label="Password">
                  <input type="password" value={newProxy.password} onChange={e => setNewProxy(p => ({ ...p, password: e.target.value }))} placeholder="password" style={inputStyle} />
                </Field>
                <Field label="Notes (optional)">
                  <input value={newProxy.notes} onChange={e => setNewProxy(p => ({ ...p, notes: e.target.value }))} placeholder="e.g. For profile group A" style={inputStyle} />
                </Field>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button onClick={addCustomProxy} style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '7px 14px', borderRadius: 7, fontSize: 12, fontWeight: 600,
                  background: 'var(--mmb-accent)', border: 'none', color: '#fff', cursor: 'pointer',
                }}>
                  <Plus size={13} /> Add Proxy
                </button>
                <button onClick={() => setShowCustomForm(false)} style={{
                  padding: '7px 14px', borderRadius: 7, fontSize: 12,
                  background: 'transparent', border: '1px solid var(--mmb-border)',
                  color: 'var(--mmb-muted)', cursor: 'pointer',
                }}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {!showCustomForm && (
            <button
              onClick={() => setShowCustomForm(true)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 500,
                background: 'transparent', border: '1px dashed var(--mmb-border)',
                color: 'var(--mmb-muted)', cursor: 'pointer', width: '100%',
                justifyContent: 'center', marginTop: customProxies.length > 0 ? 8 : 0,
              }}
            >
              <Plus size={14} /> Add Custom Proxy
            </button>
          )}
        </Section>

        {/* ══ Section 4: Info Card ══ */}
        <div style={{
          padding: '14px 16px', borderRadius: 10,
          background: 'rgba(79,70,229,.08)', border: '1px solid rgba(79,70,229,.2)',
          display: 'flex', gap: 12,
        }}>
          <Info size={16} color="var(--mmb-accent)" style={{ flexShrink: 0, marginTop: 1 }} />
          <div style={{ fontSize: 12, color: 'var(--mmb-muted)', lineHeight: 1.6 }}>
            <strong style={{ color: 'var(--mmb-text)' }}>How it works:</strong> Each profile gets a unique proxy session using your SmartProxy credentials.
            The username is auto-generated with state/city/session/life parameters.
            Changes here apply to all <strong>new</strong> profiles. Existing profiles keep their current proxy until renewed.
            Use <strong>Custom Proxy Pool</strong> to assign specific proxies to individual profiles.
          </div>
        </div>

      </div>
    </div>
  );
}

// ─── Helper Components ────────────────────────────────────────────────────────

function Section({
  title, subtitle, icon, children, expanded, onToggle, badge,
}: {
  title: string; subtitle: string; icon: React.ReactNode;
  children: React.ReactNode; expanded: boolean; onToggle: () => void; badge?: string;
}) {
  return (
    <div style={{
      borderRadius: 12, border: '1px solid var(--mmb-border)',
      background: 'var(--mmb-surface)', overflow: 'hidden',
    }}>
      {/* Section Header */}
      <button
        onClick={onToggle}
        style={{
          width: '100%', padding: '14px 18px',
          display: 'flex', alignItems: 'center', gap: 10,
          background: 'transparent', border: 'none', cursor: 'pointer',
          borderBottom: expanded ? '1px solid var(--mmb-border)' : 'none',
        }}
      >
        <div style={{
          width: 30, height: 30, borderRadius: 8,
          background: 'var(--mmb-accent-bg)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--mmb-accent)', flexShrink: 0,
        }}>
          {icon}
        </div>
        <div style={{ flex: 1, textAlign: 'left' }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--mmb-text)' }}>{title}</div>
          <div style={{ fontSize: 11, color: 'var(--mmb-muted)', marginTop: 1 }}>{subtitle}</div>
        </div>
        {badge && (
          <span style={{
            fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 99,
            background: 'var(--mmb-accent-bg)', color: 'var(--mmb-accent)',
          }}>{badge}</span>
        )}
        <div style={{ color: 'var(--mmb-muted)', flexShrink: 0 }}>
          {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </div>
      </button>
      {/* Section Body */}
      {expanded && (
        <div style={{ padding: '16px 18px' }}>
          {children}
        </div>
      )}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--mmb-text)' }}>{label}</label>
        {hint && <span style={{ fontSize: 11, color: 'var(--mmb-muted)' }}>— {hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!value)}
      style={{
        width: 44, height: 24, borderRadius: 99,
        background: value ? 'var(--mmb-accent)' : 'var(--mmb-border)',
        border: 'none', cursor: 'pointer', position: 'relative',
        transition: 'background .2s', flexShrink: 0,
      }}
    >
      <span style={{
        position: 'absolute', top: 3, width: 18, height: 18,
        borderRadius: '50%', background: '#fff',
        transition: 'left .2s',
        left: value ? 23 : 3,
        boxShadow: '0 1px 4px rgba(0,0,0,.2)',
      }} />
    </button>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid var(--mmb-border)',
  background: 'var(--mmb-surface2)',
  color: 'var(--mmb-text)',
  fontSize: 13,
  outline: 'none',
  boxSizing: 'border-box',
};
