import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Regression: Claude Code keeps hardcoded "circuit breaker" safety prompts that
// --dangerously-skip-permissions does NOT suppress (dangerous rm on a
// possibly-empty variable path, the `&` background operator, suspicious Windows
// paths). A gateway PTY has nobody at the keyboard, so the CLI sat on the dialog
// forever — and because PreToolUse fires BEFORE the prompt, the non-zero tool
// count also suppressed the missing-Stop backstop, so the turn never even failed.
// One session was found pinned at status:"running" for 9h26m this way.
//
// This exercises the whole path with a fake PTY: hook in → screen read back
// through the real headless-xterm snapshot → keystrokes out.

interface FakePty {
  pid: number;
  cols: number;
  rows: number;
  _exitCode: number | null;
  _writes: string[];
  _dataCb?: (d: string) => void;
  onData: (cb: (d: string) => void) => void;
  onExit: (cb: (e: { exitCode: number }) => void) => void;
  kill: () => void;
  write: (data: string) => void;
  resize: () => void;
  on: () => void;
}
const ptys: FakePty[] = [];

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    const p: FakePty = {
      pid: 4000 + ptys.length,
      cols: 160,
      rows: 45,
      _exitCode: null,
      _writes: [],
      onData(cb) { p._dataCb = cb; },
      onExit() {},
      kill() {},
      write(data) { p._writes.push(data); },
      resize() {},
      on() {},
    };
    ptys.push(p);
    return p;
  }),
}));
vi.mock("../sse-pty-proxy.js", () => ({
  MAIN_AGENT_SENTINEL: "<!-- jinn-main-agent:5c1f -->",
  SsePtyProxy: class {
    port = 0;
    constructor(_label: string, _onEvent: (e: unknown) => void) {}
    async start() { return 41100; }
    stop() {}
  },
}));

import {
  InteractiveClaudeEngine,
  isPermissionPromptNotification,
  recoveryBlockedByWork,
} from "../claude-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { cleanupSessionSettings } from "../../shared/claude-settings.js";
import { CLAUDE_SETTINGS_DIR } from "../../shared/paths.js";

const flush = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const SID = "test-permission-prompt";

/** The dialog as the CLI actually draws it (convertEol turns \n into CRLF for
 *  the headless terminal, so plain lines land on their own rows). */
const SAFETY_PROMPT_FRAME = [
  "",
  " Bash command",
  "",
  '   rm -rf "$W4/$d"',
  "",
  ' Dangerous rm operation on possibly-empty variable path: "$W4/$d"',
  "",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. No",
  "",
  " Esc to cancel · Tab to amend · ctrl+e to explain",
].join("\n");

const NOTIFICATION = {
  hook_event_name: "Notification",
  notification_type: "permission_prompt",
  message: "Claude needs your permission",
};

describe("isPermissionPromptNotification", () => {
  it("matches the permission_prompt notification", () => {
    expect(isPermissionPromptNotification(NOTIFICATION)).toBe(true);
  });

  it("ignores other notification types and other hooks", () => {
    expect(isPermissionPromptNotification({ hook_event_name: "Notification", notification_type: "idle" })).toBe(false);
    expect(isPermissionPromptNotification({ hook_event_name: "PreToolUse", tool_name: "Bash" })).toBe(false);
  });
});

describe("recoveryBlockedByWork", () => {
  it("holds off while a tool is genuinely running", () => {
    expect(recoveryBlockedByWork(1, false, false)).toBe(true);
  });

  it("holds off while an upstream request is in flight", () => {
    expect(recoveryBlockedByWork(0, false, true)).toBe(true);
  });

  it("does NOT hold off when the tool count is only high because a prompt is pending", () => {
    // The regression: this returned true forever, so the turn never settled.
    expect(recoveryBlockedByWork(1, true, false)).toBe(false);
  });

  it("still holds off if upstream is active even while blocked", () => {
    expect(recoveryBlockedByWork(1, true, true)).toBe(true);
  });

  it("does not hold off when nothing is in flight", () => {
    expect(recoveryBlockedByWork(0, false, false)).toBe(false);
  });
});

describe("InteractiveClaudeEngine — hardcoded safety prompts", () => {
  let lifecycle: PtyLifecycleManager;
  let hookCb: ((h: any) => void) | undefined;

  const makeEngine = (autoApproveSafetyPrompts?: boolean) => {
    const hookRegistry = {
      register: (_id: string, cb: (h: any) => void) => { hookCb = cb; },
      unregister: () => {},
    } as any;
    return new InteractiveClaudeEngine(lifecycle, hookRegistry, { autoApproveSafetyPrompts });
  };

  /** Drive a turn to the point where the CLI is sitting on the safety dialog. */
  const runToPrompt = async (engine: InteractiveClaudeEngine) => {
    const turn = engine.run({ sessionId: SID, prompt: "do the thing", cwd: "/tmp" } as any);
    await flush();
    hookCb!({ hook_event_name: "SessionStart", session_id: "c1" });
    hookCb!({ hook_event_name: "PreToolUse", tool_name: "Bash" });
    // The CLI draws the dialog, then reports it ~6s later via Notification.
    ptys[0]._dataCb?.(SAFETY_PROMPT_FRAME);
    await flush();
    const before = ptys[0]._writes.length;
    hookCb!(NOTIFICATION);
    return { turn, before };
  };

  beforeEach(() => {
    ptys.length = 0;
    hookCb = undefined;
    lifecycle = new PtyLifecycleManager({
      maxLivePtys: 10,
      onCleanup: (id) => cleanupSessionSettings(CLAUDE_SETTINGS_DIR, id),
    });
  });

  afterEach(() => {
    lifecycle.killAll();
    cleanupSessionSettings(CLAUDE_SETTINGS_DIR, SID);
  });

  it("reads the dialog off the terminal and submits the Yes option", async () => {
    const engine = makeEngine(true);
    const { turn, before } = await runToPrompt(engine);
    await flush(700);

    // "Yes" already carries the cursor, so a bare CR is the whole answer.
    expect(ptys[0]._writes.slice(before)).toEqual(["\r"]);

    hookCb!({ hook_event_name: "PostToolUse", tool_name: "Bash" });
    hookCb!({ hook_event_name: "Stop", last_assistant_message: "done" });
    await turn;
  });

  it("walks the cursor onto Yes when it starts elsewhere", async () => {
    const engine = makeEngine(true);
    const turn = engine.run({ sessionId: SID, prompt: "do the thing", cwd: "/tmp" } as any);
    await flush();
    hookCb!({ hook_event_name: "SessionStart", session_id: "c1" });
    hookCb!({ hook_event_name: "PreToolUse", tool_name: "Bash" });
    ptys[0]._dataCb?.([
      "",
      " Do you want to proceed?",
      " ❯ 1. No",
      "   2. Yes",
      "",
    ].join("\n"));
    await flush();
    const before = ptys[0]._writes.length;
    hookCb!(NOTIFICATION);
    await flush(700);

    expect(ptys[0]._writes.slice(before)).toEqual(["\x1b[B", "\r"]);

    hookCb!({ hook_event_name: "PostToolUse", tool_name: "Bash" });
    hookCb!({ hook_event_name: "Stop", last_assistant_message: "done" });
    await turn;
  });

  it("sends nothing when auto-approve is disabled", async () => {
    const engine = makeEngine(false);
    const { turn, before } = await runToPrompt(engine);
    await flush(700);

    expect(ptys[0]._writes.slice(before)).toEqual([]);

    hookCb!({ hook_event_name: "Stop", last_assistant_message: "done" });
    await turn;
  });

  it("sends nothing when no unambiguous approval option is on offer", async () => {
    const engine = makeEngine(true);
    const turn = engine.run({ sessionId: SID, prompt: "do the thing", cwd: "/tmp" } as any);
    await flush();
    hookCb!({ hook_event_name: "SessionStart", session_id: "c1" });
    hookCb!({ hook_event_name: "PreToolUse", tool_name: "Bash" });
    ptys[0]._dataCb?.([
      "",
      " Do you want to proceed?",
      " ❯ 1. No",
      "   2. Cancel",
      "",
    ].join("\n"));
    await flush();
    const before = ptys[0]._writes.length;
    hookCb!(NOTIFICATION);
    await flush(700);

    expect(ptys[0]._writes.slice(before)).toEqual([]);

    hookCb!({ hook_event_name: "Stop", last_assistant_message: "done" });
    await turn;
  });

  it("sends nothing when the screen holds no recognisable dialog", async () => {
    const engine = makeEngine(true);
    const turn = engine.run({ sessionId: SID, prompt: "do the thing", cwd: "/tmp" } as any);
    await flush();
    hookCb!({ hook_event_name: "SessionStart", session_id: "c1" });
    hookCb!({ hook_event_name: "PreToolUse", tool_name: "Bash" });
    ptys[0]._dataCb?.("⏺ Bash(ls -la)\n  ⎿  Waiting…\n");
    await flush();
    const before = ptys[0]._writes.length;
    hookCb!(NOTIFICATION);
    await flush(700);

    expect(ptys[0]._writes.slice(before)).toEqual([]);

    hookCb!({ hook_event_name: "Stop", last_assistant_message: "done" });
    await turn;
  });
});
