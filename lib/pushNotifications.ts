'use client';

/** Returns current permission state, or 'unsupported' if Notification API unavailable. */
export function getPermission(): NotificationPermission | 'unsupported' {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

/** Request permission. Returns the resulting permission state. */
export async function requestPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  const result = await Notification.requestPermission();
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('notif_permission', result);
  }
  return result;
}

/**
 * Show a browser notification using the native Notification API.
 * Silently does nothing if permission is not granted or API is unavailable.
 */
export function sendPush(title: string, body: string, url?: string) {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, {
      body,
      icon: '/favicon.ico',
    });
    if (url) {
      n.onclick = () => {
        window.focus();
        window.location.href = url;
      };
    }
  } catch {
    // Silently ignore — e.g. some browsers block Notification in certain contexts
  }
}
