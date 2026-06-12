import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bot, Sparkles, Clock, Target, Users, Film, Layers,
  AlertTriangle, CheckCircle2, Wand2, Calendar, RefreshCw,
} from 'lucide-react';
import type { Profile } from '../../types';
import type { Channel, Video } from '../../store/useChannelStore';
import type {
  DemoCampaignDefaults,
  DemoCampaignGoals,
  DemoCampaignVideo,
  DemoProfileSettings,
} from '../../utils/mastermindDemoTypes';
import type { DemoCampaignPlan } from '../../utils/mastermindDemoPlan';
import { convertAIGoalToCampaignPlan } from '../../utils/aiGoalToCampaignPlan';
import {
  buildAIGoalPlan,
  applyAIGoalPlanToMastermind,
  defaultWindowFromNow,
  fmtClock,
  type AIGoalPlannerResult,
  type AIGoalVideoRef,
  type GoalWindowMode,
  type VideoRotationMode,
} from '../../utils/aiGoalPlanner';
import AIGoalSessionList from './AIGoalSessionList';
import HourlySpreadChart from './HourlySpreadChart';
import ChannelVideoPicker, { type PickableVideo } from '../shared/ChannelVideoPicker';
import AIGoalEngagementTrafficPanel, { buildDefaultSessionActions } from './AIGoalEngagementTrafficPanel';

interface Props {
  profiles: Profile[];
  channels: Channel[];
  getVideos: (channelId: number, filter?: string) => Video[];
  campaignGoals: DemoCampaignGoals;
  campaignDefaults: DemoCampaignDefaults;
  campaignVideos: DemoCampaignVideo[];
  selectedProfileIds: string[] | null;
  backendReady?: boolean;
  onApplyCampaign: (payload: {
    goals: DemoCampaignGoals;
    defaults: DemoCampaignDefaults;
    videos: DemoCampaignVideo[];
    campaignName: string;
    profileOverrides: Record<string, DemoProfileSettings>;
    autoGenerate: boolean;
    autoStartRun?: boolean;
    realPlan?: DemoCampaignPlan;
  }) => void;
}

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

export default function AIGoalPlannerPanel({
  profiles,
  channels,
  getVideos,
  campaignGoals,
  campaignDefaults,
  campaignVideos,
  selectedProfileIds,
  backendReady = true,
  onApplyCampaign,
}: Props) {
  const profileList = useMemo(() => {
    const all = profiles.map(p => ({ id: p.id, name: p.name || p.id.slice(0, 8) }));
    if (selectedProfileIds === null) return all;
    const sel = new Set(selectedProfileIds);
    return all.filter(p => sel.has(p.id));
  }, [profiles, selectedProfileIds]);

  const profileCount = profileList.length;

  const initWindow = defaultWindowFromNow('duration', 6);
  const [windowMode, setWindowMode] = useState<GoalWindowMode>('duration');
  const [windowStartAt, setWindowStartAt] = useState(initWindow.start);
  const [windowEndAt, setWindowEndAt] = useState(initWindow.end);
  const [durationHours, setDurationHours] = useState(6);
  const [viewGoal, setViewGoal] = useState(200);
  const [videoDurationMin, setVideoDurationMin] = useState(10);
  const [viewsPerTabPerHour, setViewsPerTabPerHour] = useState(3);
  const [tabsPerProfile, setTabsPerProfile] = useState<1 | 2 | 3>(1);
  const [pickedVideos, setPickedVideos] = useState<PickableVideo[]>([]);
  const [videoRotationMode, setVideoRotationMode] = useState<VideoRotationMode>('different');
  const [plan, setPlan] = useState<AIGoalPlannerResult | null>(null);
  const [generating, setGenerating] = useState(false);
  const [applying, setApplying] = useState(false);
  const [clockTick, setClockTick] = useState(0);
  const [plannerGoals, setPlannerGoals] = useState<DemoCampaignGoals>(() => ({ ...campaignGoals }));
  const [plannerDefaults, setPlannerDefaults] = useState<DemoCampaignDefaults>(() => ({ ...campaignDefaults }));
  const [sessionActions, setSessionActions] = useState<DemoProfileSettings>(() => buildDefaultSessionActions());

  useEffect(() => {
    const id = setInterval(() => setClockTick(t => t + 1), 30000);
    return () => clearInterval(id);
  }, []);

  const goalVideos: AIGoalVideoRef[] = useMemo(() => {
    return pickedVideos.map(p => {
      const dur = p.channelId && p.videoId
        ? (getVideos(p.channelId).find(v => v.video_id === p.videoId)?.duration || 0)
        : 0;
      return {
        id: p.videoId || p.url,
        url: p.url,
        title: p.title,
        channelName: p.channelName,
        channelId: p.channelId,
        durationSec: dur > 0 ? dur : videoDurationMin * 60,
      };
    });
  }, [pickedVideos, getVideos, videoDurationMin]);

  const channelCount = new Set(goalVideos.map(v => v.channelName)).size;
  const nowLabel = fmtClock(new Date());

  const syncWindowFromMode = useCallback((mode: GoalWindowMode, dur: number) => {
    const w = defaultWindowFromNow(mode, dur);
    setWindowStartAt(w.start);
    setWindowEndAt(w.end);
  }, []);

  const buildInput = useCallback(() => ({
    windowMode,
    windowStartAt,
    windowEndAt,
    durationHours,
    viewGoal,
    videoDurationSec: goalVideos.length
      ? Math.round(goalVideos.reduce((s, v) => s + v.durationSec, 0) / goalVideos.length)
      : videoDurationMin * 60,
    viewsPerTabPerHour,
    tabsPerProfile,
    profiles: profileList,
    videos: goalVideos,
    videoRotationMode,
    engagementGoals: { ...plannerGoals, views: viewGoal },
    trafficQuotas: plannerDefaults.trafficQuotas,
    defaultsPatch: {
      watchTimeMin: plannerDefaults.watchTimeMin,
      watchTimeMax: plannerDefaults.watchTimeMax,
      volumeMin: plannerDefaults.volumeMin,
      volumeMax: plannerDefaults.volumeMax,
      scrollEnabled: plannerDefaults.scrollEnabled,
      scrollNoClick: plannerDefaults.scrollNoClick,
      captionsEnabled: plannerDefaults.captionsEnabled,
    },
    sessionActions,
  }), [
    windowMode, windowStartAt, windowEndAt, durationHours, viewGoal,
    goalVideos, videoDurationMin, viewsPerTabPerHour, tabsPerProfile,
    profileList, videoRotationMode, plannerGoals, plannerDefaults, sessionActions,
  ]);

  const livePreview = useMemo(() => {
    if (!profileCount) return null;
    return buildAIGoalPlan(buildInput());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildInput, profileCount, clockTick]);

  const runPlanner = () => {
    if (!profileCount) return;
    setGenerating(true);
    setTimeout(() => {
      setPlan(buildAIGoalPlan(buildInput()));
      setGenerating(false);
    }, 300);
  };

  const resetToNow = () => {
    syncWindowFromMode(windowMode, durationHours);
    setPlan(null);
  };

  const applyCampaign = async (autoGenerate: boolean, autoStartRun = false) => {
    if (!plan) return;
    setApplying(true);
    try {
      const applied = applyAIGoalPlanToMastermind(plan, {
        goals: campaignGoals,
        defaults: campaignDefaults,
        videos: campaignVideos,
      });
      let realPlan: DemoCampaignPlan | undefined;
      if (autoGenerate || autoStartRun) {
        realPlan = await convertAIGoalToCampaignPlan(plan, {
          campaignGoals: applied.goals,
          campaignDefaults: applied.defaults,
          videos: applied.videos,
          profileOverrides: applied.profileOverrides,
        });
      }
      onApplyCampaign({
        ...applied,
        autoGenerate,
        autoStartRun,
        realPlan,
      });
    } finally {
      setApplying(false);
    }
  };

  const cap = livePreview?.capacity;

  return (
    <div className="rounded-2xl border-2 border-violet-600/40 bg-gradient-to-b from-violet-950/30 to-gray-950 overflow-hidden">
      <div className="px-4 py-3 border-b border-violet-800/30 bg-violet-900/15 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Wand2 size={20} className="text-violet-400" />
          <div>
            <h2 className="text-white font-bold text-base">AI Goal Planner</h2>
            <p className="text-[10px] text-violet-200/70">
              Current time se plan · har profile ki exact session list
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] px-2 py-1 rounded-full border border-amber-700/50 bg-amber-950/40 text-amber-300 font-mono font-bold">
            🕐 Abhi: {nowLabel}
          </span>
          <button type="button" onClick={resetToNow}
            className="text-[10px] px-2 py-1 rounded-full border border-gray-700 text-gray-400 hover:text-white flex items-center gap-1">
            <RefreshCw size={10} /> Reset to abhi
          </button>
        </div>
      </div>

      <div className="p-4 md:p-6 space-y-5">
        <section className="space-y-3">
          <p className="text-xs uppercase tracking-wide text-violet-300 font-semibold flex items-center gap-2">
            <Target size={14} /> ① Goal batao (time = current clock)
          </p>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-gray-900/60 border border-gray-800 rounded-xl p-4 space-y-3">
              <p className="text-[10px] text-gray-500 font-semibold flex items-center gap-1">
                <Clock size={12} className="text-violet-400" /> Time window — ab se
              </p>
              <div className="flex flex-wrap gap-2">
                {([
                  ['duration', 'Kitne ghante (ab se)'],
                  ['1h', 'Agla 1 ghanta'],
                  ['custom', 'Custom end time'],
                ] as const).map(([mode, label]) => (
                  <button key={mode} type="button"
                    onClick={() => {
                      setWindowMode(mode);
                      syncWindowFromMode(mode, durationHours);
                    }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold border ${
                      windowMode === mode
                        ? 'border-violet-500 bg-violet-900/30 text-violet-100'
                        : 'border-gray-700 text-gray-500'
                    }`}>
                    {label}
                  </button>
                ))}
              </div>

              <div className="bg-amber-950/20 border border-amber-800/30 rounded-lg px-3 py-2 text-xs">
                <span className="text-amber-400 font-semibold">Start (fixed): </span>
                <span className="text-white font-mono font-bold">{fmtClock(windowStartAt)}</span>
                <span className="text-gray-500 mx-2">→</span>
                <span className="text-amber-400 font-semibold">End: </span>
                <span className="text-white font-mono font-bold">{fmtClock(windowEndAt)}</span>
              </div>

              {windowMode === 'duration' && (
                <label className="flex items-center gap-3 text-sm text-gray-300">
                  Agle kitne ghante:
                  <input type="number" min={0.5} max={48} step={0.5} value={durationHours}
                    onChange={e => {
                      const d = Math.max(0.5, Number(e.target.value) || 6);
                      setDurationHours(d);
                      syncWindowFromMode('duration', d);
                    }}
                    className="w-24 bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-white font-mono text-center" />
                </label>
              )}

              {windowMode === 'custom' && (
                <label className="flex items-center gap-3 text-sm text-gray-300">
                  End time (aaj):
                  <input type="time" value={`${pad2(windowEndAt.getHours())}:${pad2(windowEndAt.getMinutes())}`}
                    onChange={e => {
                      const [h, m] = e.target.value.split(':').map(Number);
                      const end = new Date();
                      end.setHours(h, m, 0, 0);
                      if (end.getTime() <= windowStartAt.getTime()) {
                        end.setDate(end.getDate() + 1);
                      }
                      setWindowEndAt(end);
                    }}
                    className="bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-white" />
                </label>
              )}

              <label className="block">
                <span className="text-[10px] text-gray-500 mb-1 block">Is window me kitne views</span>
                <input type="number" min={1} value={viewGoal}
                  onChange={e => setViewGoal(Math.max(1, Number(e.target.value) || 1))}
                  className="w-full bg-gray-950 border border-violet-700/50 rounded-lg px-4 py-3 text-white text-2xl font-bold font-mono text-center" />
              </label>
            </div>

            <div className="bg-gray-900/60 border border-gray-800 rounded-xl p-4 space-y-3">
              <p className="text-[10px] text-gray-500 font-semibold flex items-center gap-1">
                <Users size={12} className="text-violet-400" /> Capacity rule
              </p>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-[10px] text-gray-500 mb-1 block">1 tab = views/ghanta</span>
                  <input type="number" min={1} max={10} value={viewsPerTabPerHour}
                    onChange={e => setViewsPerTabPerHour(Math.max(1, Number(e.target.value) || 3))}
                    className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-white font-mono text-center text-lg" />
                </label>
                <label className="block">
                  <span className="text-[10px] text-gray-500 mb-1 block">Tabs / profile</span>
                  <div className="flex gap-1">
                    {([1, 2, 3] as const).map(n => (
                      <button key={n} type="button" onClick={() => setTabsPerProfile(n)}
                        className={`flex-1 py-2 rounded-lg text-sm font-bold border ${
                          tabsPerProfile === n
                            ? 'border-violet-500 bg-violet-900/40 text-violet-100'
                            : 'border-gray-700 text-gray-500'
                        }`}>
                        {n}
                      </button>
                    ))}
                  </div>
                </label>
              </div>
              <div className="bg-violet-950/30 border border-violet-800/40 rounded-lg px-3 py-2 text-xs text-violet-200/90">
                <strong>1 profile</strong> × <strong>{tabsPerProfile} tab</strong> ={' '}
                <strong className="text-violet-300">{viewsPerTabPerHour * tabsPerProfile} views/ghanta</strong>
                <p className="text-[10px] text-gray-500 mt-1">1 tab→3 · 2 tabs→6 · 3 tabs→9 (default)</p>
              </div>
              <p className="text-xs text-gray-400 flex items-center gap-2">
                <Users size={12} />
                Profiles: <strong className="text-white">{profileCount || '—'}</strong>
                {!profileCount && <span className="text-red-400 text-[10px]">Setup tab → profile chuno</span>}
              </p>
              <label className="block">
                <span className="text-[10px] text-gray-500 mb-1 flex items-center gap-1">
                  <Film size={11} /> Video duration (min)
                </span>
                <input type="number" min={1} max={180} value={videoDurationMin}
                  onChange={e => setVideoDurationMin(Math.max(1, Number(e.target.value) || 10))}
                  className="w-20 bg-gray-950 border border-gray-700 rounded-lg px-2 py-2 text-white font-mono text-center" />
              </label>
            </div>
          </div>

          <div className="bg-gray-900/40 border border-gray-800 rounded-xl p-4 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[10px] text-gray-500 font-semibold flex items-center gap-1">
                <Film size={12} /> Videos — multi channel (3 tab = 3 videos)
              </p>
              <span className="text-[10px] text-gray-600">
                {goalVideos.length} video · {channelCount} channel
                {goalVideos.length > 0 && goalVideos.length < tabsPerProfile && (
                  <span className="text-amber-400 ml-1">⚠ {tabsPerProfile} tabs ke liye {tabsPerProfile} videos chahiye</span>
                )}
              </span>
            </div>

            <ChannelVideoPicker
              channels={channels}
              getVideos={getVideos}
              videos={pickedVideos}
              onChange={setPickedVideos}
            />

            <div className="border-t border-gray-800 pt-3 space-y-2">
              <p className="text-[10px] text-gray-500 font-semibold">Tab video order — har profile me kaunsi video kis tab pe</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => setVideoRotationMode('same')}
                  className={`px-4 py-2 rounded-lg text-xs font-bold border ${
                    videoRotationMode === 'same'
                      ? 'border-emerald-500 bg-emerald-900/30 text-emerald-100'
                      : 'border-gray-700 text-gray-500'
                  }`}>
                  ✓ Sab same order
                  <span className="block text-[9px] font-normal opacity-70">sab profiles: 1→2→3</span>
                </button>
                <button type="button" onClick={() => setVideoRotationMode('different')}
                  className={`px-4 py-2 rounded-lg text-xs font-bold border ${
                    videoRotationMode === 'different'
                      ? 'border-cyan-500 bg-cyan-900/30 text-cyan-100'
                      : 'border-gray-700 text-gray-500'
                  }`}>
                  ✓ Har profile alag
                  <span className="block text-[9px] font-normal opacity-70">A: 1,2,3 · B: 3,2,1</span>
                </button>
              </div>
            </div>

            {goalVideos.length > 0 && profileList.length > 0 && livePreview?.profileVideoOrders && (
              <div className="bg-gray-950/60 border border-gray-800 rounded-lg p-3 max-h-40 overflow-y-auto">
                <p className="text-[10px] text-violet-400 font-semibold mb-2">Preview — profile tab order</p>
                {livePreview.profileVideoOrders.slice(0, 6).map(po => (
                  <p key={po.profileId} className="text-[10px] text-gray-400 mb-1">
                    <strong className="text-white">{po.profileName}:</strong>{' '}
                    {po.tabOrderLabels.join(' · ')}
                  </p>
                ))}
                {livePreview.profileVideoOrders.length > 6 && (
                  <p className="text-[9px] text-gray-600">+{livePreview.profileVideoOrders.length - 6} aur profiles…</p>
                )}
              </div>
            )}
          </div>
        </section>

        <section className="space-y-3">
          <p className="text-xs uppercase tracking-wide text-emerald-300 font-semibold">
            ② Traffic sources + YouTube actions
          </p>
          <AIGoalEngagementTrafficPanel
            viewGoal={viewGoal}
            profileCount={profileCount}
            goals={plannerGoals}
            onGoalsChange={setPlannerGoals}
            defaults={plannerDefaults}
            onDefaultsChange={setPlannerDefaults}
            sessionActions={sessionActions}
            onSessionActionsChange={setSessionActions}
          />
        </section>

        {cap && profileCount > 0 && (
          <section className={`rounded-xl border p-4 ${
            cap.feasible ? 'bg-emerald-950/20 border-emerald-800/40' : 'bg-red-950/20 border-red-800/40'
          }`}>
            <p className="text-[10px] uppercase text-gray-500 font-semibold mb-2 flex items-center gap-1">
              <Layers size={12} /> Live capacity
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
              <Stat label="Start → End" value={`${cap.windowStartLabel}→${cap.windowEndLabel}`} sub={cap.windowLabel} />
              <Stat label="Fleet/ghanta" value={`${cap.fleetViewsPerHour}`} sub={`${profileCount} profiles`} />
              <Stat label="Max views" value={`~${cap.maxViewsPossible}`} sub={`~${Math.round(cap.sessionSecEstimate / 60)}m/session`} />
              <Stat label="Goal" value={`${viewGoal}`} sub={cap.feasible ? '✓ OK' : `−${cap.gap}`} />
            </div>
          </section>
        )}

        <button type="button" onClick={runPlanner} disabled={generating || !profileCount}
          className="flex items-center gap-2 px-6 py-3 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-bold">
          {generating ? <Sparkles size={16} className="animate-spin" /> : <Bot size={16} />}
          Plan Generate — session list dikhao
        </button>

        {plan && (
          <section className="space-y-4 border-t border-gray-800 pt-5">
            <p className="text-xs uppercase text-emerald-400 font-semibold flex items-center gap-2">
              <CheckCircle2 size={14} /> ③ Session timetable
            </p>

            {plan.profileVideoOrders.length > 0 && (
              <div className="bg-cyan-950/20 border border-cyan-800/40 rounded-xl p-4">
                <p className="text-[10px] text-cyan-400 font-semibold mb-2">
                  Profile video rotation ({plan.input.videoRotationMode === 'same' ? 'sab same' : 'har profile alag'})
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-36 overflow-y-auto">
                  {plan.profileVideoOrders.map(po => (
                    <div key={po.profileId} className="text-[10px] bg-gray-900/60 rounded-lg px-2 py-1.5 border border-gray-800">
                      <span className="text-white font-semibold">{po.profileName}</span>
                      <span className="text-gray-500 ml-1">→</span>
                      <span className="text-cyan-300 ml-1">{po.tabOrderLabels.join(' → ')}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <AIGoalSessionList plan={plan} />

            <div className="bg-gray-900/80 border border-gray-700 rounded-xl p-4">
              <p className="text-[10px] text-violet-400 font-semibold mb-2 flex items-center gap-1">
                <Bot size={12} /> Summary
              </p>
              <div className="text-sm text-gray-300 leading-relaxed whitespace-pre-line">
                {plan.narrativeHi.split('\n').map((line, i) => {
                  const html = line.replace(/\*\*(.*?)\*\*/g, '<b class="text-white">$1</b>');
                  return <p key={i} className="mb-1" dangerouslySetInnerHTML={{ __html: html || '&nbsp;' }} />;
                })}
              </div>
            </div>

            {plan.warnings.length > 0 && (
              <div className="bg-amber-950/30 border border-amber-800/50 rounded-xl p-3 space-y-1">
                {plan.warnings.map(w => (
                  <p key={w} className="text-xs text-amber-300 flex items-start gap-2">
                    <AlertTriangle size={13} className="shrink-0 mt-0.5" /> {w}
                  </p>
                ))}
              </div>
            )}

            <div className="space-y-2">
              <p className="text-[10px] text-gray-500 font-semibold flex items-center gap-1">
                <Calendar size={12} /> Campaign blocks
              </p>
              {plan.campaignSegments.map(seg => (
                <div key={seg.id} className="flex items-center gap-3 bg-gray-900/60 border border-gray-800 rounded-xl p-3">
                  <span className="w-8 h-8 rounded-lg bg-violet-900/40 flex items-center justify-center text-violet-300 font-bold">{seg.phase}</span>
                  <div className="flex-1">
                    <p className="text-white text-sm font-semibold">{seg.timeLabel}</p>
                    <p className="text-[10px] text-gray-500">{seg.rationale}</p>
                  </div>
                  <span className="text-xl font-bold text-violet-300">{seg.viewGoal}</span>
                </div>
              ))}
            </div>

            {plan.hourlySlots.length > 0 && (
              <HourlySpreadChart slots={plan.hourlySlots} title="Ghante-wise spread" />
            )}

            <div className="flex flex-wrap gap-3 p-4 rounded-xl border border-emerald-800/40 bg-emerald-950/20">
              <button type="button" onClick={() => void applyCampaign(false)} disabled={applying}
                className="px-5 py-2.5 rounded-xl bg-gray-800 hover:bg-gray-700 border border-gray-600 text-white text-sm font-semibold disabled:opacity-50">
                Campaign Setup me daalo
              </button>
              <button type="button" onClick={() => void applyCampaign(true)} disabled={applying}
                className="px-5 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-600 text-white text-sm font-bold disabled:opacity-50">
                {applying ? 'Saving…' : 'Smart Plan generate'}
              </button>
              <button
                type="button"
                onClick={() => void applyCampaign(true, true)}
                disabled={applying || !backendReady}
                className="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold shadow-lg shadow-emerald-900/40 disabled:opacity-50"
                title={!backendReady ? 'Backend chalu karo (START.bat)' : 'Plan save + Real Run start — profiles khulenge'}
              >
                {applying ? 'Starting…' : '▶ Plan + Start Real Run'}
              </button>
              {!backendReady && (
                <p className="text-xs text-amber-400 w-full">
                  Real Run ke liye backend online hona chahiye — START.bat chalao, MoreLogin/Multilogin ready rakho.
                </p>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="bg-gray-950/60 rounded-lg p-2 border border-gray-800">
      <p className="text-sm font-bold text-white truncate">{value}</p>
      <p className="text-[9px] text-gray-500">{label}</p>
      <p className="text-[8px] text-gray-600 truncate">{sub}</p>
    </div>
  );
}
