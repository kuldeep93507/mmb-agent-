import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot, Play, RefreshCw, MousePointerClick, Square,
  Users, Film, LayoutGrid, List, Sparkles, CalendarDays, GanttChart, History, Cloud,
} from 'lucide-react';
import type { Profile } from '../../types';
import type { Channel, Video } from '../../store/useChannelStore';
import {
  applyRuntimeToSlots,
  applyExecutionToSlots,
  slotPreviewPhase,
  buildProfileDaySummary,
  generateCampaignDemoPlan,
  type DemoCampaignPlan,
  type DemoPlanSlot,
} from '../../utils/mastermindDemoPlan';
import {
  DEFAULT_CAMPAIGN_GOALS,
  DEFAULT_CAMPAIGN_DEFAULTS,
  DEFAULT_PLAN_WINDOW,
  migrateTrafficMixToQuotas,
  trafficQuotasTotal,
  type DemoCampaignGoals,
  type DemoCampaignVideo,
  type DemoCampaignDefaults,
  type DemoProfileSettings,
} from '../../utils/mastermindDemoTypes';
import { getWatchHistory, markProfileVideoWatched, seedDemoWatchHistory } from '../../utils/mastermindWatchHistory';
import {
  fetchMastermindState,
  saveMastermindCampaign,
  saveMastermindPlan,
  planFromServerEntry,
  fetchMastermindExecutionStatus,
  startMastermindExecution,
  stopMastermindExecution,
  isBackendReachable,
  isMastermindBackendReady,
  type MastermindExecutionStatus,
} from '../../utils/mastermindApi';

/** offline · outdated (restart) · online · synced · saving */
type ServerLinkStatus = 'offline' | 'outdated' | 'online' | 'synced' | 'saving';
import ProfileDetailDrawer from './ProfileDetailDrawer';
import ProfileDayScheduleModal from './ProfileDayScheduleModal';
import ProfileDayTimeline from './ProfileDayTimeline';
import CampaignGoalsHeader from './CampaignGoalsHeader';
import CampaignDefaultsPanel from './CampaignDefaultsPanel';
import CampaignVideosPanel from './CampaignVideosPanel';
import TrafficSyncPanel from './TrafficSyncPanel';
import HourlyPlanBoard from './HourlyPlanBoard';
import CapacityCalculator from './CapacityCalculator';
import PlanWindowPanel from './PlanWindowPanel';
import CommentTemplatePicker from './CommentTemplatePicker';
import ProfileGanttChart from './ProfileGanttChart';
import ByVideoPlanView from './ByVideoPlanView';
import PlanExportBar from './PlanExportBar';
import PlanSchedulePanel from './PlanSchedulePanel';
import PlanActionLegend from './PlanActionLegend';
import ProfileActionBadge from './ProfileActionBadge';
import MastermindLogsPanel from './MastermindLogsPanel';
import ProfileSelectionPanel from './ProfileSelectionPanel';
import AIGoalPlannerPanel from './AIGoalPlannerPanel';
import MastermindSimpleGuide from './MastermindSimpleGuide';
import HourlySpreadChart from './HourlySpreadChart';
import { DEFAULT_TRAFFIC_ENTRY_SEC } from '../../utils/mastermindDemoTypes';
import { syncVideoGoalsFromTraffic } from '../../utils/mastermindTrafficSync';

const DEMO_STORAGE_KEY = 'mmb_mastermind_demo_v5';

function normalizeDefaults(raw: Partial<DemoCampaignDefaults> | undefined, totalViews = 1000): DemoCampaignDefaults {
  const base = { ...DEFAULT_CAMPAIGN_DEFAULTS };
  if (!raw) return base;
  const legacyMix = (raw as { trafficMix?: Record<string, number> }).trafficMix;
  const trafficQuotas = raw.trafficQuotas
    ?? (legacyMix ? migrateTrafficMixToQuotas(legacyMix, totalViews) : base.trafficQuotas);
  return {
    ...base,
    ...raw,
    trafficQuotas: { ...base.trafficQuotas, ...trafficQuotas },
    planWindow: { ...DEFAULT_PLAN_WINDOW, ...raw.planWindow },
    hourlyViewTargets: raw.hourlyViewTargets ?? [],
    keepProfileOpenIfGapUnderMin: raw.keepProfileOpenIfGapUnderMin
      ?? (raw as { profileCooldownMin?: number }).profileCooldownMin ?? base.keepProfileOpenIfGapUnderMin,
    closeProfileIfGapOverMin: raw.closeProfileIfGapOverMin
      ?? (raw as { profileCooldownMin?: number }).profileCooldownMin ?? base.closeProfileIfGapOverMin,
    profileReopenMin: raw.profileReopenMin
      ?? (raw as { profileCooldownMin?: number }).profileCooldownMin ?? base.profileReopenMin,
    profileReopenMax: raw.profileReopenMax
      ?? (raw as { profileCooldownMax?: number }).profileCooldownMax ?? base.profileReopenMax,
    adOverrunBufferSec: raw.adOverrunBufferSec ?? base.adOverrunBufferSec,
    adSkipEnabled: raw.adSkipEnabled ?? base.adSkipEnabled,
    adSkipDelayMinSec: raw.adSkipDelayMinSec ?? base.adSkipDelayMinSec,
    adSkipDelayMaxSec: raw.adSkipDelayMaxSec ?? base.adSkipDelayMaxSec,
    adClickEnabled: raw.adClickEnabled ?? base.adClickEnabled,
    adClickDelayMinSec: raw.adClickDelayMinSec ?? base.adClickDelayMinSec,
    adClickDelayMaxSec: raw.adClickDelayMaxSec ?? base.adClickDelayMaxSec,
    adClickVisitSec: raw.adClickVisitSec ?? base.adClickVisitSec,
    commentLikeEnabled: raw.commentLikeEnabled ?? base.commentLikeEnabled,
    descriptionLinks: raw.descriptionLinks ?? base.descriptionLinks,
    descriptionLinkUrl: raw.descriptionLinkUrl ?? base.descriptionLinkUrl,
    descriptionLinkVisitSec: raw.descriptionLinkVisitSec ?? base.descriptionLinkVisitSec,
    qualityChangeEnabled: raw.qualityChangeEnabled ?? base.qualityChangeEnabled,
    playbackSpeed: raw.playbackSpeed ?? base.playbackSpeed,
    preRollAdSec: raw.preRollAdSec ?? base.preRollAdSec,
    midRollAdSec: raw.midRollAdSec ?? base.midRollAdSec,
    trafficEntrySec: { ...DEFAULT_TRAFFIC_ENTRY_SEC, ...raw.trafficEntrySec },
    parallelTabOnOverlap: raw.parallelTabOnOverlap ?? base.parallelTabOnOverlap,
    noRepeatSameVideo: raw.noRepeatSameVideo ?? true,
    commentTemplateId: raw.commentTemplateId ?? '',
  };
}

interface StoredState {
  goals: DemoCampaignGoals;
  defaults: DemoCampaignDefaults;
  videos: DemoCampaignVideo[];
  overrides: Record<string, DemoProfileSettings>;
  /** null/undefined = sab profiles (naye bhi auto-include) */
  selectedProfileIds?: string[] | null;
}

interface Props {
  profiles: Profile[];
  channels: Channel[];
  getVideos: (channelId: number, filter?: string) => Video[];
}

type MainTab = 'ai-planner' | 'setup' | 'plan' | 'logs';
type PlanView = 'timeline' | 'byVideo' | 'byProfile' | 'gantt' | 'hourly';

function loadDemoState(): StoredState | null {
  try {
    let raw = sessionStorage.getItem(DEMO_STORAGE_KEY);
    if (!raw) {
      raw = sessionStorage.getItem('mmb_mastermind_demo_v4') ?? sessionStorage.getItem('mmb_mastermind_demo_v1');
    }
    if (!raw) {
      const legacy = null as string | null;
      return null;
    }
    const parsed = JSON.parse(raw) as StoredState;
    return {
      goals: { ...DEFAULT_CAMPAIGN_GOALS, ...parsed.goals },
      defaults: normalizeDefaults(parsed.defaults, parsed.goals?.views ?? 1000),
      videos: parsed.videos ?? [],
      overrides: parsed.overrides ?? {},
      selectedProfileIds: parsed.selectedProfileIds ?? null,
    };
  } catch {
    return null;
  }
}

function saveDemoState(data: StoredState) {
  try {
    sessionStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(data));
  } catch { /* ignore */ }
}

export default function MastermindDemoPanel({ profiles, channels, getVideos }: Props) {
  const saved = loadDemoState();
  const [mainTab, setMainTab] = useState<MainTab>('ai-planner');
  const [planView, setPlanView] = useState<PlanView>('timeline');
  const [campaignGoals, setCampaignGoals] = useState<DemoCampaignGoals>(saved?.goals ?? { ...DEFAULT_CAMPAIGN_GOALS });
  const [defaultPerVideoViews, setDefaultPerVideoViews] = useState(
    saved?.goals?.views ?? DEFAULT_CAMPAIGN_GOALS.views,
  );
  const [campaignDefaults, setCampaignDefaults] = useState<DemoCampaignDefaults>(saved?.defaults ?? normalizeDefaults(undefined));
  const [campaignVideos, setCampaignVideos] = useState<DemoCampaignVideo[]>(saved?.videos ?? []);
  const [profileOverrides, setProfileOverrides] = useState<Record<string, DemoProfileSettings>>(saved?.overrides ?? {});
  const [selectedProfileIds, setSelectedProfileIds] = useState<string[] | null>(saved?.selectedProfileIds ?? null);
  const selectedProfileIdsRef = useRef<string[] | null>(saved?.selectedProfileIds ?? null);
  useEffect(() => { selectedProfileIdsRef.current = selectedProfileIds; }, [selectedProfileIds]);
  const [plan, setPlan] = useState<DemoCampaignPlan | null>(null);
  const [generating, setGenerating] = useState(false);
  const [detailSlot, setDetailSlot] = useState<DemoPlanSlot | null>(null);
  const [dayModalProfile, setDayModalProfile] = useState<{ id: string; name: string } | null>(null);
  const [filter, setFilter] = useState<'all' | 'ready' | 'warn' | 'done' | 'pending'>('all');
  const [selectedVideoId, setSelectedVideoId] = useState<string | 'all'>('all');
  const [byVideoId, setByVideoId] = useState<string>('');
  const [watchHistoryCount, setWatchHistoryCount] = useState(() => getWatchHistory().length);
  const [serverStatus, setServerStatus] = useState<ServerLinkStatus>('offline');
  const [serverSavedAt, setServerSavedAt] = useState<string | null>(null);
  const [execution, setExecution] = useState<MastermindExecutionStatus | null>(null);
  const [startingExec, setStartingExec] = useState(false);
  const [execError, setExecError] = useState<string | null>(null);
  const [fromAIPlanner, setFromAIPlanner] = useState(false);
  const [setupAdvancedOpen, setSetupAdvancedOpen] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [, tick] = useState(0);

  /** Sirf selected profiles — null selection = sab */
  const profileList = useMemo(() => {
    const all = profiles.map(p => ({ id: p.id, name: p.name || p.id.slice(0, 8) }));
    if (selectedProfileIds === null) return all;
    const sel = new Set(selectedProfileIds);
    return all.filter(p => sel.has(p.id));
  }, [profiles, selectedProfileIds]);

  /** Profiles hain lekin user ne sab deselect kar diye → plan mat banao (warna mock 48 use ho jayenge) */
  const noProfileSelected = profiles.length > 0 && profileList.length === 0;

  useEffect(() => {
    const id = setInterval(() => {
      if (!plan) return;
      const now = new Date();
      setPlan(prev => {
        if (!prev) return prev;
        let slots = prev.slots;
        if (execution?.active || (execution?.stats.done ?? 0) > 0) {
          const map = new Map((execution?.slots ?? []).map(s => [s.id, s.status]));
          slots = applyExecutionToSlots(slots, map);
          slots.filter(s => s.execStatus === 'done').forEach(s => {
            markProfileVideoWatched(s.profileId, s.videoId, s.videoTitle, s.dayKey);
          });
        } else {
          slots = applyRuntimeToSlots(slots, now);
        }
        setWatchHistoryCount(getWatchHistory().length);
        const profileSummaries = prev.profileSummaries.map(ps =>
          buildProfileDaySummary(ps.profileId, ps.profileName, slots, now),
        );
        return { ...prev, slots, profileSummaries };
      });
      tick(t => t + 1);
    }, 15000);
    return () => clearInterval(id);
  }, [plan?.dayKey, execution?.active, execution?.stats.done, execution?.slots]);

  useEffect(() => {
    if (!plan) return;
    let cancelled = false;
    const poll = async () => {
      const ex = await fetchMastermindExecutionStatus();
      if (!cancelled) setExecution(ex);
    };
    void poll();
    const id = setInterval(() => { void poll(); }, 8000);
    return () => { cancelled = true; clearInterval(id); };
  }, [plan?.dayKey]);

  useEffect(() => {
    void (async () => {
      const reachable = await isBackendReachable();
      if (!reachable) {
        setServerStatus('offline');
        return;
      }

      const mastermindReady = await isMastermindBackendReady();
      if (!mastermindReady) {
        setServerStatus('outdated');
        return;
      }

      const state = await fetchMastermindState();
      if (state?.execution) setExecution(state.execution);

      if (state?.latestPlan?.plan) {
        setPlan(planFromServerEntry(state.latestPlan));
        if (state.latestPlan.plan.videos?.length) {
          setByVideoId(state.latestPlan.plan.videos[0].videoId);
        }
        setServerSavedAt(state.latestPlan.savedAt ?? null);
      }

      if (state?.campaign) {
        const c = state.campaign;
        setCampaignGoals({ ...DEFAULT_CAMPAIGN_GOALS, ...c.goals });
        setDefaultPerVideoViews(c.goals?.views ?? DEFAULT_CAMPAIGN_GOALS.views);
        setCampaignDefaults(normalizeDefaults(c.defaults, c.goals?.views ?? 1000));
        setCampaignVideos(c.videos ?? []);
        setProfileOverrides(c.overrides ?? {});
        const serverSel = (c as { selectedProfileIds?: string[] | null }).selectedProfileIds ?? null;
        setSelectedProfileIds(serverSel);
        saveDemoState({
          goals: { ...DEFAULT_CAMPAIGN_GOALS, ...c.goals },
          defaults: normalizeDefaults(c.defaults, c.goals?.views ?? 1000),
          videos: c.videos ?? [],
          overrides: c.overrides ?? {},
          selectedProfileIds: serverSel,
        });
        setServerSavedAt(state.latestPlan?.savedAt ?? c.updatedAt ?? state.updatedAt ?? null);
        setServerStatus('synced');
        return;
      }

      // API online but campaign abhi server file me nahi — local setup use karo + auto-save
      setServerStatus('online');
      const local = loadDemoState();
      const goals = local?.goals ?? campaignGoals;
      const defaults = local?.defaults ?? campaignDefaults;
      const videos = local?.videos ?? campaignVideos;
      const overrides = local?.overrides ?? profileOverrides;
      const sel = local?.selectedProfileIds ?? selectedProfileIdsRef.current;
      const ok = await saveMastermindCampaign({ goals, defaults, videos, overrides, selectedProfileIds: sel });
      setServerStatus(ok ? 'synced' : 'online');
      if (ok) setServerSavedAt(new Date().toISOString());
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hydrate once on mount
  }, []);

  const persist = useCallback((g: DemoCampaignGoals, d: DemoCampaignDefaults, v: DemoCampaignVideo[], o: Record<string, DemoProfileSettings>, sel?: string[] | null) => {
    const selIds = sel !== undefined ? sel : selectedProfileIdsRef.current;
    saveDemoState({ goals: g, defaults: d, videos: v, overrides: o, selectedProfileIds: selIds });
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      setServerStatus('saving');
      void saveMastermindCampaign({ goals: g, defaults: d, videos: v, overrides: o, selectedProfileIds: selIds }).then(async ok => {
        if (ok) {
          setServerStatus('synced');
          setServerSavedAt(new Date().toISOString());
        } else {
          const up = await isBackendReachable();
          setServerStatus(up ? 'online' : 'offline');
        }
      });
    }, 800);
  }, []);

  const applyAIPlannerCampaign = (payload: {
    goals: DemoCampaignGoals;
    defaults: DemoCampaignDefaults;
    videos: DemoCampaignVideo[];
    campaignName: string;
    profileOverrides: Record<string, DemoProfileSettings>;
    autoGenerate: boolean;
    autoStartRun?: boolean;
    realPlan?: DemoCampaignPlan;
  }) => {
    const trafficTotal = trafficQuotasTotal(payload.defaults.trafficQuotas);
    const syncedGoals = syncVideoGoalsFromTraffic(
      payload.videos.map(v => ({ id: v.id, viewGoal: v.viewGoal })),
      trafficTotal || payload.goals.views,
      'equal',
    );
    const syncedVideos = payload.videos.map(v => ({
      ...v,
      viewGoal: syncedGoals.find(s => s.id === v.id)?.viewGoal ?? v.viewGoal,
    }));

    setFromAIPlanner(true);
    setSetupAdvancedOpen(false);
    setCampaignGoals(payload.goals);
    setDefaultPerVideoViews(payload.goals.views);
    setCampaignDefaults(payload.defaults);
    setCampaignVideos(syncedVideos);
    const mergedOverrides = { ...profileOverrides, ...payload.profileOverrides };
    setProfileOverrides(mergedOverrides);
    persist(payload.goals, payload.defaults, syncedVideos, mergedOverrides);
    setMainTab(payload.autoGenerate || payload.autoStartRun ? 'plan' : 'setup');

    const commitPlan = async (next: DemoCampaignPlan) => {
      const trafficTotal = trafficQuotasTotal(payload.defaults.trafficQuotas);
      const goals = { ...payload.goals, views: trafficTotal || payload.goals.views };
      setPlan(next);
      setCampaignGoals(goals);
      if (next.videos.length) setByVideoId(next.videos[0].videoId);
      const saved = await saveMastermindPlan(next);
      if (saved.ok) {
        setServerStatus('synced');
        setServerSavedAt(new Date().toISOString());
      }
      setMainTab('plan');
      if (payload.autoStartRun) {
        await startRealRunWithPlan(next);
      }
    };

    if (payload.realPlan && (payload.autoGenerate || payload.autoStartRun)) {
      if (noProfileSelected) return;
      setGenerating(true);
      void commitPlan(payload.realPlan).finally(() => setGenerating(false));
      return;
    }

    if (payload.autoGenerate && !noProfileSelected) {
      setGenerating(true);
      void (async () => {
        const trafficTotal = trafficQuotasTotal(payload.defaults.trafficQuotas);
        const goals = { ...payload.goals, views: trafficTotal || payload.goals.views };
        const next = await generateCampaignDemoPlan({
          campaignGoals: goals,
          campaignDefaults: payload.defaults,
          videos: payload.videos,
          profiles: profileList,
          profileOverrides: mergedOverrides,
        });
        await commitPlan(next);
        setGenerating(false);
      })();
    }
  };

  const runDemo = () => {
    setGenerating(true);
    void (async () => {
      const trafficTotal = trafficQuotasTotal(campaignDefaults.trafficQuotas);
      const goals = { ...campaignGoals, views: trafficTotal || campaignGoals.views };
      const next = await generateCampaignDemoPlan({
        campaignGoals: goals,
        campaignDefaults,
        videos: campaignVideos,
        profiles: profileList,
        profileOverrides,
      });
      setPlan(next);
      setCampaignGoals(goals);
      if (next.videos.length) setByVideoId(next.videos[0].videoId);
      persist(goals, campaignDefaults, campaignVideos, profileOverrides);
      const saved = await saveMastermindPlan(next);
      if (saved.ok) {
        setServerStatus('synced');
        setServerSavedAt(new Date().toISOString());
      }
      setMainTab('plan');
      setGenerating(false);
    })();
  };

  const fillSampleVideos = () => {
    const active = channels.filter(c => c.status === 'active' || c.status === 'syncing');
    const batch: DemoCampaignVideo[] = [];
    const perChannel = Math.max(1, Math.ceil(10 / Math.max(1, active.length)));

    for (let ci = 0; ci < Math.min(10, active.length || 10); ci++) {
      const ch = active[ci];
      if (ch) {
        const vids = getVideos(ch.id).slice(0, perChannel);
        vids.forEach((v, vi) => {
          batch.push({
            id: v.video_id || `${ch.id}-${vi}`,
            url: v.url || `https://youtube.com/watch?v=${v.video_id}`,
            title: v.title,
            channelName: ch.channel_name,
            channelId: ch.id,
            viewGoal: 1000,
            durationSec: v.duration > 0 ? v.duration : 600,
          });
        });
      } else {
        batch.push({
          id: `mock-ch-${ci}`,
          url: `https://youtube.com/watch?v=mock${ci}`,
          title: `Demo Video ${ci + 1}`,
          channelName: `Demo Channel ${ci + 1}`,
          viewGoal: 1000,
          durationSec: 600,
        });
      }
    }

    while (batch.length < 10) {
      const i = batch.length;
      batch.push({
        id: `mock-fill-${i}`,
        url: `https://youtube.com/watch?v=fill${i}`,
        title: `Sample Video ${i + 1}`,
        channelName: `Channel ${(i % 10) + 1}`,
        viewGoal: 1000,
        durationSec: 480 + i * 60,
      });
    }

    const sliced = batch.slice(0, 10).map(v => ({ ...v, viewGoal: 1000 }));
    setCampaignVideos(sliced);
    setDefaultPerVideoViews(1000);
    setCampaignGoals(g => ({ ...g, views: 10000, watchProfiles: profileList.length || 48 }));
  };

  const onSaveProfile = (profileId: string, settings: DemoProfileSettings) => {
    const next = { ...profileOverrides, [profileId]: settings };
    setProfileOverrides(next);
    persist(campaignGoals, campaignDefaults, campaignVideos, next);
    if (plan) {
      void (async () => {
        const regen = await generateCampaignDemoPlan({
          campaignGoals: plan.campaignGoals,
          campaignDefaults: plan.campaignDefaults,
          videos: campaignVideos,
          profiles: profileList,
          profileOverrides: next,
        });
        setPlan(regen);
        const updated = regen.slots.find(s => s.profileId === profileId);
        if (updated) setDetailSlot(updated);
      })();
    }
  };

  const startRealRunWithPlan = async (p: DemoCampaignPlan) => {
    setStartingExec(true);
    setExecError(null);
    const res = await startMastermindExecution(p, `Plan ${p.dayKey} · ${p.totalSlots} slots`);
    setStartingExec(false);
    if (!res.ok) {
      setExecError(res.error || 'Start failed');
      return;
    }
    const ex = await fetchMastermindExecutionStatus();
    setExecution(ex);
    setMainTab('plan');
  };

  const startRealRun = async () => {
    if (!plan) return;
    await startRealRunWithPlan(plan);
  };

  const stopRealRun = async () => {
    await stopMastermindExecution();
    const ex = await fetchMastermindExecutionStatus();
    setExecution(ex);
  };

  const execActive = Boolean(execution?.active);
  const execStats = execution?.stats;

  const renderSlotStatus = (slot: DemoPlanSlot) => {
    if (execActive || slot.execStatus) {
      if (slot.execStatus === 'skipped') return <span className="text-xs text-amber-500 font-bold">skip</span>;
      if (slot.execStatus === 'error') return <span className="text-xs text-red-400 font-bold">err</span>;
      if (slot.runtimeStatus === 'done') return <span className="text-xs text-emerald-500 font-bold">done</span>;
      if (slot.runtimeStatus === 'running') return <span className="text-xs text-blue-400 font-bold">LIVE</span>;
      return <span className="text-xs text-amber-500 font-bold">wait</span>;
    }
    const phase = slotPreviewPhase(slot);
    if (phase === 'past') return <span className="text-xs text-gray-500 font-bold">past</span>;
    if (phase === 'now') return <span className="text-xs text-purple-400 font-bold">now</span>;
    return <span className="text-xs text-gray-600 font-bold">later</span>;
  };

  const filteredSlots = useMemo(() => {
    if (!plan) return [];
    let list = plan.slots;
    if (selectedVideoId !== 'all') list = list.filter(s => s.videoId === selectedVideoId);
    if (filter === 'ready') list = list.filter(s => s.readiness.ready && !s.readiness.warnings.length);
    if (filter === 'warn') list = list.filter(s => !s.readiness.ready || s.readiness.warnings.length);
    if (filter === 'done') list = list.filter(s => s.runtimeStatus === 'done');
    if (filter === 'pending') list = list.filter(s => s.runtimeStatus !== 'done');
    return list;
  }, [plan, filter, selectedVideoId]);

  const byProfile = useMemo(() => {
    if (!plan) return [];
    return plan.profileSummaries.map(ps => {
      const actions = new Set<string>();
      plan.slots.filter(s => s.profileId === ps.profileId).forEach(s => s.actionsPlanned.forEach(a => actions.add(a)));
      return { ...ps, actions };
    });
  }, [plan]);

  return (
    <div className="w-full rounded-2xl border-2 border-amber-600/40 bg-gradient-to-b from-amber-950/20 to-gray-950 overflow-hidden">
      <div className="px-4 py-3 border-b border-amber-800/30 bg-amber-900/10 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Bot size={20} className="text-amber-400" />
          <div>
            <h2 className="text-white font-bold text-base">Mastermind — Smart Plan + Real Run</h2>
            <p className="text-[10px] text-amber-200/70">
              {execActive
                ? `LIVE — ${execStats?.done ?? 0}/${execStats?.total ?? 0} done · worker_manager profiles khol raha hai`
                : 'AI Goal → Plan + Start Real Run · backend pe slots execute honge'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-[10px] px-2 py-1 rounded-full border font-bold flex items-center gap-1 ${
            serverStatus === 'synced' ? 'border-emerald-700/50 bg-emerald-950/40 text-emerald-300'
              : serverStatus === 'online' ? 'border-blue-700/50 bg-blue-950/40 text-blue-300'
                : serverStatus === 'outdated' ? 'border-orange-700/50 bg-orange-950/40 text-orange-300'
                  : serverStatus === 'saving' ? 'border-amber-700/50 bg-amber-950/40 text-amber-300'
                    : 'border-red-800/50 bg-red-950/40 text-red-400'
          }`}>
            <Cloud size={10} />
            {serverStatus === 'synced' ? 'Server synced'
              : serverStatus === 'online' ? 'API online'
                : serverStatus === 'outdated' ? 'Restart backend'
                  : serverStatus === 'saving' ? 'Saving…'
                    : 'Backend offline'}
          </span>
          <span className={`text-[10px] px-2 py-1 rounded-full border font-bold ${
            execActive
              ? 'border-emerald-600/50 bg-emerald-950/40 text-emerald-300 animate-pulse'
              : 'border-amber-700/40 bg-amber-900/30 text-amber-300'
          }`}>
            {execActive ? '● LIVE RUN' : 'READY'}
          </span>
        </div>
      </div>

      <div className="flex gap-1 p-2 border-b border-gray-800 bg-gray-900/50 flex-wrap">
        {(['ai-planner', 'setup', 'plan', 'logs'] as const).map(t => (
          <button key={t} type="button" onClick={() => setMainTab(t)}
            className={`px-4 py-2 rounded-lg text-xs font-medium ${
              mainTab === t
                ? t === 'ai-planner' ? 'bg-violet-600/30 text-violet-100' : 'bg-amber-600/30 text-amber-100'
                : 'text-gray-500'
            }`}>
            {t === 'ai-planner' ? '⓪ AI Goal Planner' : t === 'setup' ? '① Setup & Videos' : t === 'plan' ? '② Day Plan' : '③ Logs & Live'}
          </button>
        ))}
        {plan && (
          <span className="text-[10px] text-gray-600 self-center ml-auto">
            Day: <strong className="text-amber-400">{plan.dayKey}</strong> · resets midnight
          </span>
        )}
      </div>

      <div className="p-4 md:p-6 space-y-5 w-full">
        {mainTab === 'ai-planner' && (
          <AIGoalPlannerPanel
            profiles={profiles}
            channels={channels}
            getVideos={getVideos}
            campaignGoals={campaignGoals}
            campaignDefaults={campaignDefaults}
            campaignVideos={campaignVideos}
            selectedProfileIds={selectedProfileIds}
            onApplyCampaign={applyAIPlannerCampaign}
            backendReady={serverStatus === 'synced' || serverStatus === 'online'}
          />
        )}

        {mainTab === 'setup' && (
          <>
            <MastermindSimpleGuide
              fromAI={fromAIPlanner}
              advancedOpen={setupAdvancedOpen}
              onToggleAdvanced={() => setSetupAdvancedOpen(o => !o)}
            />

            {!setupAdvancedOpen && (
              <ProfileSelectionPanel
                profiles={profiles}
                selectedIds={selectedProfileIds}
                onChange={ids => {
                  setSelectedProfileIds(ids);
                  selectedProfileIdsRef.current = ids;
                  persist(campaignGoals, campaignDefaults, campaignVideos, profileOverrides, ids);
                }}
              />
            )}

            {/* Videos panel — hamesha dikhega (user ne hide nahi manga tha) */}
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2 items-center">
                <button type="button" onClick={fillSampleVideos}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-gray-800 border border-gray-700 text-sm text-emerald-300 hover:bg-gray-750">
                  <Sparkles size={14} /> Demo: 10 videos × 1000 views
                </button>
                {fromAIPlanner && (
                  <span className="text-xs text-violet-400">AI se bhi videos aa sakti hain — yahan edit kar sakte ho</span>
                )}
              </div>
              <CampaignVideosPanel
                channels={channels}
                getVideos={getVideos}
                videos={campaignVideos}
                onChange={v => { setCampaignVideos(v); persist(campaignGoals, campaignDefaults, v, profileOverrides); }}
                defaultViewGoal={defaultPerVideoViews}
                onDefaultViewGoalChange={n => {
                  setDefaultPerVideoViews(n);
                  const g = { ...campaignGoals, views: n };
                  setCampaignGoals(g);
                  persist(g, campaignDefaults, campaignVideos, profileOverrides);
                }}
              />
            </div>

            <TrafficSyncPanel
              videos={campaignVideos}
              defaults={campaignDefaults}
              fromAI={fromAIPlanner}
              onSyncTraffic={d => { setCampaignDefaults(d); persist(campaignGoals, d, campaignVideos, profileOverrides); }}
              onVideosChange={v => { setCampaignVideos(v); persist(campaignGoals, campaignDefaults, v, profileOverrides); }}
            />

            <CapacityCalculator
              profileCount={profileList.length || 48}
              videos={campaignVideos}
              defaults={campaignDefaults}
            />

            {setupAdvancedOpen && (
            <>
            <CampaignGoalsHeader
              goals={campaignGoals}
              onChange={g => {
                setCampaignGoals(g);
                setDefaultPerVideoViews(g.views);
                persist(g, campaignDefaults, campaignVideos, profileOverrides);
              }}
              projection={plan?.actionProjection ?? null}
            />

            <CampaignDefaultsPanel
              defaults={campaignDefaults}
              onChange={d => { setCampaignDefaults(d); persist(campaignGoals, d, campaignVideos, profileOverrides); }}
              trafficProjection={plan?.trafficProjection ?? null}
            />

            <PlanWindowPanel
              defaults={campaignDefaults}
              onChange={d => { setCampaignDefaults(d); persist(campaignGoals, d, campaignVideos, profileOverrides); }}
            />

            <CommentTemplatePicker
              value={campaignDefaults.commentTemplateId}
              onChange={id => {
                const d = { ...campaignDefaults, commentTemplateId: id };
                setCampaignDefaults(d);
                persist(campaignGoals, d, campaignVideos, profileOverrides);
              }}
            />

            <div className="flex flex-wrap items-center gap-2 text-[10px] text-gray-600">
              <History size={11} />
              Watch history (demo): <strong className="text-amber-400">{watchHistoryCount}</strong> pairs aaj
              <button type="button"
                onClick={() => {
                  if (profileList[0] && campaignVideos[0]) {
                    seedDemoWatchHistory([{
                      profileId: profileList[0].id,
                      videoId: campaignVideos[0].id,
                      videoTitle: campaignVideos[0].title,
                    }]);
                    setWatchHistoryCount(getWatchHistory().length);
                  }
                }}
                className="px-2 py-0.5 rounded border border-gray-700 text-gray-400 hover:text-white">
                Demo: pehli video watched mark karo
              </button>
            </div>

            </>
            )}

            {!setupAdvancedOpen && (
              <div className="flex flex-wrap gap-3 p-4 rounded-xl border border-violet-700/40 bg-violet-950/20">
                <button type="button" onClick={() => setMainTab('ai-planner')}
                  className="px-5 py-3 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-sm font-bold">
                  ← AI Goal Planner (videos + plan)
                </button>
                <button type="button" onClick={runDemo} disabled={generating || noProfileSelected}
                  className="px-5 py-3 rounded-xl bg-amber-600 hover:bg-amber-500 text-white text-sm font-bold disabled:opacity-50">
                  {generating ? 'Generating…' : 'Generate Plan (advanced)'}
                </button>
              </div>
            )}

            {setupAdvancedOpen && (
            <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-gray-800">
              <button type="button" onClick={runDemo} disabled={generating || noProfileSelected}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-500 text-white text-sm font-bold disabled:opacity-50">
                {generating ? <RefreshCw size={14} className="animate-spin" /> : <Play size={14} />}
                Generate Smart Plan
              </button>
              <span className="text-[10px] text-gray-500 flex items-center gap-1">
                <Users size={11} /> {profileList.length || 48} profiles selected · {campaignDefaults.tabsPerProfile} tab(s)/profile
              </span>
              {noProfileSelected && (
                <span className="text-[10px] text-red-400 font-semibold">
                  ⚠ Profile Selection me kam se kam 1 profile chuno
                </span>
              )}
            </div>
            )}
          </>
        )}

        {mainTab === 'plan' && plan && (
          <>
            <CampaignGoalsHeader goals={plan.campaignGoals} onChange={() => {}} projection={plan.actionProjection} readOnly />

            <CampaignDefaultsPanel defaults={plan.campaignDefaults} onChange={() => {}} trafficProjection={plan.trafficProjection} readOnly />

            {plan.capacityImpossible && (
              <p className="text-xs text-red-400 bg-red-950/30 border border-red-800/50 rounded-xl px-3 py-2 font-semibold">
                Goal impossible — max ~{plan.capacityMaxViews.toLocaleString()} views possible in {plan.planWindowLabel}
              </p>
            )}

            <CapacityCalculator
              profileCount={plan.uniqueProfiles}
              videos={campaignVideos}
              defaults={plan.campaignDefaults}
              plannedSlots={plan.totalSlots}
            />

            <PlanExportBar
              plan={plan}
              serverSavedAt={serverSavedAt}
              onImportPlan={imported => {
                setPlan(imported);
                setMainTab('plan');
              }}
            />

            <PlanSchedulePanel
              plan={plan}
              backendReady={serverStatus === 'synced' || serverStatus === 'online'}
              onPlanChange={async next => {
                setPlan(next);
                await saveMastermindPlan(next, `Plan ${next.dayKey}`);
                setServerSavedAt(new Date().toISOString());
              }}
              onStartRealRun={p => void startRealRunWithPlan(p)}
            />

            <div className="flex flex-wrap items-center gap-3 p-4 rounded-xl border border-emerald-800/40 bg-emerald-950/20">
              {!execActive ? (
                <>
                  <button
                    type="button"
                    onClick={() => void startRealRun()}
                    disabled={startingExec || serverStatus === 'offline' || serverStatus === 'outdated'}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-bold shadow-lg shadow-emerald-900/30"
                  >
                    {startingExec ? <RefreshCw size={14} className="animate-spin" /> : <Play size={14} />}
                    ▶ Start Real Run
                  </button>
                  <p className="text-xs text-emerald-200/80 max-w-xl">
                    Backend har slot ke time pe profile kholega (worker_manager).
                    Jo time guzar chuka hai wo turant chalega. Pehle MoreLogin/Multilogin chalu rakho.
                  </p>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => void stopRealRun()}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl bg-red-700 hover:bg-red-600 text-white text-sm font-semibold"
                  >
                    <Square size={14} /> Stop Plan Run
                  </button>
                  <p className="text-xs text-emerald-300">
                    Chal raha hai: {execStats?.done ?? 0} done · {execStats?.spawned ?? 0} live · {execStats?.pending ?? 0} baaki
                    {(execStats?.skipped ?? 0) > 0 && ` · ${execStats?.skipped} skip (watched)`}
                  </p>
                </>
              )}
              {execError && <p className="text-xs text-red-400 w-full">{execError}</p>}
              {serverStatus === 'outdated' && (
                <p className="text-xs text-orange-300 w-full">
                  API online hai lekin purana backend chal raha hai. <strong>MMB Backend</strong> window band karo → <strong>START.bat</strong> dubara chalao → page refresh.
                </p>
              )}
            </div>

            {!execActive && (
              <p className="text-xs text-gray-500 bg-gray-900/50 border border-gray-800 rounded-lg px-3 py-2">
                AI Goal Planner se <strong className="text-emerald-400">Plan + Start Real Run</strong> ek click me chal sakta hai.
                Day Plan tab se bhi <strong className="text-emerald-400">Start Real Run</strong> dabao — dono same backend executor use karte hain.
              </p>
            )}

            <PlanActionLegend />

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-2">
              {[
                { label: 'Total slots', val: plan.totalSlots },
                { label: 'Max capacity', val: plan.capacityMaxViews },
                { label: 'Videos', val: plan.videos.length },
                { label: 'Profiles', val: plan.uniqueProfiles },
                { label: 'Done', val: execActive || (execStats?.done ?? 0) > 0 ? (execStats?.done ?? plan.slots.filter(s => s.execStatus === 'done').length) : '—' },
                { label: 'Live now', val: execActive ? (execStats?.spawned ?? 0) : '—' },
                { label: 'Waiting', val: execActive ? (execStats?.pending ?? 0) : plan.slots.filter(s => slotPreviewPhase(s) === 'upcoming').length },
              ].map(({ label, val }) => (
                <div key={label} className="bg-gray-900/80 border border-gray-800 rounded-xl p-3">
                  <p className="text-lg font-bold text-white">{val}</p>
                  <p className="text-[10px] text-gray-500">{label}</p>
                </div>
              ))}
            </div>

            <div className="bg-gray-900/50 border border-gray-800 rounded-xl p-3">
              <p className="text-[10px] text-gray-500 uppercase mb-2 font-semibold">Per-video breakdown</p>
              <div className="flex flex-wrap gap-1.5">
                <button type="button" onClick={() => setSelectedVideoId('all')}
                  className={`text-[10px] px-2 py-1 rounded border ${selectedVideoId === 'all' ? 'border-amber-500 text-amber-200' : 'border-gray-700 text-gray-500'}`}>
                  All
                </button>
                {plan.videos.map(v => (
                  <button key={v.videoId} type="button" onClick={() => setSelectedVideoId(v.videoId)}
                    className={`text-[10px] px-2 py-1 rounded border max-w-[180px] truncate ${selectedVideoId === v.videoId ? 'border-amber-500 text-amber-200' : 'border-gray-700 text-gray-500'}`}
                    title={`${v.title} — ${v.slotsPlanned}/${v.viewGoal} · ${v.durationLabel}`}>
                    <Film size={9} className="inline mr-0.5" />
                    {v.channelName}: {v.slotsPlanned}/{v.viewGoal} · {v.durationLabel}
                  </button>
                ))}
              </div>
            </div>

            {plan.campaignDefaults.hourlyTrafficCurve && (
              <p className="text-[10px] text-emerald-600/80 bg-emerald-950/20 border border-emerald-900/30 rounded-lg px-3 py-2">
                Hourly traffic curve ON — subah Search/Google zyada · shaam Notification zyada
              </p>
            )}

            <HourlySpreadChart
              title="Ghante-wise spread (sab videos)"
              accentClass="bg-amber-600"
              slots={plan.hourSummary.map(h => ({ hour: h.hour, views: h.count }))}
            />

            <p className="text-[10px] text-gray-500">Window: <strong className="text-amber-400">{plan.planWindowLabel}</strong></p>

            <div className="flex gap-1 flex-wrap items-center">
              {([
                ['timeline', 'Timeline', List],
                ['byVideo', 'By video', Film],
                ['byProfile', 'By profile', LayoutGrid],
                ['gantt', 'Gantt', GanttChart],
                ['hourly', 'Per hour', CalendarDays],
              ] as const).map(([id, label, Icon]) => (
                <button key={id} type="button" onClick={() => setPlanView(id)}
                  className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs border ${planView === id ? 'border-amber-500/50 bg-amber-900/20 text-amber-200' : 'border-gray-800 text-gray-500'}`}>
                  <Icon size={13} /> {label}
                </button>
              ))}
              {(['all', 'pending', 'done', 'ready', 'warn'] as const).map(f => (
                <button key={f} type="button" onClick={() => setFilter(f)}
                  className={`px-2.5 py-1.5 rounded-lg text-xs border ${filter === f ? 'border-gray-500 text-gray-300' : 'border-gray-800 text-gray-600'}`}>
                  {f}
                </button>
              ))}
              <span className="text-[10px] text-gray-600 ml-auto flex items-center gap-1">
                <MousePointerClick size={11} /> Click row → settings · <CalendarDays size={11} /> Day button → aaj ki list
              </span>
            </div>

            <div className="bg-gray-900/50 border border-gray-800 rounded-xl p-3">
              <p className="text-[10px] text-gray-500 uppercase mb-2 font-semibold">Traffic views planned</p>
              <div className="flex flex-wrap gap-2">
                {plan.trafficProjection.map(t => (
                  <span key={t.source} className="text-[10px] px-2 py-1 rounded border border-gray-700 text-gray-400">
                    {t.emoji} {t.label}: <strong className="text-amber-300">{t.viewsPlanned}</strong>/{t.viewGoal}
                    <span className="text-gray-600 ml-1">({t.profileMode})</span>
                  </span>
                ))}
              </div>
            </div>

            {planView === 'hourly' ? (
              <HourlyPlanBoard
                slots={plan.slots}
                hourSummary={plan.hourSummary}
                onSlotClick={setDetailSlot}
              />
            ) : planView === 'gantt' ? (
              <ProfileGanttChart slots={filteredSlots} planWindow={plan.campaignDefaults.planWindow} />
            ) : planView === 'byVideo' ? (
              <ByVideoPlanView
                videos={plan.videos}
                slots={plan.slots}
                selectedVideoId={byVideoId || plan.videos[0]?.videoId || ''}
                onSelectVideo={setByVideoId}
                onSlotClick={setDetailSlot}
              />
            ) : planView === 'byProfile' ? (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 max-h-[70vh] overflow-y-auto pr-1">
                {byProfile.map(row => {
                  const profSlots = plan.slots.filter(s => s.profileId === row.profileId);
                  return (
                    <div key={row.profileId} className="border border-gray-800 rounded-xl bg-gray-900/40 p-3 flex flex-col min-h-[200px]">
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <div>
                          <p className="text-white font-bold text-sm">{row.profileName}</p>
                          <p className="text-[9px] text-gray-600 font-mono">{row.profileId}</p>
                        </div>
                        <div className="flex gap-1 text-[9px]">
                          <span className="text-emerald-400">{row.doneCount}✓</span>
                          <span className="text-blue-400">{row.runningCount}●</span>
                          <span className="text-amber-400">{row.pendingCount}⏳</span>
                        </div>
                      </div>
                      {row.runningSlot && (
                        <p className="text-[10px] text-blue-400 mb-2 truncate">● LIVE: {row.runningSlot.videoTitle}</p>
                      )}
                      {row.nextSlot && (
                        <p className="text-[10px] text-amber-400/90 mb-2 truncate">Next {row.nextSlot.timeLabel}: {row.nextSlot.videoTitle}</p>
                      )}
                      <div className="flex-1 overflow-y-auto max-h-40 mb-2">
                        <ProfileDayTimeline slots={profSlots} highlightId={row.nextSlot?.id} compact />
                      </div>
                      <div className="flex gap-2 mt-auto pt-2 border-t border-gray-800">
                        <button type="button"
                          onClick={() => { const s = profSlots[0]; if (s) setDetailSlot(s); }}
                          className="flex-1 text-[10px] py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:text-white">
                          Detail
                        </button>
                        <button type="button"
                          onClick={() => setDayModalProfile({ id: row.profileId, name: row.profileName })}
                          className="flex-1 flex items-center justify-center gap-1 text-[10px] py-1.5 rounded-lg bg-emerald-900/30 border border-emerald-700/40 text-emerald-300 font-semibold">
                          <CalendarDays size={11} /> Full day
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="border border-gray-800 rounded-xl overflow-hidden max-h-[70vh] overflow-y-auto overflow-x-auto">
                <table className="w-full text-left text-sm min-w-[640px]">
                  <thead className="sticky top-0 bg-gray-900 z-10 text-gray-400 uppercase text-xs">
                    <tr>
                      <th className="p-3">Time · Profile · Traffic</th>
                      <th className="p-3 hidden md:table-cell">End</th>
                      <th className="p-3 hidden sm:table-cell">Video</th>
                      <th className="p-3 hidden lg:table-cell">Profile action</th>
                      <th className="p-3 w-20">Status</th>
                      <th className="p-3 w-12" />
                    </tr>
                  </thead>
                  <tbody>
                    {filteredSlots.slice(0, 250).map(slot => (
                      <tr key={slot.id}
                        onContextMenu={e => { e.preventDefault(); setDetailSlot(slot); }}
                        className="border-t border-gray-800/80 hover:bg-gray-800/40">
                        <td className="p-3 text-gray-200 cursor-pointer"
                          onClick={() => setDetailSlot(slot)}
                          title={slot.planRowLabel}>
                          <span className="text-amber-400 font-mono font-bold text-base">{slot.timeLabel}</span>
                          <span className="text-gray-500 mx-1">·</span>
                          <span className="font-medium">{slot.profileName}</span>
                          <span className="text-gray-500 mx-1">·</span>
                          <span className="text-emerald-400">{slot.trafficLabel}</span>
                        </td>
                        <td className="p-3 hidden md:table-cell font-mono text-gray-500 text-sm">
                          {slot.endTimeLabel}
                        </td>
                        <td className="p-3 hidden sm:table-cell text-gray-400 truncate max-w-[160px]">{slot.videoTitle}</td>
                        <td className="p-3 hidden lg:table-cell">
                          <ProfileActionBadge action={slot.profileAction} size="md" />
                        </td>
                        <td className="p-3">
                          {renderSlotStatus(slot)}
                        </td>
                        <td className="p-3">
                          <button type="button" title="Aaj ki schedule"
                            onClick={() => setDayModalProfile({ id: slot.profileId, name: slot.profileName })}
                            className="p-1.5 rounded text-emerald-500 hover:bg-emerald-900/30">
                            <CalendarDays size={16} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <button type="button" onClick={() => setMainTab('setup')} className="text-xs text-gray-500 hover:text-amber-400">
              ← Setup wapas jao (videos/goals badlo)
            </button>
          </>
        )}

        {mainTab === 'plan' && !plan && (
          <p className="text-center text-gray-500 text-sm py-8">Pehle Setup tab se plan generate karo</p>
        )}

        {mainTab === 'logs' && (
          <>
            <MastermindLogsPanel active={execActive} startedAt={execution?.startedAt} />
            {execStats && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                {[
                  { label: 'Done', val: execStats.done },
                  { label: 'Live', val: execStats.spawned },
                  { label: 'Errors', val: execStats.error },
                  { label: 'Retries', val: execStats.retries ?? 0 },
                ].map(({ label, val }) => (
                  <div key={label} className="bg-gray-900/80 border border-gray-800 rounded-lg p-3 text-center">
                    <p className="text-lg font-bold text-white">{val}</p>
                    <p className="text-[10px] text-gray-500">{label}</p>
                  </div>
                ))}
              </div>
            )}
            {!plan && (
              <p className="text-xs text-gray-600 text-center">Plan generate karke Real Run start karo — logs yahan aayenge</p>
            )}
          </>
        )}
      </div>

      <ProfileDetailDrawer
        slot={detailSlot}
        allSlots={plan?.slots ?? []}
        onClose={() => setDetailSlot(null)}
        onSave={onSaveProfile}
      />

      {dayModalProfile && plan && (
        <ProfileDayScheduleModal
          profileId={dayModalProfile.id}
          profileName={dayModalProfile.name}
          slots={plan.slots}
          onClose={() => setDayModalProfile(null)}
        />
      )}
    </div>
  );
}
