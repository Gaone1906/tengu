// Notification types and localStorage persistence

export type NotificationType = "success" | "error" | "info" | "warning";

export interface AppNotification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  timestamp: number;
  read: boolean;
  icon?: string;
}

const STORAGE_KEY = "jinn-notifications";
const MAX_NOTIFICATIONS = 50;

export function loadNotifications(): AppNotification[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as AppNotification[];
    return parsed.slice(0, MAX_NOTIFICATIONS);
  } catch {
    return [];
  }
}

export function saveNotifications(notifications: AppNotification[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(notifications.slice(0, MAX_NOTIFICATIONS)),
    );
  } catch {
    // storage full or unavailable
  }
}

let counter = 0;
export function generateId(): string {
  return `n_${Date.now()}_${++counter}`;
}

/** Map a WebSocket event to a notification, or return null to skip */
export function wsEventToNotification(
  event: string,
  payload: Record<string, unknown>,
): Omit<AppNotification, "id" | "timestamp" | "read"> | null {
  switch (event) {
    case "session:completed": {
      const employee = (payload.employee as string) || "Session";
      const error = payload.error as string | null;
      if (error) {
        return {
          type: "error",
          title: `${employee} — Error`,
          message: error.slice(0, 120),
        };
      }
      return {
        type: "success",
        title: `${employee} — Done`,
        message: "Session completed successfully",
      };
    }
    case "cron:triggered": {
      const name = (payload.name as string) || (payload.jobId as string) || "Job";
      return {
        type: "info",
        title: "Cron Triggered",
        message: name,
      };
    }
    case "cron:reloaded":
      return {
        type: "info",
        title: "Cron Reloaded",
        message: "Scheduled jobs reloaded",
      };
    case "cron:completed": {
      const jobName = (payload.name as string) || (payload.job as string) || "Job";
      const cronError = payload.error as string | null;
      if (cronError) {
        return {
          type: "error",
          title: `Cron Failed: ${jobName}`,
          message: cronError.slice(0, 120),
        };
      }
      return {
        type: "success",
        title: `Cron Done: ${jobName}`,
        message: "Scheduled job completed successfully",
      };
    }
    case "slack:message": {
      const channel = (payload.channel as string) || "";
      const user = (payload.user as string) || (payload.userName as string) || "Someone";
      const text = (payload.text as string) || "";
      return {
        type: "info",
        title: `Slack${channel ? `: ${channel}` : ""}`,
        message: `${user}: ${text}`.slice(0, 120),
      };
    }
    case "session:started": {
      const sid = (payload.sessionId as string) || "";
      const emp = (payload.employee as string) || "";
      return {
        type: "info",
        title: "Session Started",
        message: emp ? `${emp} (${sid.slice(0, 8)})` : sid.slice(0, 8),
      };
    }
    default:
      return null;
  }
}

/** Events that warrant a browser push notification when tab is not focused */
const PUSH_EVENTS = new Set([
  "session:completed",
  "cron:completed",
  "cron:reloaded",
]);

export function shouldPushNotify(event: string): boolean {
  return PUSH_EVENTS.has(event);
}
