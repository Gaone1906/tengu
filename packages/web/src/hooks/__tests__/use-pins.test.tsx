import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type PinsResponse } from "@/lib/api";
import { usePins, useTogglePin } from "../use-pins";

const LEGACY_KEY = "jinn-pinned-sessions";

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

function pin(key: string): PinsResponse["pins"][number] {
  return {
    key,
    kind: key.startsWith("emp:") ? "employee" : "session",
    pinnedAt: "2026-01-01T00:00:00.000Z",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("usePins", () => {
  it("uploads legacy local pins once as a union, removes the key, and does not upload on the next load", async () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify(["local-session", "shared-session"]));
    vi.spyOn(api, "getPins")
      .mockResolvedValueOnce({ pins: [pin("server-session"), pin("shared-session")] })
      .mockResolvedValueOnce({ pins: [pin("server-session"), pin("shared-session"), pin("local-session")] });
    const upload = vi.spyOn(api, "pinChat").mockResolvedValue({ status: "pinned" });

    const first = setup();
    const firstRender = renderHook(() => usePins(), { wrapper: first.wrapper });
    await waitFor(() => expect(firstRender.result.current.data).toEqual(
      new Set(["server-session", "shared-session", "local-session"]),
    ));
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledWith("local-session");
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    firstRender.unmount();

    const second = setup();
    const secondRender = renderHook(() => usePins(), { wrapper: second.wrapper });
    await waitFor(() => expect(secondRender.result.current.data).toEqual(
      new Set(["server-session", "shared-session", "local-session"]),
    ));
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("updates pin and unpin state immediately, then rolls a failed request back", async () => {
    vi.spyOn(api, "getPins").mockResolvedValue({ pins: [pin("session-a")] });
    const unpinRequest = deferred<{ status: string }>();
    const pinRequest = deferred<{ status: string }>();
    vi.spyOn(api, "unpinChat").mockReturnValue(unpinRequest.promise);
    vi.spyOn(api, "pinChat").mockReturnValue(pinRequest.promise);
    const { wrapper } = setup();
    const rendered = renderHook(() => ({ pins: usePins(), toggle: useTogglePin() }), { wrapper });
    await waitFor(() => expect(rendered.result.current.pins.data).toEqual(new Set(["session-a"])));

    act(() => rendered.result.current.toggle.mutate({ key: "session-a", pinned: false }));
    await waitFor(() => expect(rendered.result.current.pins.data).toEqual(new Set()));
    unpinRequest.resolve({ status: "unpinned" });
    await waitFor(() => expect(rendered.result.current.toggle.isPending).toBe(false));

    act(() => rendered.result.current.toggle.mutate({ key: "session-b", pinned: true }));
    await waitFor(() => expect(rendered.result.current.pins.data).toEqual(new Set(["session-b"])));
    pinRequest.reject(new Error("network failed"));
    await waitFor(() => expect(rendered.result.current.pins.data).toEqual(new Set()));
  });
});
