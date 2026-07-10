import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const xtermState = vi.hoisted(() => ({
  instances: [] as Array<{
    writes: string[];
    screen: string;
    resets: number;
    cols: number;
    rows: number;
  }>,
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    writes: string[] = [];
    screen = "";
    resets = 0;
    cols = 90;
    rows = 30;
    options: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      xtermState.instances.push(this);
    }
    loadAddon() {}
    open() {}
    write(data: string, callback?: () => void) {
      this.writes.push(data);
      this.screen += data;
      callback?.();
    }
    resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; }
    reset() { this.resets += 1; this.screen = ""; }
    scrollLines() {}
    dispose() {}
  },
}));

vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

import { CliTerminal } from "../cli-terminal";

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  binaryType = "";
  sent: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void { this.sent.push(data); }
  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1006, reason: "test" } as CloseEvent);
  }
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }
  control(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }
  binary(data: string): void {
    const bytes = new TextEncoder().encode(data);
    this.onmessage?.({ data: bytes.buffer } as MessageEvent);
  }
}

const live = () => FakeWebSocket.instances;
const terminal = () => xtermState.instances[0]!;

describe("CliTerminal recovery protocol", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    xtermState.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
      }),
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 900,
      height: 500,
      top: 0,
      left: 0,
      right: 900,
      bottom: 500,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps restoring visible for clear/cursor-only deltas and hides it only after snapshot + ready", () => {
    render(<CliTerminal sessionId="session-1" />);
    act(() => live()[0]!.open());
    expect(screen.getByText(/Restoring terminal/i)).toBeTruthy();

    act(() => live()[0]!.binary("\u001b[2J\u001b[H\u001b[?25l"));
    expect(screen.getByText(/Restoring terminal/i)).toBeTruthy();

    act(() => {
      live()[0]!.control({ type: "reset" });
      live()[0]!.control({
        type: "snapshot",
        snapshot: { data: "authoritative screen", cols: 90, rows: 30, visible: true },
      });
      live()[0]!.control({ type: "ready" });
    });
    expect(terminal().screen).toContain("authoritative screen");
    expect(screen.queryByText(/Restoring terminal/i)).toBeNull();
  });

  it("applies reconnect snapshots authoritatively without duplicating old content", () => {
    render(<CliTerminal sessionId="session-1" />);
    act(() => live()[0]!.open());
    act(() => {
      live()[0]!.control({ type: "reset" });
      live()[0]!.control({ type: "snapshot", snapshot: { data: "screen once", cols: 90, rows: 30, visible: true } });
      live()[0]!.control({ type: "ready" });
    });
    expect(terminal().screen).toBe("screen once");

    act(() => {
      live()[0]!.control({ type: "reset" });
      live()[0]!.control({ type: "snapshot", snapshot: { data: "screen once", cols: 90, rows: 30, visible: true } });
      live()[0]!.control({ type: "ready" });
    });
    expect(terminal().screen).toBe("screen once");
    expect(terminal().resets).toBe(2);
  });

  it("shows resume failures and exposes a working Restart terminal action", () => {
    render(<CliTerminal sessionId="session-1" />);
    act(() => live()[0]!.open());
    act(() => live()[0]!.control({ type: "error", message: "Terminal did not resume in time.", recoverable: true }));

    expect(screen.getByText("Terminal did not resume in time.")).toBeTruthy();
    const restart = screen.getByRole("button", { name: "Restart terminal" });
    fireEvent.click(restart);
    expect(JSON.parse(live()[0]!.sent.at(-1)!)).toEqual({ type: "restart" });
    expect(screen.getByText(/Restoring terminal/i)).toBeTruthy();
  });

  it("keeps an exited terminal visibly recoverable instead of showing a blank canvas", () => {
    render(<CliTerminal sessionId="session-1" />);
    act(() => live()[0]!.open());
    act(() => live()[0]!.control({ type: "exited", exitCode: 1, signal: 0 }));
    expect(screen.getByText(/Terminal exited with code 1/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restart terminal" })).toBeTruthy();
  });
});
