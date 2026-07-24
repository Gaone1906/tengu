import type { WorkItem } from "./store.js";

/**
 * ICI-570 — live change signal for Todo writes that happen IN-PROCESS, outside
 * the HTTP routes (the cron mint and the session-lifecycle reconciler). Route
 * writes emit their own richer `company:changed` events at the persistence
 * boundary; this module gives the gateway one registration point so those
 * in-process lanes reach the web dashboard too. Null (the default, and the
 * state in tests/CLI runs without a server) makes every notify a no-op.
 */

export interface TodoLiveEvent {
  entity: "todo";
  action: string;
  id: string;
  version: number;
  value?: Record<string, unknown>;
}

type TodoLiveEmitter = (event: TodoLiveEvent) => void;

let emitter: TodoLiveEmitter | null = null;

export function setTodoLiveEmitter(next: TodoLiveEmitter | null): void {
  emitter = next;
}

export function notifyTodoChanged(item: WorkItem, action: string): void {
  if (!emitter) return;
  try {
    emitter({
      entity: "todo",
      action,
      id: item.id,
      version: item.version,
      value: item as unknown as Record<string, unknown>,
    });
  } catch {
    // A broken listener must never fail the write it observes.
  }
}
