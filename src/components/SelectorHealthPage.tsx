import { useState, useEffect, useCallback } from 'react';
import { Wrench, Sparkles, Plus, Trash2, RefreshCw, ShieldCheck, AlertTriangle, Check } from 'lucide-react';
import { backendFetch } from '../services/backendOrigin';

interface KeyStatus {
  key: string;
  v2Count: number;
  overrideCount: number;
  totalCount: number;
  overrides: string[];
}
interface AdSkipFailures {
  count24h: number;
  threshold: number;
  needsHealing: boolean;
  lastProof: string;
  lastAt: number;
}
interface SelectorStatus {
  v2FileExists: boolean;
  healableKeys: string[];
  healHistoryCount: number;
  keys: KeyStatus[];
  adSkipFailures?: AdSkipFailures;
}
interface Proposal {
  proposed: string[];
  confidence: number;
  explanation: string;
}

const KEY_LABELS: Record<string, string> = {
  // Ads
  ad_skip_button: '⏭ Ad Skip button',
  ad_overlay_close: '✕ Ad Overlay close',
  // Playback
  play_button: '▶ Play button',
  pause_button: '⏸ Pause button',
  large_play_button_center: '⏯ Big center Play',
  mute_button: '🔇 Mute button',
  captions_subtitles_button: '🇨 Captions / CC',
  // Settings menu
  settings_gear_button: '⚙ Settings gear',
  quality_menu_item: '🎬 Quality menu item',
  quality_submenu_radio: '🎬 Quality option (360p…)',
  playback_speed_menu_item: '⏩ Speed menu item',
  playback_speed_submenu_radio: '⏩ Speed option (1.25x…)',
  // Engagement
  like_button: '👍 Like button',
  dislike_button: '👎 Dislike button',
  subscribe_button: '➕ Subscribe button',
  bell_notification_button: '🔔 Bell / Notification',
  bell_all_notifications_option: '🔔 Bell "All" option',
  // Comment
  comment_input_placeholder_click: '💬 Comment box (open)',
  comment_input_active_typing: '⌨ Comment input (type)',
  comment_submit_button: '📤 Comment submit',
  comment_like_button: '👍 Comment Like',
  // Autoplay / Description
  autoplay_toggle_button: '🔁 Autoplay toggle',
  description_more_button: '📄 Description "...more"',
  description_text_expanded: '📄 Description (expanded)',
};

export default function SelectorHealthPage() {
  const [status, setStatus] = useState<SelectorStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<Record<string, string>>({});
  const [healing, setHealing] = useState<string | null>(null);
  const [proposals, setProposals] = useState<Record<string, Proposal>>({});
  const [busy, setBusy] = useState<string | null>(null);
  // Master on/off — gates AI Heal (credit saver). Manual edit always allowed.
  const [healEnabled, setHealEnabled] = useState(true);

  useEffect(() => {
    void backendFetch('/api/settings')
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (d?.settings) {
          const v = d.settings.aiSelectorHealEnabled;
          setHealEnabled(v === undefined ? true : (v === true || v === 'true'));
        }
      })
      .catch(() => {});
  }, []);

  const toggleHealEnabled = async (on: boolean) => {
    setHealEnabled(on);
    try {
      await backendFetch('/api/settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aiSelectorHealEnabled: on }),
      });
    } catch { /* ignore */ }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await backendFetch('/api/selectors');
      const d = await r.json();
      if (d.success) { setStatus(d); setErr(null); } else setErr(d.error || 'load failed');
    } catch { setErr('Backend reachable nahi'); }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const applySelectors = async (key: string, selectors: string[], m: string) => {
    if (!selectors.length) return;
    setBusy(key);
    try {
      const r = await backendFetch('/api/selectors/apply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, selectors, mode: m || 'prepend' }),
      });
      const d = await r.json();
      if (d.success) { setDraft(p => ({ ...p, [key]: '' })); setProposals(p => { const n = { ...p }; delete n[key]; return n; }); await load(); }
      else setErr(d.error || 'apply failed');
    } catch { setErr('apply error'); }
    setBusy(null);
  };

  const removeOverride = async (key: string, selector: string) => {
    setBusy(key);
    try {
      await backendFetch('/api/selectors/remove', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, selector }),
      });
      await load();
    } catch { /* ignore */ }
    setBusy(null);
  };

  const aiHeal = async (key: string) => {
    setHealing(key);
    try {
      const r = await backendFetch('/api/selectors/heal', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, description: KEY_LABELS[key] || key }),
      });
      const d = await r.json();
      if (d.success && d.proposed) {
        setProposals(p => ({ ...p, [key]: { proposed: d.proposed, confidence: d.confidence ?? 0.5, explanation: d.explanation || '' } }));
      } else setErr(d.error || 'AI heal failed (ANTHROPIC_API_KEY set hai?)');
    } catch { setErr('heal error'); }
    setHealing(null);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-800 bg-gray-950/50 flex-shrink-0">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div style={{ width: 44, height: 44, borderRadius: 13, flexShrink: 0, background: 'var(--mmb-grad)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 8px 22px var(--mmb-accent-glow)' }}>
              <Wrench size={22} color="#fff" />
            </div>
            <div>
              <h1 className="text-2xl font-bold"><span className="mmb-gradient-text">Self-Healing Selectors</span></h1>
              <p className="text-gray-500 text-sm mt-0.5">YouTube DOM badle to AI naya selector dhundhe · tu confirm kare · code kabhi nahi tootega</p>
            </div>
          </div>
          <button onClick={() => void load()} className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium" style={{ background: 'var(--mmb-surface2)', border: '1px solid var(--mmb-border)', color: 'var(--mmb-text2)' }}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-4" style={{ maxWidth: 1100, margin: '0 auto', width: '100%' }}>
        {/* Master on/off toggle */}
        <div className="flex items-center justify-between gap-3 rounded-xl px-4 py-3" style={{ background: 'var(--mmb-grad-soft)', border: '1px solid var(--mmb-border)' }}>
          <div className="flex items-center gap-2.5 min-w-0">
            <Sparkles size={16} className="text-violet-400 flex-shrink-0" />
            <div className="min-w-0">
              <div className="text-sm font-semibold" style={{ color: 'var(--mmb-text)' }}>AI Self-Healing</div>
              <div className="text-xs" style={{ color: 'var(--mmb-muted)' }}>
                {healEnabled ? 'ON: AI Heal button se naye selector propose ho sakte hain' : 'OFF: AI Heal band (no credit) — manual edit phir bhi chalega'}
              </div>
            </div>
          </div>
          <label className="mmb-toggle flex-shrink-0">
            <input type="checkbox" checked={healEnabled} onChange={(e) => void toggleHealEnabled(e.target.checked)} />
            <span className="mmb-toggle-slider" />
          </label>
        </div>

        {/* Info banner */}
        <div className="rounded-xl px-4 py-3 flex items-start gap-2.5" style={{ background: 'var(--mmb-surface2)', border: '1px solid var(--mmb-border)' }}>
          <ShieldCheck size={16} className="text-emerald-400 flex-shrink-0 mt-0.5" />
          <div className="text-xs" style={{ color: 'var(--mmb-muted)' }}>
            Override <span className="font-mono">data/selector_overrides.json</span> mein save hote hain — V2 file / code kabhi edit nahi hota.
            AI sirf <b>propose</b> karta hai (Opus tier), apply tu karega. Override selectors pehle try hote hain.
          </div>
        </div>

        {err && (
          <div className="rounded-xl px-4 py-3 flex items-center gap-2 text-sm" style={{ background: 'var(--mmb-red-bg)', color: 'var(--mmb-red)' }}>
            <AlertTriangle size={15} /> {err}
          </div>
        )}

        {/* Ad-skip failure tracker banner — live runs se aata hai */}
        {status?.adSkipFailures && status.adSkipFailures.count24h > 0 && (
          <div className="rounded-xl px-4 py-3 flex items-start gap-2.5"
            style={{
              background: status.adSkipFailures.needsHealing ? 'var(--mmb-red-bg)' : 'var(--mmb-yellow-bg)',
              border: '1px solid var(--mmb-border)',
            }}>
            <AlertTriangle size={16} className={status.adSkipFailures.needsHealing ? 'text-red-400' : 'text-amber-400'} style={{ flexShrink: 0, marginTop: 2 }} />
            <div className="text-xs" style={{ color: 'var(--mmb-text2)' }}>
              <b>Ad Skip failures: {status.adSkipFailures.count24h}/{status.adSkipFailures.threshold}</b> (last 24h)
              {status.adSkipFailures.needsHealing
                ? <> — DOM shayad badla hai. Neeche <b>⏭ Ad Skip button</b> pe <b>AI Heal</b> dabao — failure ke waqt ka real DOM dump AI ko auto-milega. Apply karte hi counter reset + agli ad pe naya selector turant lagega (restart nahi chahiye).</>
                : <> — abhi threshold se neeche. {status.adSkipFailures.lastProof && <>Last: <span className="font-mono">{status.adSkipFailures.lastProof}</span></>}</>}
            </div>
          </div>
        )}

        {!status ? (
          <div className="text-center py-16" style={{ color: 'var(--mmb-muted)' }}>{loading ? 'Loading…' : 'No data'}</div>
        ) : status.keys.map(k => {
          const prop = proposals[k.key];
          return (
            <div key={k.key} className="mmb-card" style={{ padding: 0, overflow: 'hidden' }}>
              <div className="flex items-center justify-between gap-3 px-4 py-3" style={{ borderBottom: '1px solid var(--mmb-border)' }}>
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="font-semibold text-sm" style={{ color: 'var(--mmb-text)' }}>{KEY_LABELS[k.key] || k.key}</span>
                  <span className="font-mono text-[10px]" style={{ color: 'var(--mmb-muted)' }}>{k.key}</span>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold" style={{ background: 'var(--mmb-surface2)', color: 'var(--mmb-muted)' }}>{k.v2Count} base</span>
                  {k.overrideCount > 0 && <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold" style={{ background: 'var(--mmb-accent-bg)', color: 'var(--mmb-accent-text)' }}>+{k.overrideCount} override</span>}
                  <button onClick={() => void aiHeal(k.key)} disabled={healing === k.key || !healEnabled}
                    title={healEnabled ? 'AI naya selector propose karega' : 'AI Self-Healing OFF hai (upar toggle on karo)'}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed"
                    style={{ background: 'var(--mmb-grad)', boxShadow: healEnabled ? '0 4px 12px var(--mmb-accent-glow)' : 'none', border: 'none' }}>
                    {healing === k.key ? <RefreshCw size={12} className="animate-spin" /> : <Sparkles size={12} />} AI Heal
                  </button>
                </div>
              </div>

              <div className="px-4 py-3 space-y-3">
                {/* current overrides */}
                {k.overrides.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {k.overrides.map(s => (
                      <span key={s} className="flex items-center gap-1.5 text-[11px] font-mono px-2 py-1 rounded-lg" style={{ background: 'var(--mmb-surface2)', color: 'var(--mmb-text2)' }}>
                        {s}
                        <button onClick={() => void removeOverride(k.key, s)} title="Remove" className="opacity-60 hover:opacity-100"><Trash2 size={11} /></button>
                      </span>
                    ))}
                  </div>
                )}

                {/* AI proposal */}
                {prop && (
                  <div className="rounded-xl p-3" style={{ background: 'var(--mmb-accent-bg)', border: '1px solid var(--mmb-border)' }}>
                    <div className="flex items-center gap-2 mb-2">
                      <Sparkles size={13} className="text-violet-400" />
                      <span className="text-xs font-semibold" style={{ color: 'var(--mmb-text)' }}>AI proposed</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: prop.confidence >= 0.7 ? 'var(--mmb-green-bg)' : 'var(--mmb-yellow-bg)', color: prop.confidence >= 0.7 ? 'var(--mmb-green)' : 'var(--mmb-yellow)' }}>
                        {Math.round(prop.confidence * 100)}% confident
                      </span>
                    </div>
                    {prop.explanation && <p className="text-[11px] mb-2" style={{ color: 'var(--mmb-muted)' }}>{prop.explanation}</p>}
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {prop.proposed.map(s => <span key={s} className="text-[11px] font-mono px-2 py-1 rounded-lg" style={{ background: 'var(--mmb-surface)', color: 'var(--mmb-text2)' }}>{s}</span>)}
                    </div>
                    <button onClick={() => void applySelectors(k.key, prop.proposed, 'prepend')} disabled={busy === k.key}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white" style={{ background: 'var(--mmb-green)', border: 'none' }}>
                      <Check size={12} /> Apply these
                    </button>
                  </div>
                )}

                {/* manual add */}
                <div className="flex items-center gap-2">
                  <input
                    value={draft[k.key] || ''}
                    onChange={e => setDraft(p => ({ ...p, [k.key]: e.target.value }))}
                    placeholder="Manual CSS selector daalo (e.g. button.ytp-skip-ad-button)"
                    className="flex-1 text-xs font-mono rounded-lg px-3 py-2"
                    style={{ background: 'var(--mmb-surface)', border: '1px solid var(--mmb-border)', color: 'var(--mmb-text)' }}
                  />
                  <select value={mode[k.key] || 'prepend'} onChange={e => setMode(p => ({ ...p, [k.key]: e.target.value }))}
                    className="text-xs rounded-lg px-2 py-2 cursor-pointer" style={{ background: 'var(--mmb-surface)', border: '1px solid var(--mmb-border)', color: 'var(--mmb-text2)' }}>
                    <option value="prepend">Try first</option>
                    <option value="append">Fallback</option>
                    <option value="replace">Replace all</option>
                  </select>
                  <button onClick={() => void applySelectors(k.key, (draft[k.key] || '').split(',').map(s => s.trim()).filter(Boolean), mode[k.key] || 'prepend')}
                    disabled={busy === k.key || !(draft[k.key] || '').trim()}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-white disabled:opacity-40"
                    style={{ background: 'var(--mmb-accent)', border: 'none' }}>
                    <Plus size={12} /> Add
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
