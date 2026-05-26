import type { Profile } from "../types";

function loadCommentTemplates(): { id: string; text: string }[] {
  try {
    const d = localStorage.getItem("mmb_comments");
    const parsed = d ? JSON.parse(d) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Resolve comment template id → text so worker gets commentText when comment is ON. */
function enrichCommentText(cfg: Record<string, unknown>): Record<string, unknown> {
  if (!cfg.commentEnabled) return cfg;
  const existing = String(cfg.commentText || "").trim();
  if (existing) return cfg;
  const tid = String(cfg.commentTemplateId || "").trim();
  if (!tid) return cfg;
  const t = loadCommentTemplates().find((x) => x.id === tid);
  if (t?.text?.trim()) return { ...cfg, commentText: t.text.trim() };
  return cfg;
}

/**
 * Builds `schedule.profileConfigs` with watch/settings from localStorage,
 * plus `browserType` from the live Profile row (Multilogin vs MoreLogin).
 */
export function profileConfigsForSchedule(profileIds: string[], profiles: Profile[]): Record<string, unknown>[] {
  return profileIds.map((pid) => {
    const row = profiles.find((p) => p.id === pid);
    const cfg: Record<string, unknown> = { profileId: pid };
    try {
      const stored = localStorage.getItem(`mmb_profile_config_${pid}`);
      if (stored) Object.assign(cfg, JSON.parse(stored));
    } catch {
      /* ignore corrupt localStorage */
    }
    if (row?.browserType) cfg.browserType = row.browserType;
    return enrichCommentText(cfg);
  });
}
