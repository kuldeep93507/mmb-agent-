/** Read-only profile config from localStorage (same keys as ProfileSettings). Demo + Mastermind use only. */

export interface StoredProfileConfig {
  watchTimeMin: number;
  watchTimeMax: number;
  trafficPreference: string;
  trafficMix?: Record<string, number>;
  likeEnabled: boolean;
  subscribeEnabled: boolean;
  commentEnabled: boolean;
  adSkipEnabled: boolean;
  videoQuality: string;
  startDelayMin: number;
  startDelayMax: number;
  hasSavedConfig: boolean;
}

const DEFAULTS: Omit<StoredProfileConfig, 'hasSavedConfig'> = {
  watchTimeMin: 70,
  watchTimeMax: 100,
  trafficPreference: 'custom',
  likeEnabled: false,
  subscribeEnabled: false,
  commentEnabled: false,
  adSkipEnabled: true,
  videoQuality: 'auto',
  startDelayMin: 5,
  startDelayMax: 20,
};

export function readProfileConfig(profileId: string): StoredProfileConfig {
  try {
    const raw = localStorage.getItem(`mmb_profile_config_${profileId}`);
    if (!raw) return { ...DEFAULTS, hasSavedConfig: false };
    const p = JSON.parse(raw) as Partial<StoredProfileConfig>;
    return {
      watchTimeMin: p.watchTimeMin ?? DEFAULTS.watchTimeMin,
      watchTimeMax: p.watchTimeMax ?? DEFAULTS.watchTimeMax,
      trafficPreference: p.trafficPreference ?? DEFAULTS.trafficPreference,
      trafficMix: p.trafficMix,
      likeEnabled: !!p.likeEnabled,
      subscribeEnabled: !!p.subscribeEnabled,
      commentEnabled: !!p.commentEnabled,
      adSkipEnabled: p.adSkipEnabled ?? DEFAULTS.adSkipEnabled,
      videoQuality: p.videoQuality ?? DEFAULTS.videoQuality,
      startDelayMin: p.startDelayMin ?? DEFAULTS.startDelayMin,
      startDelayMax: p.startDelayMax ?? DEFAULTS.startDelayMax,
      hasSavedConfig: true,
    };
  } catch {
    return { ...DEFAULTS, hasSavedConfig: false };
  }
}

export type ProfileReadinessField =
  | 'watch'
  | 'traffic'
  | 'like'
  | 'subscribe'
  | 'comment'
  | 'quality'
  | 'gap';

export interface ProfileReadiness {
  ready: boolean;
  missing: ProfileReadinessField[];
  warnings: string[];
}

/** Demo readiness — agent real build me same rules use karega; settings tum tool se set karte ho. */
export function assessProfileReadiness(cfg: StoredProfileConfig): ProfileReadiness {
  const missing: ProfileReadinessField[] = [];
  const warnings: string[] = [];

  if (!cfg.hasSavedConfig) {
    warnings.push('Profiles page se config save nahi — defaults use honge');
  }
  if (cfg.watchTimeMin < 50 || cfg.watchTimeMax < cfg.watchTimeMin) {
    missing.push('watch');
  }
  if (!cfg.trafficPreference || cfg.trafficPreference === 'random') {
    warnings.push('Traffic "random" — run time pe decide hoga (tumhari setting)');
  }

  const ready = missing.length === 0;
  return { ready, missing, warnings };
}
