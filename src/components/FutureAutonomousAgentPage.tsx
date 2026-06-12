import { useState } from 'react';
import {
  Bot, Target, LineChart, FileText, Shield, Layers,
  ChevronRight, CheckCircle2, Circle, AlertTriangle,
} from 'lucide-react';
import { PageShell, PageHeader, Card, CardHeader, Badge, Btn, Grid } from './ui';
import type { Profile } from '../types';
import MastermindDemoPanel from './mastermind/MastermindDemoPanel';

interface FeatureCard {
  id: string;
  icon: React.ReactNode;
  title: string;
  titleHi: string;
  desc: string;
  loop: string[];
  phase: string;
}

const FEATURES: FeatureCard[] = [
  {
    id: 'agentic-loop',
    icon: <Bot size={18} />,
    title: 'Full Agentic Loop',
    titleHi: 'Poora agentic loop',
    desc: 'Goal do — AI khud plan banaye, profiles assign kare, schedule set kare, results dekhe, adjust kare. Tu sirf goal de, baaki AI manage kare.',
    loop: ['Goal parse', 'Plan banao', 'Profiles assign', 'Schedule create', 'Execute', 'Monitor', 'Adjust'],
    phase: 'Phase 3',
  },
  {
    id: 'campaign-strategist',
    icon: <Target size={18} />,
    title: 'AI Campaign Strategist',
    titleHi: 'Campaign strategist',
    desc: 'Kaunsa video kab boost karna, kis profile se, kaunse keywords trend mein — AI khud strategy banaye. Pehle suggest mode, baad mein auto.',
    loop: ['Channel scan', 'Analytics read', 'Trend keywords', 'Time slots', 'Profile match', 'Strategy output'],
    phase: 'Phase 2',
  },
  {
    id: 'daily-report',
    icon: <FileText size={18} />,
    title: 'Daily AI Report',
    titleHi: 'Roz ka AI report',
    desc: 'AI khud din ka analysis kare natural language mein: "aaj 5 channels, 54 sessions, ye 2 profiles slow the, kal ye karo."',
    loop: ['Analytics pull', 'Logs scan', 'Slow profiles', 'NL summary', 'Tomorrow plan'],
    phase: 'Phase 1',
  },
];

const PREREQUISITES = [
  { label: 'AI Model Switcher UI', level: 'L1.1', done: false },
  { label: 'Per-Profile Memory', level: 'L1.4', done: false },
  { label: 'AI Comment Quality', level: 'L1.3', done: false },
  { label: 'Self-Healing Selectors Page', level: 'L2.1', done: true },
  { label: 'Analytics + Scheduler stable', level: 'existing', done: true },
  { label: 'Engagement matrix stable', level: 'existing', done: true },
];

const BUILD_PHASES = [
  { phase: 'Phase 0', label: 'Research + placeholder page', status: 'done' as const },
  { phase: 'Phase 1', label: 'Daily AI Report (read-only, no auto-actions)', status: 'next' as const },
  { phase: 'Phase 2', label: 'Campaign Strategist — suggest → approve → apply', status: 'future' as const },
  { phase: 'Phase 3', label: 'Full agentic loop with kill switch + caps', status: 'future' as const },
];

const EXISTING_BLOCKS = [
  { name: 'orchestrator.py', role: '24h organic traffic weights, ViewSlot scheduling' },
  { name: 'agent_manager.py', role: 'Multi-profile run + recycle orchestration' },
  { name: 'ai_brain.py', role: 'Comments, keywords, watch patterns, vision verify' },
  { name: 'analytics_store.py', role: 'Per-profile stats, daily trends — report feed' },
  { name: 'Scheduler + Engagement', role: 'Execute layer — plans become real runs' },
];

import type { Channel, Video } from '../store/useChannelStore';

interface Props {
  profiles?: Profile[];
  channels?: Channel[];
  getVideos?: (channelId: number, filter?: string) => Video[];
}

export default function FutureAutonomousAgentPage({ profiles = [], channels = [], getVideos }: Props) {
  const [expandedFeature, setExpandedFeature] = useState<string | null>(null);
  const [goalDraft, setGoalDraft] = useState('');

  return (
    <PageShell>
      <div style={{ width: '100%', maxWidth: '100%', margin: 0, display: 'flex', flexDirection: 'column', gap: 20 }}>

        <PageHeader
          title="Future Autonomous Agent"
          subtitle="Level 3 — Goal do, AI khud manage kare · Research complete, build phased"
          actions={
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Badge color="green">Live · Real Run</Badge>
              <Badge color="yellow">AI Goal Planner</Badge>
            </div>
          }
        />

        {/* Mastermind — AI Goal + Real Run (worker_manager) */}
        <MastermindDemoPanel
          profiles={profiles}
          channels={channels}
          getVideos={getVideos ?? (() => [])}
        />

        {/* Status banner */}
        <Card style={{ border: '1px solid var(--mmb-border)', background: 'var(--mmb-surface2)' }}>
          <div style={{ padding: '14px 16px', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <AlertTriangle size={18} style={{ color: 'var(--mmb-amber)', flexShrink: 0, marginTop: 2 }} />
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--mmb-text)' }}>
                Mastermind Real Run — AI Goal se seedha profiles chalenge
              </div>
              <div className="text-xs text-gray-500 mt-1">
                <strong className="text-violet-400">⓪ AI Goal Planner</strong> → Plan Generate →{' '}
                <strong className="text-emerald-400">▶ Plan + Start Real Run</strong>.
                Wahi session timetable backend <code>mastermind_executor</code> pe chalti hai — MoreLogin/Multilogin ready rakho.
                Natural language autonomous loop abhi Phase 3.
              </div>
            </div>
          </div>
        </Card>

        {/* Goal input preview (disabled — real) */}
        <Card>
          <CardHeader
            title="🎯 Goal Input (preview — disabled)"
            action={<Badge color="gray">Phase 3</Badge>}
          />
          <div style={{ padding: 16 }}>
            <p style={{ fontSize: 12, color: 'var(--mmb-muted)', margin: '0 0 12px' }}>
              Future mein yahan natural language goal likhoge. Example:
            </p>
            <textarea
              value={goalDraft}
              onChange={e => setGoalDraft(e.target.value)}
              placeholder={'e.g. "Mere gaming channel ko 30 din mein 1000 real-feeling views — peak hours pe zyada, night mein kam"'}
              disabled
              rows={3}
              style={{
                width: '100%', resize: 'vertical', padding: '10px 12px', borderRadius: 8,
                border: '1px solid var(--mmb-border)', background: 'var(--mmb-surface2)',
                color: 'var(--mmb-muted)', fontSize: 13, fontFamily: 'inherit',
                opacity: 0.7, cursor: 'not-allowed',
              }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
              <Btn variant="primary" disabled icon={<Bot size={13} />}>
                Start Autonomous Agent
              </Btn>
              <span style={{ fontSize: 11, color: 'var(--mmb-muted)' }}>
                Disabled until Phase 3 — pehle Daily Report + Strategist
              </span>
            </div>
          </div>
        </Card>

        {/* Three feature cards */}
        <div>
          <h2 style={{ fontSize: 14, fontWeight: 700, color: 'var(--mmb-text)', margin: '0 0 12px' }}>
            Level 3 Capabilities
          </h2>
          <Grid cols={1} gap={12}>
            {FEATURES.map(f => {
              const open = expandedFeature === f.id;
              return (
                <Card key={f.id}>
                  <button
                    type="button"
                    onClick={() => setExpandedFeature(open ? null : f.id)}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', gap: 12,
                      padding: '14px 16px', border: 'none', background: 'transparent',
                      cursor: 'pointer', textAlign: 'left', color: 'var(--mmb-text)',
                    }}
                  >
                    <div style={{
                      width: 36, height: 36, borderRadius: 10, flexShrink: 0,
                      background: 'var(--mmb-accent-bg)', color: 'var(--mmb-accent)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      {f.icon}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 14, fontWeight: 700 }}>{f.title}</span>
                        <Badge color="red">{f.phase}</Badge>
                        <Badge color="yellow">Coming Soon</Badge>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--mmb-muted)', marginTop: 2 }}>{f.titleHi}</div>
                    </div>
                    <ChevronRight
                      size={16}
                      style={{
                        color: 'var(--mmb-muted)', flexShrink: 0,
                        transform: open ? 'rotate(90deg)' : 'none',
                        transition: 'transform .15s',
                      }}
                    />
                  </button>
                  {open && (
                    <div style={{ padding: '0 16px 16px', borderTop: '1px solid var(--mmb-border)' }}>
                      <p style={{ fontSize: 12, color: 'var(--mmb-text2)', margin: '12px 0', lineHeight: 1.6 }}>
                        {f.desc}
                      </p>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                        {f.loop.map((step, i) => (
                          <span key={step} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <span style={{
                              fontSize: 10, fontWeight: 600, padding: '3px 8px', borderRadius: 6,
                              background: 'var(--mmb-surface2)', color: 'var(--mmb-text2)',
                              border: '1px solid var(--mmb-border)',
                            }}>
                              {step}
                            </span>
                            {i < f.loop.length - 1 && (
                              <ChevronRight size={10} style={{ color: 'var(--mmb-muted)' }} />
                            )}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </Card>
              );
            })}
          </Grid>
        </div>

        <Grid cols={2} gap={16}>
          {/* Daily report preview */}
          <Card>
            <CardHeader title="📋 Daily Report Preview" action={<Badge color="blue">Phase 1 first</Badge>} />
            <div style={{ padding: 16 }}>
              <div style={{
                padding: 14, borderRadius: 10, background: 'var(--mmb-surface2)',
                border: '1px dashed var(--mmb-border)', fontSize: 12, lineHeight: 1.7,
                color: 'var(--mmb-text2)', fontStyle: 'italic',
              }}>
                "Aaj <strong style={{ fontStyle: 'normal' }}>5 channels</strong>,{' '}
                <strong style={{ fontStyle: 'normal' }}>54 sessions</strong> complete hue.
                Profile-12 aur Profile-19 slow the (proxy lag).
                Kal subah 9–11 Video X boost karo, sham 7pm peak pe Video Y.
                Error rate 2% — theek hai."
              </div>
              <Btn variant="ghost" disabled style={{ marginTop: 12 }} icon={<LineChart size={13} />}>
                Generate Today's Report
              </Btn>
            </div>
          </Card>

          {/* Safety rails */}
          <Card>
            <CardHeader title="🛡️ Safety Rails (mandatory)" />
            <div style={{ padding: '8px 16px 16px' }}>
              {[
                'Pehle suggest mode — approve ke baad hi run',
                'Kill switch jab agent active ho',
                'Max daily AI spend cap',
                'Comment submit hamesha verify (AI-only never)',
                'Error threshold pe auto-pause',
                'Locked YouTube actions untouched',
              ].map(rule => (
                <div key={rule} style={{
                  display: 'flex', gap: 8, alignItems: 'flex-start',
                  padding: '6px 0', fontSize: 12, color: 'var(--mmb-text2)',
                }}>
                  <Shield size={13} style={{ color: 'var(--mmb-green)', flexShrink: 0, marginTop: 1 }} />
                  {rule}
                </div>
              ))}
            </div>
          </Card>
        </Grid>

        {/* Prerequisites + build phases */}
        <Grid cols={2} gap={16}>
          <Card>
            <CardHeader title="✅ Prerequisites" action={<Layers size={14} style={{ color: 'var(--mmb-muted)' }} />} />
            <div style={{ padding: '8px 16px 16px' }}>
              {PREREQUISITES.map(p => (
                <div key={p.label} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '7px 0', borderBottom: '1px solid var(--mmb-border)',
                  fontSize: 12,
                }}>
                  {p.done
                    ? <CheckCircle2 size={14} style={{ color: 'var(--mmb-green)', flexShrink: 0 }} />
                    : <Circle size={14} style={{ color: 'var(--mmb-muted)', flexShrink: 0 }} />
                  }
                  <span style={{ flex: 1, color: p.done ? 'var(--mmb-text)' : 'var(--mmb-muted)' }}>
                    {p.label}
                  </span>
                  <Badge color={p.done ? 'green' : 'gray'}>{p.level}</Badge>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader title="🗓️ Build Phases" />
            <div style={{ padding: '8px 16px 16px' }}>
              {BUILD_PHASES.map(p => (
                <div key={p.phase} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 0', borderBottom: '1px solid var(--mmb-border)',
                  fontSize: 12,
                }}>
                  <Badge color={p.status === 'done' ? 'green' : p.status === 'next' ? 'blue' : 'gray'}>
                    {p.phase}
                  </Badge>
                  <span style={{ color: 'var(--mmb-text2)', flex: 1 }}>{p.label}</span>
                  {p.status === 'done' && <CheckCircle2 size={14} style={{ color: 'var(--mmb-green)' }} />}
                  {p.status === 'next' && <span style={{ fontSize: 10, color: 'var(--mmb-blue)', fontWeight: 700 }}>NEXT</span>}
                </div>
              ))}
            </div>
          </Card>
        </Grid>

        {/* Existing building blocks */}
        <Card>
          <CardHeader title="🧱 Existing Code (reuse — no rewrite)" />
          <div style={{ padding: '8px 16px 16px' }}>
            {EXISTING_BLOCKS.map(b => (
              <div key={b.name} style={{
                display: 'flex', gap: 12, padding: '8px 0',
                borderBottom: '1px solid var(--mmb-border)', fontSize: 12,
              }}>
                <code style={{
                  flexShrink: 0, fontSize: 11, fontWeight: 600,
                  color: 'var(--mmb-accent)', background: 'var(--mmb-accent-bg)',
                  padding: '2px 8px', borderRadius: 6,
                }}>
                  {b.name}
                </code>
                <span style={{ color: 'var(--mmb-muted)' }}>{b.role}</span>
              </div>
            ))}
            <p style={{ fontSize: 11, color: 'var(--mmb-muted)', margin: '12px 0 0', lineHeight: 1.5 }}>
              Naya <code>autonomous_agent.py</code> module existing APIs call karega —
              agent_manager watch loop ya locked actions ko touch nahi karega.
            </p>
          </div>
        </Card>

      </div>
    </PageShell>
  );
}
