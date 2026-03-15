"use client";

import { useState, useCallback, useEffect, useRef, type ReactNode } from "react";
import { createGatewaySocket } from "@/lib/ws";
import {
  type AppNotification,
  loadNotifications,
  saveNotifications,
  generateId,
  wsEventToNotification,
  shouldPushNotify,
} from "@/lib/notifications";
import {
  NotificationContext,
  schedulePermissionRequest,
} from "@/hooks/use-notifications";

const TOAST_DURATION_MS = 5_000;

function sendBrowserNotification(title: string, body: string) {
  if (typeof window === "undefined") return;
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  if (!document.hidden) return;
  new Notification(title, { body, icon: "/favicon.ico", tag: `jinn-${Date.now()}` });
}

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [toasts, setToasts] = useState<AppNotification[]>([]);
  const toastTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const initialized = useRef(false);

  // Load from localStorage on mount
  useEffect(() => {
    setNotifications(loadNotifications());
    schedulePermissionRequest();
  }, []);

  // Persist whenever notifications change (skip initial empty state)
  useEffect(() => {
    if (initialized.current) {
      saveNotifications(notifications);
    } else if (notifications.length > 0) {
      initialized.current = true;
    }
  }, [notifications]);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = toastTimers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      toastTimers.current.delete(id);
    }
  }, []);

  const addNotification = useCallback(
    (event: string, payload: Record<string, unknown>) => {
      const template = wsEventToNotification(event, payload);
      if (!template) return;

      const notif: AppNotification = {
        ...template,
        id: generateId(),
        timestamp: Date.now(),
        read: false,
      };

      // Add to persistent notifications
      setNotifications((prev) => [notif, ...prev].slice(0, 50));
      initialized.current = true;

      // Show toast
      setToasts((prev) => [...prev, notif]);
      const timer = setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== notif.id));
        toastTimers.current.delete(notif.id);
      }, TOAST_DURATION_MS);
      toastTimers.current.set(notif.id, timer);

      // Browser push
      if (shouldPushNotify(event)) {
        sendBrowserNotification(notif.title, notif.message);
      }
    },
    [],
  );

  // Subscribe to WebSocket events
  const addNotificationRef = useRef(addNotification);
  addNotificationRef.current = addNotification;

  useEffect(() => {
    const socket = createGatewaySocket((event, payload) => {
      addNotificationRef.current(event, payload as Record<string, unknown>);
    });
    return () => socket.close();
  }, []);

  const markAllRead = useCallback(() => {
    setNotifications((prev) => {
      const updated = prev.map((n) => (n.read ? n : { ...n, read: true }));
      saveNotifications(updated);
      return updated;
    });
  }, []);

  const markRead = useCallback((id: string) => {
    setNotifications((prev) => {
      const updated = prev.map((n) => (n.id === id ? { ...n, read: true } : n));
      saveNotifications(updated);
      return updated;
    });
  }, []);

  const clearAll = useCallback(() => {
    setNotifications([]);
    saveNotifications([]);
  }, []);

  const unreadCount = notifications.filter((n) => !n.read).length;

  return (
    <NotificationContext.Provider
      value={{
        notifications,
        unreadCount,
        toasts,
        pushFromEvent: addNotification,
        dismissToast,
        markAllRead,
        markRead,
        clearAll,
      }}
    >
      {children}
    </NotificationContext.Provider>
  );
}
