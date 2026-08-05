import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createGatewaySocket } from "@/lib/ws";
import type { GatewayEvent, GatewayEventListener, GatewayEventName } from "@jinn/gateway-events";

export interface GatewayContextValue {
  events: GatewayEvent[];
  connected: boolean;
  connectionSeq: number;
  skillsVersion: number;
  subscribe: (fn: GatewayEventListener) => () => void;
}

const GatewayContext = createContext<GatewayContextValue | null>(null);

/**
 * Events that still need to flow through the legacy `events` context array.
 *
 * Background: every consumer that destructures `events` re-renders on every
 * event we push. Most consumers have been migrated to subscribe(); the
 * remaining holdout is chat-pane.tsx, which forwards `events` to its
 * children QueuePanel (filters `queue:updated`) and ChatInput → useStt
 * (filters `stt:*`). We keep only those frames in the array so chat-pane
 * doesn't re-render for every ping/keepalive/log/session-delta on the bus.
 *
 * Subscribers are unaffected — they still receive every event via subscribe().
 */
const EVENTS_ARRAY_PREFIXES = ["stt:"] as const;
const EVENTS_ARRAY_EXACT = new Set<GatewayEventName>(["queue:updated"]);

function shouldPushToEventsArray(event: GatewayEventName): boolean {
  if (EVENTS_ARRAY_EXACT.has(event)) return true;
  for (const prefix of EVENTS_ARRAY_PREFIXES) {
    if (event.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Opens ONE WebSocket per app and exposes its events via context.
 * All consumers (useGateway, NotificationProvider, etc.) read from this
 * single connection — never open their own.
 */
export function GatewayProvider({ children }: { children: ReactNode }) {
  const [events, setEvents] = useState<GatewayEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [connectionSeq, setConnectionSeq] = useState(0);
  const [skillsVersion, setSkillsVersion] = useState(0);
  const listenersRef = useRef<Set<GatewayEventListener>>(new Set());

  useEffect(() => {
    const socket = createGatewaySocket(
      (frame) => {
        const { event } = frame;
        // Only mutate the shared events array for frames that one of the
        // remaining events-array consumers actually filters for. Everything
        // else is delivered exclusively through subscribe() below, which
        // avoids waking every <ChatPane> on the page for unrelated frames.
        if (shouldPushToEventsArray(event)) {
          setEvents((prev) => [...prev.slice(-99), frame]);
        }

        if (event === "skills:changed") {
          setSkillsVersion((prev) => prev + 1);
        }

        // Dispatch to synchronous subscribers (bypasses React 18 batching)
        for (const fn of listenersRef.current) {
          fn(frame);
        }
      },
      {
        onOpen: () => {
          setConnected(true);
          setConnectionSeq((prev) => prev + 1);
        },
        onClose: () => {
          setConnected(false);
        },
      },
    );

    // Resume listeners: a half-open socket can survive a tab backgrounding, a
    // network handoff, or an iOS bfcache restore in readyState=OPEN while being
    // functionally dead. On every "we're back" signal, reconnect immediately if
    // the socket isn't open (this clears any pending backoff and connects now).
    // The onOpen handler then bumps connectionSeq, which drives per-pane catch-up.
    const resume = () => {
      if (!socket.isOpen()) socket.reconnect();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") resume();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", resume);
    window.addEventListener("pageshow", resume); // iOS bfcache restore

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", resume);
      window.removeEventListener("pageshow", resume);
      socket.close();
    };
  }, []);

  const subscribe = useCallback((fn: GatewayEventListener) => {
    listenersRef.current.add(fn);
    return () => {
      listenersRef.current.delete(fn);
    };
  }, []);

  return (
    <GatewayContext.Provider
      value={{ events, connected, connectionSeq, skillsVersion, subscribe }}
    >
      {children}
    </GatewayContext.Provider>
  );
}

/**
 * Consumer hook. Returns the same shape callers already expect.
 * Does NOT open a WebSocket — that's GatewayProvider's job.
 */
export function useGateway(): GatewayContextValue {
  const ctx = useContext(GatewayContext);
  if (!ctx) {
    throw new Error(
      "useGateway must be used inside <GatewayProvider> (mounted in ClientProviders).",
    );
  }
  return ctx;
}
