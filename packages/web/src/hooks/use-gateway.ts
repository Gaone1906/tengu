"use client";
import { useEffect, useState, useRef, useCallback } from "react";
import { createGatewaySocket } from "@/lib/ws";

type Listener = (event: string, payload: unknown) => void;

export function useGateway() {
  const [events, setEvents] = useState<Array<{ event: string; payload: unknown }>>([]);
  const [connected, setConnected] = useState(false);
  const [connectionSeq, setConnectionSeq] = useState(0);
  const [skillsVersion, setSkillsVersion] = useState(0);
  const listenersRef = useRef<Set<Listener>>(new Set());

  useEffect(() => {
    const socket = createGatewaySocket((event, payload) => {
      setEvents((prev) => [...prev.slice(-99), { event, payload }]);

      if (event === "skills:changed") {
        setSkillsVersion((prev) => prev + 1);
      }

      // Dispatch to synchronous subscribers (bypasses React 18 batching)
      for (const fn of listenersRef.current) {
        fn(event, payload);
      }
    }, {
      onOpen: () => {
        setConnected(true);
        setConnectionSeq((prev) => prev + 1);
      },
      onClose: () => {
        setConnected(false);
      },
    });
    return () => socket.close();
  }, []);

  const subscribe = useCallback((fn: Listener) => {
    listenersRef.current.add(fn);
    return () => { listenersRef.current.delete(fn); };
  }, []);

  return { events, connected, connectionSeq, skillsVersion, subscribe };
}
