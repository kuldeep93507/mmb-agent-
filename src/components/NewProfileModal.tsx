import { useState, useEffect } from "react";
import { X, Monitor, Smartphone, Apple, Zap, ChevronRight, Wifi, Globe, Cloud, Cpu, RotateCcw } from "lucide-react";
import type { OS } from "../types";
import { backendFetch } from '../services/backendOrigin';

type ActiveProvider = 'morelogin' | 'multilogin' | 'all';
type CreateProvider = 'morelogin' | 'multilogin';

interface NewProfileModalProps {
  onClose: () => void;
  activeProvider?: ActiveProvider;
  onCreate: (os: OS, proxyType?: string, profileMode?: string, androidDevice?: string) => Promise<{ code: number; message?: string }>;
}

const FALLBACK_ANDROID = [
  { label: '🎲 Auto Random', value: 'auto', desc: 'Backend picks from device pool' },
];

export default function NewProfileModal({ onClose, onCreate, activeProvider = 'multilogin' }: NewProfileModalProps) {
  const [createProvider, setCreateProvider] = useState<CreateProvider>(() => {
    if (activeProvider === 'morelogin' || activeProvider === 'multilogin') return activeProvider;
    try {
      const s = localStorage.getItem('mmb_create_provider');
      if (s === 'morelogin' || s === 'multilogin') return s;
    } catch { /* ignore */ }
    return 'multilogin';
  });
  const [androidOptions, setAndroidOptions] = useState(FALLBACK_ANDROID);

  const resolvedProvider: CreateProvider = activeProvider === 'all' ? createProvider : activeProvider;
  const isMoreLogin = resolvedProvider === 'morelogin';

  useEffect(() => {
    if (activeProvider === 'all') {
      try { localStorage.setItem('mmb_create_provider', createProvider); } catch { /* ignore */ }
    }
  }, [createProvider, activeProvider]);

  useEffect(() => {
    backendFetch('/api/android-devices')
      .then(r => r.json())
      .then(d => {
        if (d.code === 0 && d.data?.devices?.length) {
          setAndroidOptions([
            { label: '🎲 Auto Random', value: 'auto', desc: `Pool: ${d.data.total} devices from server` },
            ...d.data.devices.map((x: { label: string; value: string; desc: string }) => ({
              label: x.label,
              value: x.value,
              desc: x.desc,
            })),
          ]);
        }
      })
      .catch(() => { /* keep fallback */ });
  }, []);
  const [selectedOS, setSelectedOS] = useState<OS | null>(null);
  const [profileMode, setProfileMode] = useState<'cloud' | 'quick'>(isMoreLogin ? 'quick' : 'cloud');
  const [proxyType, setProxyType] = useState<'smartproxy' | 'multilogin'>('smartproxy');

  useEffect(() => {
    backendFetch('/api/settings')
      .then((r) => r.json())
      .then((d) => {
        const saved = d?.settings?.ytProxyType;
        if (saved === 'multilogin' || saved === 'smartproxy') {
          setProxyType(saved);
        }
      })
      .catch(() => { /* keep default */ });
  }, []);
  const [androidDevice, setAndroidDevice] = useState<string>('auto');
  const [count, setCount] = useState(1);
  const [creating, setCreating] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; errors: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failedIndices, setFailedIndices] = useState<number[]>([]);

  const OS_OPTIONS: { os: OS; icon: React.ReactNode; desc: string; color: string }[] = [
    {
      os: "Windows",
      icon: <Monitor size={28} />,
      desc: "Desktop — Chrome on Windows 10/11. Best for YouTube watch time.",
      color: "blue",
    },
    {
      os: "Android",
      icon: <Smartphone size={28} />,
      desc: "Mobile — Samsung/Pixel/OnePlus device. Natural mobile behavior.",
      color: "green",
    },
    {
      os: "macOS",
      icon: <Apple size={28} />,
      desc: "Desktop — Chrome/Safari on MacBook. Premium appearance.",
      color: "purple",
    },
  ];

  const PROFILE_MODE_OPTIONS = [
    {
      id: 'cloud' as const,
      label: '☁️ Cloud Profile (Persistent)',
      desc: 'Saved permanently in Multilogin cloud. Cookies & sessions persist across restarts. Recommended for long-term profiles.',
      badge: 'RECOMMENDED',
      badgeColor: 'bg-green-600',
      border: 'border-green-500 bg-green-900/20',
    },
    {
      id: 'quick' as const,
      label: '⚡ Quick Profile (Local / Temp)',
      desc: 'Temporary profile — full fingerprint control (Canvas, WebRTC, Timezone all REAL). Requires Multilogin X desktop app running.',
      badge: 'FULL FINGERPRINT',
      badgeColor: 'bg-blue-600',
      border: 'border-blue-500 bg-blue-900/20',
    },
  ];

  const PROXY_OPTIONS = [
    {
      id: 'smartproxy' as const,
      label: 'SmartProxy (Your Proxy)',
      desc: 'us.smartproxy.net HTTP proxy from your .env — separate from Multilogin built-in.',
      icon: <Globe size={16} />,
      color: 'text-green-400',
      bg: 'border-green-500 bg-green-900/20',
    },
    {
      id: 'multilogin' as const,
      label: 'Multilogin Built-in',
      desc: 'MLX residential via gate.multilogin.com (SOCKS5) — US/UK only. NOT SmartProxy.',
      icon: <Wifi size={16} />,
      color: 'text-blue-400',
      bg: 'border-blue-500 bg-blue-900/20',
    },
  ];

  const colorMap: Record<string, string> = {
    blue: "border-blue-500/50 bg-blue-500/10 text-blue-400",
    green: "border-green-500/50 bg-green-500/10 text-green-400",
    purple: "border-purple-500/50 bg-purple-500/10 text-purple-400",
  };
  const colorSelected: Record<string, string> = {
    blue: "border-blue-400 bg-blue-500/20 ring-2 ring-blue-500/40",
    green: "border-green-400 bg-green-500/20 ring-2 ring-green-500/40",
    purple: "border-purple-400 bg-purple-500/20 ring-2 ring-purple-500/40",
  };

  const runCreateBatch = async (indices: number[]) => {
    if (!selectedOS || indices.length === 0) return;
    setCreating(true);
    setError(null);
    const errors: string[] = progress?.errors ? [...progress.errors] : [];
    let done = progress?.done ?? 0;
    const deviceArg = selectedOS === 'Android' && androidDevice !== 'auto' ? androidDevice : undefined;
    const failed: number[] = [];

    for (const i of indices) {
      try {
        const result = await onCreate(selectedOS, proxyType, profileMode, deviceArg);
        if (result.code === 0) {
          done++;
          setProgress({ done, total: count, errors: [...errors] });
        } else {
          failed.push(i);
          errors.push(`Profile ${i + 1}: ${result.message?.trim() || 'Creation failed'}`);
          setProgress({ done, total: count, errors: [...errors] });
        }
      } catch (err: unknown) {
        failed.push(i);
        errors.push(`Profile ${i + 1}: ${err instanceof Error ? err.message : 'Network error'}`);
        setProgress({ done, total: count, errors: [...errors] });
      }
      await new Promise(r => setTimeout(r, 1500));
    }

    setCreating(false);
    setFailedIndices(failed);

    if (done === count) {
      onClose();
    } else if (done > 0) {
      setError(`Created ${done}/${count}. ${failed.length} failed — use Retry failed below.`);
    } else {
      setError(errors[errors.length - 1] || 'All profile creations failed');
    }
  };

  const handleCreate = async () => {
    if (!selectedOS) return;
    setProgress({ done: 0, total: count, errors: [] });
    setFailedIndices([]);
    await runCreateBatch(Array.from({ length: count }, (_, i) => i));
  };

  const handleRetryFailed = async () => {
    if (failedIndices.length === 0) return;
    await runCreateBatch(failedIndices);
  };

  const progressPct = progress ? Math.round((progress.done / progress.total) * 100) : 0;
  let stepNum = 1;

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <div>
            <h2 className="text-white font-bold text-lg">Create New Profile{count > 1 ? `s (${count})` : ''}</h2>
            <p className="text-gray-500 text-xs mt-0.5">
              {creating
                ? `Creating ${progress?.done ?? 0}/${progress?.total ?? count}...`
                : "Configure OS, mode, proxy, then create"}
            </p>
          </div>
          {!creating && (
            <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition-colors">
              <X size={20} />
            </button>
          )}
        </div>

        <div className="p-6 space-y-5">
          {error && (
            <div className="rounded-xl border border-red-700/40 bg-red-900/20 px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          )}

          {!creating ? (
            <>
              {activeProvider === 'all' && (
                <div>
                  <p className="text-white font-semibold text-sm mb-2">Create via provider</p>
                  <div className="flex gap-2">
                    {(['morelogin', 'multilogin'] as const).map(p => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => {
                          setCreateProvider(p);
                          setProfileMode(p === 'morelogin' ? 'quick' : 'cloud');
                        }}
                        className={`flex-1 py-2 rounded-xl border text-xs font-semibold capitalize transition-all
                          ${createProvider === p
                            ? p === 'morelogin'
                              ? 'border-blue-500 bg-blue-900/30 text-blue-300'
                              : 'border-purple-500 bg-purple-900/30 text-purple-300'
                            : 'border-gray-700 bg-gray-800 text-gray-500'}`}
                      >
                        {p === 'morelogin' ? '🔵 MoreLogin' : '🟣 Multilogin'}
                      </button>
                    ))}
                  </div>
                  <p className="text-gray-500 text-[10px] mt-1">Saved for next create while &quot;All Providers&quot; is selected in Settings.</p>
                </div>
              )}

              {/* ── STEP 1: OS Selection ── */}
              <div>
                <p className="text-white font-semibold text-sm mb-3">{stepNum++}️⃣ Select OS</p>
                <div className="space-y-2">
                  {OS_OPTIONS.map(({ os, icon, desc, color }) => {
                    const isSelected = selectedOS === os;
                    return (
                      <button
                        key={os}
                        type="button"
                        onClick={() => setSelectedOS(os)}
                        className={`w-full flex items-center gap-4 p-3.5 rounded-xl border transition-all duration-200
                          ${isSelected ? colorSelected[color] : "border-gray-700 bg-gray-800/40 hover:border-gray-600 hover:bg-gray-800/60"}`}
                      >
                        <div className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0
                          ${isSelected ? colorMap[color] : "bg-gray-800 text-gray-500"}`}>
                          {icon}
                        </div>
                        <div className="text-left flex-1">
                          <div className={`font-semibold text-sm ${isSelected ? "text-white" : "text-gray-300"}`}>{os}</div>
                          <div className="text-gray-500 text-xs mt-0.5 leading-relaxed">{desc}</div>
                        </div>
                        {isSelected && <ChevronRight size={16} className="text-gray-400 flex-shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* ── ANDROID DEVICE PICKER (only when Android selected) ── */}
              {selectedOS === 'Android' && (
                <div>
                  <p className="text-white font-semibold text-sm mb-1">
                    <span className="text-green-400">📱</span> Android Device
                    <span className="ml-2 text-xs text-gray-500 font-normal">Choose device fingerprint or let backend pick randomly</span>
                  </p>
                  <select
                    value={androidDevice}
                    onChange={e => setAndroidDevice(e.target.value)}
                    className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-green-500 transition-colors"
                  >
                    {androidOptions.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label} — {opt.desc}</option>
                    ))}
                  </select>
                  {androidDevice !== 'auto' && (
                    <p className="text-xs text-green-400 mt-1.5">
                      ✅ Will use: <span className="font-medium">{androidDevice}</span>
                    </p>
                  )}
                  {androidDevice === 'auto' && (
                    <p className="text-xs text-gray-500 mt-1.5">
                      🎲 Backend will randomly pick a device from 56+ Android models
                    </p>
                  )}
                </div>
              )}

              {/* ── STEP 2: Profile Mode ── */}
              <div>
                <p className="text-white font-semibold text-sm mb-3">{stepNum++}️⃣ Profile Mode</p>
                {isMoreLogin && (
                  <div className="mb-3 rounded-lg bg-blue-900/30 border border-blue-600/50 px-3 py-2 text-xs text-blue-200">
                    MoreLogin uses local API (port 40000). Keep the MoreLogin desktop app open before creating.
                  </div>
                )}
                <div className="space-y-2">
                  {(isMoreLogin
                    ? PROFILE_MODE_OPTIONS.filter((o) => o.id === 'quick').map((o) => ({
                        ...o,
                        label: 'MoreLogin Local API',
                        desc: 'http://127.0.0.1:40000 — profile saved in MoreLogin app.',
                      }))
                    : PROFILE_MODE_OPTIONS
                  ).map(opt => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setProfileMode(opt.id)}
                      className={`w-full flex items-start gap-3 p-3.5 rounded-xl border transition-all text-left
                        ${profileMode === opt.id ? opt.border : 'border-gray-700 bg-gray-800/40 hover:border-gray-600'}`}
                    >
                      <div className={`w-4 h-4 rounded-full border-2 flex-shrink-0 mt-0.5 ${profileMode === opt.id ? 'border-white bg-white' : 'border-gray-600'}`} />
                      <div className="flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className={`text-sm font-semibold ${profileMode === opt.id ? 'text-white' : 'text-gray-300'}`}>{opt.label}</p>
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${opt.badgeColor} text-white`}>{opt.badge}</span>
                        </div>
                        <p className="text-xs text-gray-500 mt-1 leading-relaxed">{opt.desc}</p>
                      </div>
                    </button>
                  ))}
                </div>

                {/* Mode info box */}
                {profileMode === 'cloud' && (
                  <div className="mt-2 rounded-lg bg-amber-900/30 border border-amber-600/40 px-3 py-2 text-xs text-amber-200 space-y-0.5">
                    <div className="flex items-center gap-2"><Cloud size={12} className="text-amber-400" /> <span>Multilogin cloud create may be unavailable (HTTP 501) — app auto-falls back to Quick/Local</span></div>
                    <div className="flex items-center gap-2"><span className="text-green-400">✅</span> <span>For reliable create right now, pick Quick/Local mode below</span></div>
                  </div>
                )}
                {profileMode === 'quick' && !isMoreLogin && (
                  <div className="mt-2 rounded-lg bg-gray-800 border border-gray-700 px-3 py-2 text-xs text-gray-400 space-y-0.5">
                    <div className="flex items-center gap-2"><Cpu size={12} className="text-blue-400" /> <span>Uses Local Launcher API — Multilogin X app must be running</span></div>
                    <div className="flex items-center gap-2"><span className="text-green-400">✅</span> <span>Full fingerprint control — Canvas, WebRTC, Timezone all REAL</span></div>
                    <div className="flex items-center gap-2"><span className="text-red-400">❌</span> <span>Temporary — profile deleted when browser closes</span></div>
                  </div>
                )}
              </div>

              {/* ── STEP 3: Proxy Type ── */}
              <div>
                <p className="text-white font-semibold text-sm mb-3">{stepNum++}️⃣ Proxy Type</p>
                <div className="space-y-2">
                  {(isMoreLogin ? PROXY_OPTIONS.filter((o) => o.id !== 'multilogin') : PROXY_OPTIONS).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setProxyType(opt.id)}
                      className={`w-full flex items-center gap-3 p-3 rounded-xl border transition-all text-left
                        ${proxyType === opt.id ? opt.bg : 'border-gray-700 bg-gray-800/40 hover:border-gray-600'}`}
                    >
                      <span className={opt.color}>{opt.icon}</span>
                      <div className="flex-1">
                        <p className={`text-sm font-medium ${proxyType === opt.id ? 'text-white' : 'text-gray-300'}`}>{opt.label}</p>
                        <p className="text-xs text-gray-500 mt-0.5">{opt.desc}</p>
                      </div>
                      <div className={`w-4 h-4 rounded-full border-2 flex-shrink-0 ${proxyType === opt.id ? 'border-white bg-white' : 'border-gray-600'}`} />
                    </button>
                  ))}
                </div>
              </div>

              {/* ── STEP 4: Count ── */}
              <div>
                <p className="text-white font-semibold text-sm mb-3">{stepNum++}️⃣ How many profiles?</p>
                <div className="flex items-center gap-3">
                  <div className="grid grid-cols-6 gap-2 flex-1">
                    {[1, 2, 5, 10, 15, 20].map(n => (
                      <button key={n} onClick={() => setCount(n)}
                        className={`py-2 rounded-xl border text-sm font-medium transition-all ${count === n ? 'border-red-500 bg-red-900/30 text-red-300' : 'border-gray-700 bg-gray-800 text-gray-400 hover:border-gray-600'}`}>
                        {n}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-gray-500 text-xs">Custom:</span>
                    <input type="number" min={1} max={50} value={count}
                      onChange={e => setCount(Math.max(1, Math.min(50, Number(e.target.value))))}
                      className="w-16 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-sm focus:outline-none focus:border-red-500" />
                  </div>
                </div>
                {count > 5 && (
                  <p className="text-xs text-yellow-400 mt-2">⚠️ Creating {count} profiles — this may take a few minutes.</p>
                )}
              </div>

              {/* ── Summary strip ── */}
              {selectedOS && (
                <div className="rounded-xl bg-gray-800/60 border border-gray-700 px-4 py-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-400">
                  <span>🖥️ <span className="text-white font-medium">{selectedOS}</span>{selectedOS === 'Android' && androidDevice !== 'auto' ? ` · ${androidDevice.split(' ').slice(-2).join(' ')}` : ''}</span>
                  <span>{profileMode === 'cloud' ? '☁️' : '⚡'} <span className="text-white font-medium">{profileMode === 'cloud' ? 'Cloud' : 'Quick/Local'}</span></span>
                  <span>🌐 <span className="text-white font-medium">{proxyType === 'smartproxy' ? 'SmartProxy (US)' : 'Multilogin Proxy (US/UK)'}</span></span>
                  <span>✕ <span className="text-white font-medium">{count}</span></span>
                </div>
              )}

              {failedIndices.length > 0 && !creating && (
                <button
                  type="button"
                  onClick={handleRetryFailed}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border border-amber-600/40 bg-amber-900/20 text-amber-300 text-sm font-medium hover:bg-amber-900/30"
                >
                  <RotateCcw size={14} />
                  Retry {failedIndices.length} failed profile(s)
                </button>
              )}

              {/* ── Buttons ── */}
              <div className="flex gap-3 pt-1">
                <button type="button" onClick={onClose}
                  className="flex-1 px-4 py-2.5 rounded-xl border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-all text-sm font-medium">
                  Cancel
                </button>
                <button type="button" onClick={handleCreate} disabled={!selectedOS}
                  className="flex-1 px-4 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 disabled:bg-gray-700 disabled:text-gray-500 text-white transition-all text-sm font-semibold flex items-center justify-center gap-2">
                  <Zap size={16} />
                  Create {count > 1 ? `${count} Profiles` : 'Profile'}
                </button>
              </div>
            </>
          ) : (
            /* Progress View */
            <div className="flex flex-col items-center gap-4 py-6">
              <div className="w-full">
                <div className="flex justify-between text-xs text-gray-400 mb-2">
                  <span>Creating {selectedOS} {profileMode === 'quick' ? 'Quick' : 'Cloud'} profiles...</span>
                  <span>{progress?.done ?? 0}/{progress?.total ?? count}</span>
                </div>
                <div className="w-full h-3 bg-gray-700 rounded-full overflow-hidden">
                  <div className="h-full bg-red-500 rounded-full transition-all duration-500" style={{ width: `${progressPct}%` }} />
                </div>
                <p className="text-center text-white font-semibold mt-3">{progressPct}%</p>
              </div>

              <div className="flex gap-1 justify-center">
                <div className="w-2 h-2 rounded-full bg-red-500 animate-bounce" style={{ animationDelay: "0ms" }} />
                <div className="w-2 h-2 rounded-full bg-red-500 animate-bounce" style={{ animationDelay: "150ms" }} />
                <div className="w-2 h-2 rounded-full bg-red-500 animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>

              <p className="text-gray-400 text-sm text-center">
                Creating profile {(progress?.done ?? 0) + 1} of {progress?.total ?? count}
                {` · ${proxyType === 'smartproxy' ? 'SmartProxy US' : 'Multilogin US/UK'}`}
                {` · ${profileMode === 'quick' ? '⚡ Quick' : '☁️ Cloud'}`}
              </p>

              {progress?.errors && progress.errors.length > 0 && (
                <div className="w-full bg-red-900/20 border border-red-700/30 rounded-xl p-3">
                  {progress.errors.map((e, i) => (
                    <p key={i} className="text-xs text-red-400">{e}</p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
