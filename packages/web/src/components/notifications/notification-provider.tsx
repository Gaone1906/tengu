"use client";

import { useState, useCallback, useEffect, useRef, type ReactNode } from "react";
import { createGatewaySocket } from "@/lib/ws";
import {
  type AppNotification,
  loadNotifications,
  saveNotifications,
  generateId,
  wsEventToNotification,
} from "@/lib/notifications";
import { NotificationContext } from "@/hooks/use-notifications";

const TOAST_DURATION_MS = 5_000;

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [toasts, setToasts] = useState<AppNotification[]>([]);
  const toastTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const initialized = useRef(false);

  // Load from localStorage on mount
  useEffect(() => {
    setNotifications(loadNotifications());
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
