export type OS = 'Windows' | 'Android' | 'macOS' | 'Unknown';
export type ProfileStatus = 'running' | 'stopped' | 'starting' | 'error' | 'recreating';
export type ProxyLife = '1hr' | '2hr' | '4hr' | '8hr' | '24hr' | 'unknown';
export type JobStatus = 'pending' | 'running' | 'done' | 'failed';
export type TaskType = 'watch_video' | 'like_video' | 'subscribe' | 'comment' | 'search' | 'idle';

export interface ProxyConfig {
  server: string;
  port: number;
  username: string;
  password: string;
  state: string;
  city: string;
  life: ProxyLife;
  sessionId: string;
  assignedAt: number;
  expiresAt: number;
}

export interface Profile {
  id: string;
  name: string;
  os: OS;
  status: ProfileStatus;
  proxy: ProxyConfig;
  ip?: string;
  fingerprint: FingerprintConfig;
  currentAction: string;
  createdAt: number;
  selected: boolean;
  envId?: string;
  /**
   * Which antidetect browser this profile lives in. Set when fetched from the
   * provider list so the UI can route start/stop/delete to the right backend.
   * Optional for backward compat with legacy local-only profiles.
   */
  browserType?: 'morelogin' | 'multilogin';
}

export interface FingerprintConfig {
  userAgent: string;
  timezone: string;
  language: string;
  resolution: string;
  webGL: string;
  canvas: string;
  audioContext: string;
  cpu: number;
  ram: number;
  webRTC: string | 'disabled' | 'real' | 'forward';
  geolocation: { lat: number; lng: number };
  battery: number;
  deviceModel?: string;
  androidVersion?: string;
  macOsVersion?: string;

  // Extended fingerprint fields for full profile creation
  canvasNoise?: { enabled: boolean; seed: string };
  webGLNoise?: { enabled: boolean; seed: string };
  audioContextNoise?: { enabled: boolean; seed: string };
  fonts?: string[];
  mediaDevices?: { audioInputs: number; videoInputs: number; audioOutputs: number };
  clientRects?: boolean;
  speechVoices?: string[];
  webGLMeta?: { vendor: string; renderer: string };
  webGPU?: { vendor: string; adapter: string };
}

export interface Job {
  id: string;
  profileId: string;
  profileName: string;
  taskType: TaskType;
  status: JobStatus;
  retryCount: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  details?: string;
}

export type LogLevel = 'info' | 'warn' | 'error' | 'success';

export type LogSource =
  | 'profile'
  | 'worker'
  | 'scheduler'
  | 'shuffle'
  | 'backlink'
  | 'manual'
  | 'settings'
  | 'system'
  | 'yt-agent'
  | 'engagement';

export interface LogEntry {
  id: string;
  profileId?: string;
  profileName?: string;
  level: LogLevel;
  message: string;
  timestamp: number;
  source?: LogSource;
}

export interface SystemStats {
  totalProfiles: number;
  runningProfiles: number;
  totalJobs: number;
  pendingJobs: number;
  completedJobs: number;
  failedJobs: number;
  activeProxies: number;
}
