/**
 * useVideoMonitor.ts
 * Background hook — polls YouTube RSS for monitored channels.
 * Fires in-app notifications when a NEW video is detected.
 *
 * Usage: call once at App level, pass { notifications, unreadCount, ... } down.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchChannelFromRSS } from '../services/youtubeApi';
import {
  getAllMonitoredChannelIds,
  getMonitorConfig,
  getLastKnownVideoId,
  setLastKnownVideoId,
  getNotifications,
  addNotification,
  dismissNotification,
  markEngagementStarted,
  clearAllNotifications,
  getUnreadCount,
  type NewVideoNotification,
} from '../utils/videoMonitorStore';

function nanoid8() {
  return Math.random().toString(36).slice(2, 10);
}

export interface UseVideoMonitorReturn {
  notifications: NewVideoNotification[];
  unreadCount: number;
  dismissNotif: (id: string) => void;
  markEngaged: (id: string) => void;
  clearAll: () => void;
  forceCheck: () => Promise<void>;
  lastChecked: number | null;
}

export function useVideoMonitor(): UseVideoMonitorReturn {
  const [notifications, setNotifications] = useState<NewVideoNotification[]>(() => getNotifications());
  const [unreadCount, setUnreadCount] = useState(() => getUnreadCount());
  const [lastChecked, setLastChecked] = useState<number | null>(null);
  const checkingRef = useRef(false);

  const refresh = useCallback(() => {
    const n = getNotifications();
    setNotifications(n);
    setUnreadCount(n.filter(x => !x.dismissed).length);
  }, []);

  /** Check all monitored channels for new videos */
  const checkAll = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    try {
      const channelIds = getAllMonitoredChannelIds();
      for (const channelId of channelIds) {
        try {
          const data = await fetchChannelFromRSS(channelId);
          if (!data.videos || data.videos.length === 0) continue;

          const latestVideo = data.videos[0]; // most-recent first
          const lastKnown = getLastKnownVideoId(channelId);

          if (!lastKnown) {
            // First time seeing this channel — just save the latest, don't notify
            setLastKnownVideoId(channelId, latestVideo.videoId);
            continue;
          }

          if (latestVideo.videoId !== lastKnown) {
            // 🆕 NEW VIDEO DETECTED
            const notif: NewVideoNotification = {
              id: nanoid8(),
              channelId,
              channelName: data.channelName,
              videoId: latestVideo.videoId,
              videoTitle: latestVideo.title,
              videoUrl: latestVideo.url,
              thumbnail: latestVideo.thumbnail,
              detectedAt: Date.now(),
              dismissed: false,
              engagementStarted: false,
            };
            addNotification(notif);
            setLastKnownVideoId(channelId, latestVideo.videoId);

            // Browser push notification (if permission granted)
            if (Notification.permission === 'granted') {
              new Notification(`🆕 New Video: ${data.channelName}`, {
                body: latestVideo.title,
                icon: latestVideo.thumbnail || '/icon.png',
                tag: latestVideo.videoId,
              });
            }

            // Auto-engage check — will be wired up in Part 3
            const config = getMonitorConfig(channelId);
            if (config.autoEngage) {
              // TODO Part 3: trigger engagement queue for this video
              console.log(`[VideoMonitor] Auto-engage triggered for ${latestVideo.videoId}`);
            }
          }
        } catch (err) {
          console.warn(`[VideoMonitor] Failed to check channel ${channelId}:`, err);
        }
      }
    } finally {
      checkingRef.current = false;
      setLastChecked(Date.now());
      refresh();
    }
  }, [refresh]);

  // Set up polling interval — re-runs whenever monitored channels change
  useEffect(() => {
    // Run immediately on mount
    void checkAll();

    // Re-check every 5 minutes (300 000 ms)
    const interval = setInterval(() => void checkAll(), 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [checkAll]);

  const dismissNotif = useCallback((id: string) => {
    dismissNotification(id);
    refresh();
  }, [refresh]);

  const markEngaged = useCallback((id: string) => {
    markEngagementStarted(id);
    refresh();
  }, [refresh]);

  const clearAll = useCallback(() => {
    clearAllNotifications();
    refresh();
  }, [refresh]);

  return {
    notifications,
    unreadCount,
    dismissNotif,
    markEngaged,
    clearAll,
    forceCheck: checkAll,
    lastChecked,
  };
}
