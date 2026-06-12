# MMB AGENT — Cursor Instructions
# Bhai ye file Cursor ko do — isme sab kuch likha hai

---

## BACKEND (server_python/) — ALREADY FIXED ✅
## Cursor ko kuch NAHI karna hai backend mein

Ye files workspace mein hain — REPLACE KARO repo mein:

```
server_python/__init__.py              → workspace se lo
server_python/account_manager.py      → workspace se lo
server_python/ad_skip_engine.py       → workspace se lo
server_python/agent_manager.py        → workspace se lo  ← IMPORTANT (big bug fixed)
server_python/analytics_store.py      → workspace se lo
server_python/entropy.py              → workspace se lo  ← Google/Bing paths added
server_python/guardian.py             → workspace se lo
server_python/human_engine.py         → workspace se lo
server_python/identity_manager.py     → workspace se lo
server_python/main.py                 → workspace se lo
server_python/notification_path.py    → workspace se lo
server_python/session_behavior.py     → workspace se lo
server_python/session_behavior.py     → workspace se lo
server_python/sidebar_video.py        → workspace se lo
server_python/smart_proxy.py          → workspace se lo
server_python/worker_manager.py       → workspace se lo
server_python/yt_actions.py           → workspace se lo
requirements.txt                      → workspace se lo  ← NEW file

server_python/behavior/youtube/__init__.py         → workspace se lo
server_python/behavior/youtube/action_audit.py     → workspace se lo
server_python/behavior/youtube/action_context.py   → workspace se lo
server_python/behavior/youtube/desktop.py          → workspace se lo
server_python/behavior/youtube/entry_flow.py       → workspace se lo
server_python/behavior/youtube/play_pause_limiter.py → workspace se lo
server_python/behavior/youtube/player_controls.py  → workspace se lo
server_python/behavior/youtube/player_focus.py     → workspace se lo
server_python/behavior/youtube/quality.py          → workspace se lo
server_python/behavior/youtube/safe_actions.py     → workspace se lo
server_python/behavior/youtube/scroll_activity.py  → workspace se lo
server_python/behavior/youtube/selectors.py        → workspace se lo
server_python/behavior/youtube/state.py            → workspace se lo
server_python/behavior/youtube/verify_actions.py   → workspace se lo
```

### Repo mein ye files UNCHANGED REHNE DO (touch mat karna):
```
server_python/ai_brain.py
server_python/anti_sleep.py
server_python/cdp_mouse.py
server_python/fingerprint_builder.py
server_python/fourteen_actions.py
server_python/orchestrator.py
server_python/profile_creator.py
server_python/recycle_engine.py
server_python/watch_history.py
server_python/yt_types.py
```

---

## FRONTEND (src/) — Cursor ko YE CHANGES KARNE HAIN

---

### FILE 1: src/components/EngagementPage.tsx

#### Change 1 — Traffic Source Type (line ~45 ke paas)
FIND:
```typescript
type Source = 'notification' | 'search' | 'direct' | 'homepage';
```
REPLACE:
```typescript
type Source =
  | 'notification'
  | 'search'
  | 'direct'
  | 'homepage'
  | 'google'
  | 'bing';
```

#### Change 2 — State variables add karo (srcHome ke baad)
FIND:
```typescript
const [srcHome, setSrcHome] = useState(30);
```
REPLACE:
```typescript
const [srcHome,   setSrcHome]   = useState(20);
const [srcGoogle, setSrcGoogle] = useState(15);
const [srcBing,   setSrcBing]   = useState(10);
```

#### Change 3 — srcDirect calculation
FIND:
```typescript
const srcDirect = Math.max(0, 100 - srcNotif - srcSearch - srcHome);
```
REPLACE:
```typescript
const srcDirect = Math.max(0, 100 - srcNotif - srcSearch - srcHome - srcGoogle - srcBing);
```

#### Change 4 — makeDefault() source logic
FIND (inside makeDefault function):
```typescript
const source: Source =
  roll <= srcNotif ? 'notification' :
  roll <= srcNotif + srcSearch ? 'search' :
  roll <= srcNotif + srcSearch + srcHome ? 'homepage' :
  'direct';
```
REPLACE:
```typescript
const source: Source = (() => {
  let r = roll;
  if (r <= srcNotif)  return 'notification';
  r -= srcNotif;
  if (r <= srcSearch) return 'search';
  r -= srcSearch;
  if (r <= srcHome)   return 'homepage';
  r -= srcHome;
  if (r <= srcGoogle) return 'google';
  r -= srcGoogle;
  if (r <= srcBing)   return 'bing';
  return 'direct';
})();
```

#### Change 5 — Traffic Tab sliders
FIND:
```typescript
{ label: '🔔 Notification', value: srcNotif, set: setSrcNotif, color: 'accent-yellow-500' },
{ label: '🔍 YouTube Search', value: srcSearch, set: setSrcSearch, color: 'accent-blue-500' },
{ label: '🏠 Homepage', value: srcHome, set: setSrcHome, color: 'accent-green-500' },
```
REPLACE:
```typescript
{ label: '🔔 Notification',   value: srcNotif,  set: setSrcNotif,  color: 'accent-yellow-500' },
{ label: '🔍 YouTube Search', value: srcSearch, set: setSrcSearch, color: 'accent-blue-500'   },
{ label: '🏠 Homepage',       value: srcHome,   set: setSrcHome,   color: 'accent-green-500'  },
{ label: '🌐 Google Search',  value: srcGoogle, set: setSrcGoogle, color: 'accent-red-400'    },
{ label: '🔷 Bing Search',    value: srcBing,   set: setSrcBing,   color: 'accent-purple-400' },
```

#### Change 6 — Auto-calculated text
FIND:
```
Auto-calculated: 100 - (Notif + Search + Home)
```
REPLACE:
```
Auto-calculated: 100 - (Notif + YT Search + Home + Google + Bing)
```

#### Change 7 — Source dropdowns (2 jagah milega — dono replace karo)
FIND (BOTH occurrences):
```tsx
<option value="notification">🔔 Notif</option>
<option value="search">🔍 Search</option>
<option value="homepage">🏠 Home</option>
<option value="direct">🔗 Direct</option>
```
REPLACE (BOTH occurrences):
```tsx
<option value="notification">🔔 Notification</option>
<option value="search">🔍 YouTube</option>
<option value="homepage">🏠 Homepage</option>
<option value="google">🌐 Google</option>
<option value="bing">🔷 Bing</option>
<option value="direct">🔗 Direct</option>
```

#### Change 8 — Job source emoji
FIND:
```tsx
{job.source === 'notification' ? '🔔' : job.source === 'search' ? '🔍' : job.source === 'homepage' ? '🏠' : '🔗'}
```
REPLACE:
```tsx
{job.source === 'notification' ? '🔔'
  : job.source === 'search'   ? '🔍'
  : job.source === 'homepage' ? '🏠'
  : job.source === 'google'   ? '🌐'
  : job.source === 'bing'     ? '🔷'
  : '🔗'}
```

#### Change 9 — Hindi text → English (sab replace karo)
| FIND | REPLACE |
|------|---------|
| `Koi video nahi — "Add Video" click karo aur channel se video chunno` | `No videos added yet — click "Add Video" to select from your channels` |
| `— Channel select karo —` | `— Select a channel —` |
| `Koi Gmail profile nahi hai` | `No Gmail profiles found` |
| `Pehle Gmail Setup page mein profiles ka email bharo` | `Add Gmail credentials in the Gmail Setup page first` |
| `'❌ Pehle koi video add karo'` | `'❌ Add at least one video first'` |
| `'❌ Koi Gmail profile select nahi'` | `'❌ Select at least one Gmail profile'` |

#### Change 10 — Developer comment (UI se hatao)
FIND:
```
← ek source of truth, no conflict
```
REPLACE:
```tsx
{/* single source of truth */}
```

#### Change 11 — setTimeout anti-pattern fix
`useRef` ko imports mein add karo:
```typescript
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
```

Component ke andar add karo (kisi bhi useState ke baad):
```typescript
const pendingPresetRef = useRef<PresetName | null>(null);
```

FIND:
```typescript
function applyPreset(name: PresetName) {
  setActivePreset(name);
  if (name === 'custom') return;
  const p = PRESETS[name];
  setLikePct(p.like);
  setDislikePct(p.dislike);
  setSubscribePct(p.subscribe);
  setBellPct(p.bell);
  setCommentPct(p.comment);
  setCommentLikePct(p.commentLike);
  // Refresh per-profile toggles from new percentages
  setTimeout(() => applyGlobalPct(), 0);
}
```
REPLACE:
```typescript
function applyPreset(name: PresetName) {
  setActivePreset(name);
  if (name === 'custom') return;
  const p = PRESETS[name];
  setLikePct(p.like);
  setDislikePct(p.dislike);
  setSubscribePct(p.subscribe);
  setBellPct(p.bell);
  setCommentPct(p.comment);
  setCommentLikePct(p.commentLike);
  pendingPresetRef.current = name;
}

useEffect(() => {
  if (pendingPresetRef.current && pendingPresetRef.current !== 'custom') {
    pendingPresetRef.current = null;
    applyGlobalPct();
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [likePct, dislikePct, subscribePct, bellPct, commentPct, commentLikePct]);
```

---

### FILE 2: src/components/VideoShufflePage.tsx

#### Change 1 — Google/Bing loop traffic state add karo
FIND:
```typescript
const [loopSrcHome, setLoopSrcHome] = useState(30);
```
REPLACE:
```typescript
const [loopSrcHome,   setLoopSrcHome]   = useState(20);
const [loopSrcGoogle, setLoopSrcGoogle] = useState(15);
const [loopSrcBing,   setLoopSrcBing]   = useState(10);
```

#### Change 2 — syncShuffleStateToServer call mein Google/Bing add karo
FIND:
```typescript
settings: {
  ...settings,
  srcNotificationPct: loopSrcNotif,
  srcSearchPct: loopSrcSearch,
  srcHomepagePct: loopSrcHome,
} as unknown as Record<string, unknown>,
recycleConfig: {
  enabled: recycleStatus?.enabled ?? false,
  profileIds: loopProfileIds,
  activeProfileLimit: activeLoopLimit,
  cooldownMinMinutes: cooldownMin,
  cooldownMaxMinutes: cooldownMax,
  srcNotificationPct: loopSrcNotif,
  srcSearchPct: loopSrcSearch,
  srcHomepagePct: loopSrcHome,
},
```
REPLACE:
```typescript
settings: {
  ...settings,
  srcNotificationPct: loopSrcNotif,
  srcSearchPct:       loopSrcSearch,
  srcHomepagePct:     loopSrcHome,
  srcGooglePct:       loopSrcGoogle,
  srcBingPct:         loopSrcBing,
} as unknown as Record<string, unknown>,
recycleConfig: {
  enabled:             recycleStatus?.enabled ?? false,
  profileIds:          loopProfileIds,
  activeProfileLimit:  activeLoopLimit,
  cooldownMinMinutes:  cooldownMin,
  cooldownMaxMinutes:  cooldownMax,
  srcNotificationPct:  loopSrcNotif,
  srcSearchPct:        loopSrcSearch,
  srcHomepagePct:      loopSrcHome,
  srcGooglePct:        loopSrcGoogle,
  srcBingPct:          loopSrcBing,
},
```

#### Change 3 — Server se load karo Google/Bing
FIND:
```typescript
if (typeof rc?.srcHomepagePct === 'number') setLoopSrcHome(rc.srcHomepagePct);
```
FIND ke BAAD add karo:
```typescript
if (typeof rc?.srcGooglePct === 'number') setLoopSrcGoogle(rc.srcGooglePct);
if (typeof rc?.srcBingPct   === 'number') setLoopSrcBing(rc.srcBingPct);
```

#### Change 4 — useEffect dependency array mein add karo
FIND (useEffect jo sync karta hai):
```typescript
}, [assignments, channelConfigs, settings, loopProfileIds, activeLoopLimit, cooldownMin, cooldownMax, loopSrcNotif, loopSrcSearch, loopSrcHome, serverSynced, recycleStatus?.enabled]);
```
REPLACE:
```typescript
}, [assignments, channelConfigs, settings, loopProfileIds, activeLoopLimit, cooldownMin, cooldownMax, loopSrcNotif, loopSrcSearch, loopSrcHome, loopSrcGoogle, loopSrcBing, serverSynced, recycleStatus?.enabled]);
```

#### Change 5 — Traffic sliders UI mein Google/Bing add karo
Jo section mein loopSrcNotif, loopSrcSearch, loopSrcHome ke sliders hain,
unke BAAD ye add karo:
```tsx
{/* Google Search */}
<div className="flex items-center gap-3">
  <span className="text-xs text-gray-400 w-32 shrink-0">🌐 Google</span>
  <input
    type="range" min={0} max={60} value={loopSrcGoogle}
    onChange={e => setLoopSrcGoogle(Number(e.target.value))}
    className="flex-1 h-1.5 accent-red-400"
  />
  <span className="text-xs text-white w-8 text-right">{loopSrcGoogle}%</span>
</div>
{/* Bing Search */}
<div className="flex items-center gap-3">
  <span className="text-xs text-gray-400 w-32 shrink-0">🔷 Bing</span>
  <input
    type="range" min={0} max={40} value={loopSrcBing}
    onChange={e => setLoopSrcBing(Number(e.target.value))}
    className="flex-1 h-1.5 accent-purple-400"
  />
  <span className="text-xs text-white w-8 text-right">{loopSrcBing}%</span>
</div>
```

#### Change 6 — Hindi text → English
| FIND | REPLACE |
|------|---------|
| `'24/7 loop: pehle kam se kam 1 profile select karo'` | `'24/7 loop: select at least 1 profile first'` |
| `'24/7 loop: pehle channels enable karo'` | `'24/7 loop: enable at least one channel first'` |

---

### FILE 3: src/components/Sidebar.tsx

#### Change 1 — SidebarProps mein profiles add karo
FIND:
```typescript
interface SidebarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  runningCount: number;
  pendingJobs: number;
  activeChannels?: number;
}
```
REPLACE:
```typescript
interface SidebarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  runningCount: number;
  pendingJobs: number;
  activeChannels?: number;
  profiles?: { id: string }[];
}
```

#### Change 2 — Function signature mein profiles add karo
FIND:
```typescript
export default function Sidebar({ activeTab, setActiveTab, runningCount, pendingJobs, activeChannels = 0 }: SidebarProps) {
```
REPLACE:
```typescript
export default function Sidebar({ activeTab, setActiveTab, runningCount, pendingJobs, activeChannels = 0, profiles = [] }: SidebarProps) {
```

#### Change 3 — Hardcoded 50 hatao
FIND:
```typescript
const totalProfiles = 50; // fixed fleet size
```
REPLACE:
```typescript
const totalProfiles = profiles.length;
```

#### Change 4 — App.tsx mein Sidebar call mein profiles pass karo
src/App.tsx mein jahan Sidebar render hota hai, wahan `profiles={profiles}` add karo:
```tsx
<Sidebar
  activeTab={activeTab}
  setActiveTab={setActiveTab}
  runningCount={runningCount}
  pendingJobs={pendingJobs}
  profiles={profiles}
/>
```

---

### FILE 4: src/components/Dashboard.tsx

#### Change 1 — lastRefreshed state add karo
Component ke andar (kisi useState ke baad) add karo:
```typescript
const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
const [_tick, setTick] = useState(0);
```

#### Change 2 — setInterval mein timestamp save karo
FIND:
```typescript
useEffect(() => { refresh(); const id=setInterval(refresh,5000); return ()=>clearInterval(id); }, [refresh]);
```
REPLACE:
```typescript
useEffect(() => {
  const doRefresh = async () => {
    await refresh();
    setLastRefreshed(new Date());
  };
  doRefresh();
  const id = setInterval(doRefresh, 5000);
  // Live counter — tick every second so "Xs ago" updates
  const tickId = setInterval(() => setTick(t => t + 1), 1000);
  return () => { clearInterval(id); clearInterval(tickId); };
}, [refresh]);
```

#### Change 3 — "Live · 5s" text replace karo
FIND:
```tsx
{offline ? 'Offline' : 'Live · 5s'}
```
REPLACE:
```tsx
{offline
  ? 'Offline'
  : lastRefreshed
    ? `Updated ${Math.round((Date.now() - lastRefreshed.getTime()) / 1000)}s ago`
    : 'Connecting...'}
```

---

### FILE 5: src/components/SchedulerPage.tsx

#### Change 1 — State add karo
Component ke andar add karo:
```typescript
const [concWarning, setConcWarning] = useState<{scheduleId: string; msg: string} | null>(null);
```

#### Change 2 — window.confirm replace karo
FIND:
```typescript
const proceed = window.confirm(
  `Concurrency limit: ${conc.limit} max, ${conc.running} running, ${conc.available} slots free.\n` +
  `You selected ${schedule.selectedProfiles.length} profiles but only ${conc.available} slots free.\n\nProceed anyway?`
);
if (!proceed) return;
```
REPLACE:
```typescript
if (schedule.selectedProfiles.length > (conc?.available ?? 99)) {
  setConcWarning({
    scheduleId: id,
    msg: `⚠️ Concurrency: ${conc?.limit} max, ${conc?.running} running, ${conc?.available} free. ` +
         `You selected ${schedule.selectedProfiles.length} profiles — ` +
         `${schedule.selectedProfiles.length - (conc?.available ?? 0)} will queue.`,
  });
  return;
}
```

#### Change 3 — handleRunForce function add karo (handleRun ke baad)
```typescript
const handleRunForce = useCallback(async (id: string) => {
  setConcWarning(null);
  // Call handleRun but skip concurrency check
  // Simplest: just call handleRun — it will re-check but user already confirmed
  await handleRun(id);
}, [handleRun]);
```

#### Change 4 — Inline warning UI add karo (schedule card mein Run button ke paas)
Schedule list mein jahan har schedule render hota hai, Run button ke baad:
```tsx
{concWarning && concWarning.scheduleId === s.id && (
  <div className="mt-2 p-3 bg-yellow-900/30 border border-yellow-700/40 rounded-xl">
    <p className="text-xs text-yellow-300 mb-2">{concWarning.msg}</p>
    <div className="flex gap-2">
      <button
        onClick={() => void handleRunForce(s.id)}
        className="px-3 py-1.5 bg-yellow-600/40 border border-yellow-600/50 text-yellow-200 rounded-lg text-xs font-semibold hover:bg-yellow-600/60 transition-all"
      >
        ✓ Proceed Anyway
      </button>
      <button
        onClick={() => setConcWarning(null)}
        className="px-3 py-1.5 bg-gray-700 border border-gray-600 text-gray-300 rounded-lg text-xs hover:bg-gray-600 transition-all"
      >
        Cancel
      </button>
    </div>
  </div>
)}
```

---

## SUMMARY — Cursor ke liye

```
Backend files:  30 files → workspace se copy karo repo mein
                Kuch mat change karo — sab ready hain

Frontend files: 5 files → upar diye changes apply karo
  1. EngagementPage.tsx  — 11 changes
  2. VideoShufflePage.tsx — 6 changes  
  3. Sidebar.tsx          — 4 changes
  4. Dashboard.tsx        — 3 changes
  5. SchedulerPage.tsx    — 4 changes
```

## IMPORTANT NOTES

1. Backend mein koi bhi naya code mat likhna — sab ready hai
2. Frontend mein sirf YE changes karo — kuch extra mat karna
3. Har change ke liye exact FIND text copy karo — typo mat karna
4. SchedulerPage mein handleRunForce mein handleRun reference ke liye
   ensure karo ki handleRun useCallback ke andar hai
5. Dashboard mein `_tick` state sirf re-render trigger ke liye hai —
   use karna nahi, bas declare karna hai
