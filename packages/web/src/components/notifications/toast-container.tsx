"use client";

import { useNotifications } from "@/hooks/use-notifications";
import { X, CheckCircle, AlertTriangle, Info, XCircle } from "lucide-react";
import type { NotificationType } from "@/lib/notifications";

const ICON_MAP: Record<NotificationType, typeof CheckCircle> = {
  success: CheckCircle,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
};

const COLOR_MAP: Record<NotificationType, string> = {
  success: "var(--system-green)",
  error: "var(--system-red)",
  warning: "var(--system-orange)",
  info: "var(--system-blue)",
};

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function ToastContainer() {
  const { toasts, dismissToast } = useNotifications();

  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: "fixed",
        top: 16,
        right: 16,
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        maxWidth: 380,
        width: "100%",
        pointerEvents: "none",
      }}
    >
      {toasts.map((toast) => {
        const Icon = ICON_MAP[toast.type];
        const color = COLOR_MAP[toast.type];
        return (
          <div
            key={toast.id}
            className="animate-slide-down"
            style={{
              pointerEvents: "auto",
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              padding: "12px 14px",
              background: "var(--material-thick)",
              backdropFilter: "blur(40px) saturate(180%)",
              WebkitBackdropFilter: "blur(40px) saturate(180%)",
              border: "1px solid var(--separator)",
              borderRadius: "var(--radius-md)",
              boxShadow: "var(--shadow-overlay)",
            }}
          >
            <Icon size={18} style={{ color, flexShrink: 0, marginTop: 1 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: "var(--text-primary)",
                  lineHeight: 1.3,
                }}
              >
                {toast.title}
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: "var(--text-secondary)",
                  marginTop: 2,
                  lineHeight: 1.3,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {toast.message}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-quaternary)",
                  marginTop: 4,
                }}
              >
                {formatTime(toast.timestamp)}
              </div>
            </div>
            <button
              onClick={() => dismissToast(toast.id)}
              aria-label="Dismiss"
              style={{
                background: "transparent",
                border: "none",
                cursor: "pointer",
                color: "var(--text-tertiary)",
                padding: 2,
                flexShrink: 0,
              }}
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
