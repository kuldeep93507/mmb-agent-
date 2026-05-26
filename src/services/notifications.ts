/**
 * Browser Notification System
 * - Schedule complete notifications
 * - Error alerts
 * - Profile status changes
 */

let permissionGranted = false;

export async function requestNotificationPermission(): Promise<boolean> {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') {
    permissionGranted = true;
    return true;
  }
  if (Notification.permission === 'denied') return false;
  
  const result = await Notification.requestPermission();
  permissionGranted = result === 'granted';
  return permissionGranted;
}

export function sendNotification(title: string, body: string, options?: { icon?: string; tag?: string }) {
  if (!permissionGranted && Notification.permission !== 'granted') return;
  
  try {
    new Notification(title, {
      body,
      icon: options?.icon || '/favicon.ico',
      tag: options?.tag,
      badge: '/favicon.ico',
    });
  } catch {
    // Fallback for mobile/unsupported
    console.log(`[Notification] ${title}: ${body}`);
  }
}

// Pre-built notification helpers
export function notifyScheduleComplete(scheduleName: string) {
  sendNotification('✅ Schedule Complete', `"${scheduleName}" finished successfully!`, { tag: 'schedule' });
}

export function notifyScheduleError(scheduleName: string, error: string) {
  sendNotification('❌ Schedule Error', `"${scheduleName}" failed: ${error}`, { tag: 'error' });
}

export function notifyProfileStarted(profileName: string) {
  sendNotification('▶ Profile Started', `${profileName} is now running`, { tag: 'profile' });
}

export function notifyProfileError(profileName: string, error: string) {
  sendNotification('⚠️ Profile Error', `${profileName}: ${error}`, { tag: 'error' });
}

export function notifyUpdateAvailable(version: string) {
  sendNotification('🔄 Update Available', `Version ${version} is ready to install`, { tag: 'update' });
}
