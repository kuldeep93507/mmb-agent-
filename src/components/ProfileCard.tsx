import { Play, Square, Settings, Trash2, RefreshCw, Globe, Clock, Cookie, Mail, Lock, Pencil, Check, X } from 'lucide-react';
import { useState } from 'react';
import type { Profile } from '../types';
import { proxyProviderLabel, isMultiloginProxyHost } from '../utils/profileAdapter';
import { backendFetch } from '../services/backendOrigin';
import { loadGmailData, saveGmailData } from '../utils/gmailProfileStore';

const COOKIE_SITES = [
  { key: 'google', label: 'Google' },
  { key: 'facebook', label: 'Facebook' },
  { key: 'amazon', label: 'Amazon' },
  { key: 'ebay', label: 'eBay' },
  { key: 'etsy', label: 'Etsy' },
  { key: 'bing', label: 'Bing' },
  { key: 'mix', label: 'Mixed' },
];

interface ProfileCardProps {
  profile: Profile;
  isRecreating?: boolean;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  onSettings: (id: string) => void;
  onDelete: (id: string) => void;
  onRecreate: (id: string) => void;
  onToggleSelect: (id: string) => void;
}

const STATUS_CONFIG = {
  running:    { label: 'Running',    dot: 'bg-green-500 animate-pulse',  badge: 'bg-green-900/40 text-green-400 border-green-600/30' },
  stopped:    { label: 'Stopped',    dot: 'bg-gray-500',                  badge: 'bg-gray-800 text-gray-400 border-gray-700' },
  starting:   { label: 'Starting...', dot: 'bg-yellow-500 animate-pulse', badge: 'bg-yellow-900/40 text-yellow-400 border-yellow-600/30' },
  error:      { label: 'Error',       dot: 'bg-red-500 animate-pulse',    badge: 'bg-red-900/40 text-red-400 border-red-600/30' },
  recreating: { label: 'Recreating', dot: 'bg-blue-500 animate-pulse',   badge: 'bg-blue-900/40 text-blue-400 border-blue-600/30' },
};

const OS_CONFIG = {
  Windows: { icon: '🪟', color: 'bg-blue-900/40 text-blue-400 border-blue-700/30' },
  Android: { icon: '🤖', color: 'bg-green-900/40 text-green-400 border-green-700/30' },
  macOS:   { icon: '🍎', color: 'bg-purple-900/40 text-purple-400 border-purple-700/30' },
  Unknown: { icon: '❔', color: 'bg-gray-800 text-gray-400 border-gray-600/40' },
};

const PROVIDER_CONFIG = {
  morelogin:  { label: 'MoreLogin',  icon: '🔵', color: 'bg-blue-900/40 text-blue-400 border-blue-700/30' },
  multilogin: { label: 'Multilogin', icon: '🟣', color: 'bg-purple-900/40 text-purple-400 border-purple-700/30' },
} as const;

function providerBadge(bt: Profile['browserType']) {
  if (bt === 'morelogin' || bt === 'multilogin') return PROVIDER_CONFIG[bt];
  return null;
}

/** Gmail "G" logo — styled to match Google's brand colours */
function GmailBadge({ size = 'normal' }: { size?: 'small' | 'normal' }) {
  const cls = size === 'small'
    ? 'w-4 h-4 text-[9px]'
    : 'w-5 h-5 text-[10px]';
  return (
    <span
      title="Gmail profile — delete & recreate disabled"
      className={`${cls} rounded-full flex items-center justify-center font-black text-white flex-shrink-0`}
      style={{
        background: 'linear-gradient(135deg, #EA4335 25%, #FBBC05 50%, #34A853 75%, #4285F4 100%)',
        boxShadow: '0 0 0 1.5px rgba(255,255,255,0.15)',
      }}
    >
      G
    </span>
  );
}

export default function ProfileCard({
  profile, isRecreating = false,
  onStart, onStop, onSettings, onDelete, onRecreate, onToggleSelect,
}: ProfileCardProps) {
  const status     = isRecreating ? STATUS_CONFIG.recreating : STATUS_CONFIG[profile.status];
  const osConf     = OS_CONFIG[profile.os] ?? OS_CONFIG.Unknown;
  const providerConf = providerBadge(profile.browserType);

  // ── Cookie warming ──
  const [warmingState, setWarmingState] = useState<'idle' | 'loading' | 'ok' | 'err'>('idle');
  const [showWarmMenu, setShowWarmMenu] = useState(false);

  // ── Gmail state (persisted in localStorage) ──
  const [gmailData, setGmailDataState] = useState(() => loadGmailData(profile.id));
  const [editingEmail, setEditingEmail] = useState(false);
  const [emailDraft, setEmailDraft] = useState(gmailData.email);

  function updateGmail(patch: Partial<typeof gmailData>) {
    const next = { ...gmailData, ...patch };
    saveGmailData(profile.id, next);
    setGmailDataState(next);
  }

  function toggleGmail() {
    updateGmail({ isGmail: !gmailData.isGmail });
    // When turning OFF, also clear editing state
    if (gmailData.isGmail) setEditingEmail(false);
  }

  function commitEmail() {
    updateGmail({ email: emailDraft.trim() });
    setEditingEmail(false);
  }

  function startEditEmail() {
    setEmailDraft(gmailData.email);
    setEditingEmail(true);
  }

  async function warmCookies(site: string) {
    setShowWarmMenu(false);
    setWarmingState('loading');
    try {
      const res = await backendFetch('/api/cookies/metadata', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: profile.id, targetWebsite: site }),
      });
      const data = await res.json();
      setWarmingState(data.code === 0 ? 'ok' : 'err');
    } catch {
      setWarmingState('err');
    }
    setTimeout(() => setWarmingState('idle'), 3000);
  }

  const hasKnownExpiry  = profile.proxy.expiresAt > 0;
  const timeLeftMs      = hasKnownExpiry ? profile.proxy.expiresAt - Date.now() : NaN;
  const isExpired       = hasKnownExpiry && timeLeftMs <= 0;
  const timeLeftStr     = !hasKnownExpiry ? 'No expiry data' : isExpired ? 'Expired' : formatTime(timeLeftMs);

  function formatTime(ms: number) {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return h > 0 ? `${h}h ${m}m left` : `${m}m left`;
  }

  const city          = profile.proxy.city?.trim();
  const state         = profile.proxy.state?.trim();
  const locationLabel = city || state ? [city, state].filter(Boolean).join(', ') : '—';
  const sessionLabel  = profile.proxy.sessionId?.trim() || '—';
  const lifeLabel     = profile.proxy.life === 'unknown' ? '—' : profile.proxy.life;
  const proxyHostLabel = profile.proxy.server
    ? `${profile.proxy.server}${profile.proxy.port ? ':' + profile.proxy.port : ''}`
    : '—';
  const proxyKind  = proxyProviderLabel(profile.proxy.server);
  const isMlxProxy = isMultiloginProxyHost(profile.proxy.server);

  const canStart = !isRecreating && (profile.status === 'stopped' || profile.status === 'error');
  const canStop  = !isRecreating && (profile.status === 'running' || profile.status === 'starting');

  // Gmail profiles are protected — block destructive actions
  const isGmailProtected = gmailData.isGmail;

  return (
    <div className={`bg-gray-900 border rounded-2xl overflow-hidden transition-all duration-200
      ${isGmailProtected
        ? 'border-red-500/40 ring-1 ring-red-400/20'
        : profile.selected
          ? 'border-red-500/50 ring-1 ring-red-500/30'
          : 'border-gray-800 hover:border-gray-700'
      }`}>

      {/* ── Top Bar ── */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-800">
        {/* Checkbox */}
        <input
          type="checkbox"
          checked={profile.selected}
          onChange={() => onToggleSelect(profile.id)}
          className="w-4 h-4 accent-red-500 flex-shrink-0 cursor-pointer"
        />

        {/* OS Icon — with Gmail "G" overlay badge when tagged */}
        <div className="relative flex-shrink-0">
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-base border ${osConf.color}`}>
            {osConf.icon}
          </div>
          {isGmailProtected && (
            <div className="absolute -bottom-1 -right-1">
              <GmailBadge size="small" />
            </div>
          )}
        </div>

        {/* Name + Badges */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-white font-semibold text-sm truncate">{profile.name}</span>
            <span className={`text-xs px-1.5 py-0.5 rounded-md border font-medium flex-shrink-0 ${osConf.color}`}>
              {profile.os}
            </span>
            {providerConf && (
              <span
                title={`Browser provider: ${providerConf.label}`}
                className={`text-xs px-1.5 py-0.5 rounded-md border font-medium flex-shrink-0 flex items-center gap-1 ${providerConf.color}`}
              >
                <span className="text-[10px]">{providerConf.icon}</span>
                {providerConf.label}
              </span>
            )}
            {/* Gmail badge inline */}
            {isGmailProtected && (
              <span className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-md border border-red-500/30 bg-red-900/20 text-red-300 font-medium flex-shrink-0">
                <GmailBadge size="small" />
                Gmail
              </span>
            )}
          </div>

          <div className="text-gray-500 text-xs truncate font-mono mt-0.5">{profile.id}</div>
        </div>

        {/* Status */}
        <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium flex-shrink-0 ${status.badge}`}>
          <div className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />
          {status.label}
        </div>
      </div>

      {/* ── Body ── */}
      <div className="px-4 py-3 space-y-2">
        {/* IP + Location */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <Globe size={12} className="text-gray-500 flex-shrink-0" />
            <span className={`text-xs font-mono ${profile.ip ? 'text-green-400' : 'text-gray-600'}`}>
              {profile.ip || '—.—.—.—'}
            </span>
          </div>
          <div className="text-xs text-gray-500">{locationLabel}</div>
          <div className="flex items-center gap-1 ml-auto">
            <Clock size={11} className="text-gray-600" />
            <span className={`text-xs ${!hasKnownExpiry ? 'text-gray-600' : isExpired ? 'text-red-400' : 'text-gray-500'}`}>
              {timeLeftStr}
            </span>
          </div>
        </div>

        {/* Proxy info */}
        <div className="bg-gray-800/60 rounded-lg px-3 py-1.5 space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className={`text-[10px] font-semibold uppercase tracking-wide ${isMlxProxy ? 'text-purple-400' : 'text-green-400'}`}>
              {proxyKind}
            </span>
            <span className="text-[10px] text-gray-500 font-mono truncate">{proxyHostLabel}</span>
          </div>
          {!isMlxProxy && (
            <div className="text-gray-600 text-xs truncate font-mono">
              session: <span className="text-gray-400">{sessionLabel}</span> • life: <span className="text-gray-400">{lifeLabel}</span>
            </div>
          )}
        </div>

        {/* Current Action */}
        <div className="flex items-center gap-2">
          <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${profile.status === 'running' ? 'bg-green-500' : 'bg-gray-600'}`} />
          <span className="text-gray-400 text-xs">{profile.currentAction}</span>
        </div>

        {/* Fingerprint quick info */}
        <div className="grid grid-cols-3 gap-2">
          <div className="bg-gray-800/40 rounded-lg px-2 py-1.5 text-center">
            <div className="text-gray-600 text-xs">Canvas</div>
            <div className="text-green-400 text-xs font-medium truncate px-0.5" title={profile.fingerprint.canvas}>
              {profile.fingerprint.canvasNoise?.seed
                ? `noise ${String(profile.fingerprint.canvasNoise.seed).slice(0, 6)}…`
                : profile.fingerprint.canvas?.trim()
                  ? profile.fingerprint.canvas.slice(0, 14)
                  : '—'}
            </div>
          </div>
          <div className="bg-gray-800/40 rounded-lg px-2 py-1.5 text-center">
            <div className="text-gray-600 text-xs">WebRTC</div>
            <div className="text-green-400 text-xs font-medium truncate px-0.5" title={String(profile.fingerprint.webRTC)}>
              {profile.fingerprint.webRTC ? String(profile.fingerprint.webRTC).slice(0, 12) : '—'}
            </div>
          </div>
          <div className="bg-gray-800/40 rounded-lg px-2 py-1.5 text-center">
            <div className="text-gray-600 text-xs">TZ</div>
            <div className="text-blue-400 text-xs font-medium truncate px-0.5" title={profile.fingerprint.timezone}>
              {profile.fingerprint.timezone?.trim()
                ? profile.fingerprint.timezone.includes('/')
                  ? profile.fingerprint.timezone.split('/')[1] || profile.fingerprint.timezone
                  : profile.fingerprint.timezone
                : '—'}
            </div>
          </div>
        </div>

        {/* Gmail Toggle + Email Row */}
        <div className={`rounded-xl border transition-all ${
          isGmailProtected
            ? 'bg-red-950/30 border-red-500/30'
            : 'bg-gray-800/40 border-gray-700/40 hover:border-gray-600/60'
        }`}>
          {/* Toggle header */}
          <div className="flex items-center justify-between px-3 py-2">
            <div className="flex items-center gap-2">
              <GmailBadge />
              <div>
                <p className="text-xs font-medium text-white">Gmail Profile</p>
                <p className="text-[10px] text-gray-500">
                  {isGmailProtected ? 'Protected — delete/recreate locked' : 'Mark if this profile has a Gmail account'}
                </p>
              </div>
            </div>
            {/* Toggle switch */}
            <button
              onClick={toggleGmail}
              title={isGmailProtected ? 'Remove Gmail tag' : 'Mark as Gmail profile'}
              className={`relative w-10 h-5 rounded-full transition-all duration-200 flex-shrink-0 ${
                isGmailProtected ? 'bg-red-500' : 'bg-gray-700 hover:bg-gray-600'
              }`}
            >
              <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all duration-200 ${
                isGmailProtected ? 'left-5' : 'left-0.5'
              }`} />
            </button>
          </div>

          {/* Email input — only shown when Gmail is tagged */}
          {isGmailProtected && (
            <div className="px-3 pb-2.5 border-t border-red-500/20 pt-2">
              <div className="flex items-center gap-1.5 mb-1">
                <Mail size={11} className="text-red-400/70 flex-shrink-0" />
                <span className="text-[10px] text-gray-500 font-medium uppercase tracking-wide">Gmail Account</span>
              </div>
              {editingEmail ? (
                <div className="flex items-center gap-2">
                  <input
                    autoFocus
                    value={emailDraft}
                    onChange={e => setEmailDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') commitEmail(); if (e.key === 'Escape') setEditingEmail(false); }}
                    placeholder="example@gmail.com"
                    className="flex-1 bg-gray-900 border border-red-500/40 rounded-lg px-3 py-1.5 text-sm text-white outline-none focus:border-red-400/70 placeholder-gray-600 font-mono"
                  />
                  <button onClick={commitEmail} title="Save" className="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-lg bg-green-600/20 border border-green-600/40 text-green-400 hover:bg-green-600/30">
                    <Check size={13} />
                  </button>
                  <button onClick={() => setEditingEmail(false)} title="Cancel" className="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-lg bg-gray-800 border border-gray-700 text-gray-400 hover:text-gray-200">
                    <X size={13} />
                  </button>
                </div>
              ) : (
                <button
                  onClick={startEditEmail}
                  className="w-full flex items-center justify-between gap-2 bg-gray-900 border border-gray-700/60 rounded-lg px-3 py-1.5 hover:border-red-500/40 transition-all group"
                >
                  <span className={`text-sm font-mono truncate ${gmailData.email ? 'text-red-300' : 'text-gray-600 italic'}`}>
                    {gmailData.email || 'Click to add email…'}
                  </span>
                  <Pencil size={11} className="text-gray-600 group-hover:text-gray-400 flex-shrink-0 transition-all" />
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {isRecreating && (
        <div className="px-4 pb-2 border-t border-gray-800/50 pt-2">
          <div className="flex justify-between text-[10px] text-blue-400 mb-1">
            <span>Recreating profile…</span>
            <span className="animate-pulse">Please wait</span>
          </div>
          <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
            <div className="h-full bg-blue-500 rounded-full animate-pulse w-2/3" />
          </div>
        </div>
      )}

      {/* ── Action Buttons ── */}
      <div className="px-4 py-3 border-t border-gray-800 flex items-center gap-2">
        {/* Start */}
        <button
          onClick={() => onStart(profile.id)}
          disabled={!canStart}
          title="Start Profile"
          className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-semibold transition-all
            ${canStart
              ? 'bg-green-600/20 border border-green-600/40 text-green-400 hover:bg-green-600/30 hover:border-green-500/60'
              : 'bg-gray-800/50 border border-gray-700 text-gray-600 cursor-not-allowed'}`}>
          <Play size={12} />
          Start
        </button>

        {/* Stop */}
        <button
          onClick={() => onStop(profile.id)}
          disabled={!canStop}
          title="Stop Profile"
          className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-semibold transition-all
            ${canStop
              ? 'bg-red-600/20 border border-red-600/40 text-red-400 hover:bg-red-600/30 hover:border-red-500/60'
              : 'bg-gray-800/50 border border-gray-700 text-gray-600 cursor-not-allowed'}`}>
          <Square size={12} />
          Stop
        </button>

        {/* Settings */}
        <button
          onClick={() => onSettings(profile.id)}
          title="Settings"
          className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-gray-800 border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-all">
          <Settings size={12} />
          Settings
        </button>

        {/* Recreate — locked for Gmail profiles */}
        {isGmailProtected ? (
          <div
            title="Gmail profile — recreate disabled to protect your account"
            className="flex items-center justify-center gap-1 px-3 py-2 rounded-xl text-xs font-semibold bg-gray-800/40 border border-gray-700/40 text-gray-600 cursor-not-allowed select-none">
            <Lock size={11} />
            Recreate
          </div>
        ) : (
          <button
            onClick={() => onRecreate(profile.id)}
            disabled={isRecreating}
            title="Recreate with new proxy + fingerprint"
            className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-blue-900/20 border border-blue-700/30 text-blue-400 hover:bg-blue-900/30 hover:border-blue-600/50 transition-all disabled:opacity-40 disabled:cursor-not-allowed">
            <RefreshCw size={12} className={isRecreating ? 'animate-spin' : ''} />
            Recreate
          </button>
        )}

        {/* Delete — locked for Gmail profiles */}
        {isGmailProtected ? (
          <div
            title="Gmail profile — delete disabled to protect your account"
            className="flex items-center justify-center px-3 py-2 rounded-xl text-xs font-semibold bg-gray-800/40 border border-gray-700/40 text-gray-600 cursor-not-allowed select-none">
            <Lock size={11} />
          </div>
        ) : (
          <button
            onClick={() => onDelete(profile.id)}
            title="Delete Profile"
            className="flex items-center justify-center px-3 py-2 rounded-xl text-xs font-semibold bg-red-900/20 border border-red-700/30 text-red-500 hover:bg-red-900/30 hover:border-red-600/50 transition-all">
            <Trash2 size={12} />
          </button>
        )}
      </div>

      {/* ── Cookie Warming — Multilogin only ── */}
      {profile.browserType === 'multilogin' && (
        <div className="px-4 pb-3 relative">
          <button
            onClick={() => setShowWarmMenu(v => !v)}
            disabled={warmingState === 'loading'}
            title="Warm cookies for this profile"
            className={`w-full flex items-center justify-center gap-1.5 py-1.5 rounded-xl text-xs font-semibold border transition-all
              ${warmingState === 'ok'      ? 'bg-green-900/30 border-green-700/40 text-green-400' :
                warmingState === 'err'     ? 'bg-red-900/30 border-red-700/40 text-red-400' :
                warmingState === 'loading' ? 'bg-orange-900/20 border-orange-700/30 text-orange-400 animate-pulse' :
                'bg-orange-900/20 border-orange-700/30 text-orange-400 hover:bg-orange-900/30 hover:border-orange-600/50'}`}>
            <Cookie size={11} />
            {warmingState === 'loading' ? 'Setting...' : warmingState === 'ok' ? 'Cookies Warmed!' : warmingState === 'err' ? 'Failed' : 'Warm Cookies'}
          </button>
          {showWarmMenu && (
            <div className="absolute left-4 right-4 bottom-full mb-1 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl z-50 overflow-hidden">
              <div className="px-3 py-2 text-[10px] text-gray-500 font-semibold uppercase tracking-wider border-b border-gray-800">Target Website</div>
              {COOKIE_SITES.map(site => (
                <button key={site.key} onClick={() => warmCookies(site.key)}
                  className="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-gray-800 hover:text-white transition-all">
                  {site.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
