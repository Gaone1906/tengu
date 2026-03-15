"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import {
  type AppNotification,
  loadNotifications,
  saveNotifications,
  generateId,
  wsEventToNotification,
  shouldPushNotify,
} from "@/lib/notifications";

// ---------------------------------------------------------------------------
// Browser push helper
// ---------------------------------------------------------------------------

function sendBrowserNotification(title: string, body: string) {
  if (typeof window === "undefined") return;
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  if (!document.hidden) return;
  new Notification(title, { body, icon: "/favicon.ico", tag: `jinn-${Date.now()}` });
}

// ---------------------------------------------------------------------------
// Permission prompt — delayed, tasteful
// ---------------------------------------------------------------------------

const PERMISSION_DELAY_MS = 10_000; // wait 10s after first visit
const PERM_KEY = "jinn-notif-prompted";

function schedulePermissionRequest() {
  if (typeof window === "undefined") return;
  if (!("Notification" in window)) return;
  if (Notification.permission !== "default") return;
  if (localStorage.getItem(PERM_KEY)) return;

  setTimeout(() => {
    if (Notification.permission === "default") {
      Notification.requestPermission();
      localStorage.setItem(PERM_KEY, "1");
    }
  }, PERMISSION_DELAY_MS);
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface NotificationContextValue {
  notifications: AppNotification[];
  unreadCount: number;
  toasts: AppNotification[];
  /** Push a new notification from a WS event */
  pushFromEvent: (event: string, payload: Record<string, unknown>) => void;
  /** Dismiss a toast */
  dismissToast: (id: string) => void;
  /** Mark all as read */
  markAllRead: () => void;
  /** Mark one as read */
  markRead: (id: string) => void;
  /** Clear all history */
  clearAll: () => void;
}

const NotificationContext = createContext<NotificationContextValue>({
  notifications: [],
  unreadCount: 0,
  toasts: [],
  pushFromEvent: () => {},
  dismissToast: () => {},
  markAllRead: () => {},
  markRead: () => {},
  clearAll: () => {},
});

export function useNotifications() {
  return useContext(NotificationContext);
}

// Re-export for use in provider component
export { NotificationContext, schedulePermissionRequest };

// Re-export types
export type { AppNotification };
