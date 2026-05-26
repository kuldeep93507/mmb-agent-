/**
 * gmailProfileStore.ts
 * Persists Gmail-profile tagging data in localStorage.
 * Key: mmb_gmail_profiles  →  { [profileId]: GmailProfileData }
 *
 * Used by ProfileCard (display / toggle) and later by the Engagement Engine
 * to know which profiles have Gmail accounts.
 */

const STORAGE_KEY = 'mmb_gmail_profiles';

export interface GmailProfileData {
  isGmail: boolean;
  email: string;
}

function loadAll(): Record<string, GmailProfileData> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, GmailProfileData>) : {};
  } catch {
    return {};
  }
}

function saveAll(data: Record<string, GmailProfileData>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch { /* ignore quota errors */ }
}

/** Load Gmail data for a single profile (defaults to not-a-gmail-profile). */
export function loadGmailData(profileId: string): GmailProfileData {
  const all = loadAll();
  return all[profileId] ?? { isGmail: false, email: '' };
}

/** Save Gmail data for a single profile. */
export function saveGmailData(profileId: string, data: GmailProfileData): void {
  const all = loadAll();
  all[profileId] = data;
  saveAll(all);
}

/** Return map of ALL gmail-tagged profiles. Used by Engagement Engine. */
export function getAllGmailProfiles(): Record<string, GmailProfileData> {
  return loadAll();
}

/** Return only the profile IDs that are tagged as Gmail profiles. */
export function getGmailProfileIds(): string[] {
  const all = loadAll();
  return Object.entries(all)
    .filter(([, d]) => d.isGmail)
    .map(([id]) => id);
}
