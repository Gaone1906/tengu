"use client";
import { useEffect, useState, useRef } from "react";
import { createGatewaySocket } from "@/lib/ws";

export function useGateway() {
  const [events, setEvents] = useState<Array<{ event: string; payload: unknown }>>([]);
  const [connected, setConnected] = useState(false);
  const [connectionSeq, setConnectionSeq] = useState(0);
  const [skillsVersion, setSkillsVersion] = useState(0);

  useEffect(() => {
    const socket = createGatewaySocket((event, payload) => {
      setEvents((prev) => [...prev.slice(-99), { event, payload }]);

      if (event === "skills:changed") {
        setSkillsVersion((prev) => prev + 1);
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

  return { events, connected, connectionSeq, skillsVersion };
}
