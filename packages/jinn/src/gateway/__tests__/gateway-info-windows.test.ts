import { describe, expect, it, vi } from "vitest";
import { windowsProcessIncarnation } from "../gateway-info.js";

describe("Windows process incarnation", () => {
  it("reads the exact process creation ticks through the system PowerShell", () => {
    const exec = vi.fn(() => "638900123456789012");

    expect(windowsProcessIncarnation(4242, exec as never, "D:\\Windows")).toBe(
      "windows-start-utc-ticks:638900123456789012",
    );
    expect(exec).toHaveBeenCalledWith(
      "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Console]::Out.Write([System.Diagnostics.Process]::GetProcessById(4242).StartTime.ToUniversalTime().Ticks)",
      ],
      expect.objectContaining({ windowsHide: true, timeout: 5_000 }),
    );
  });

  it("fails closed when PowerShell returns anything except decimal ticks", () => {
    expect(windowsProcessIncarnation(4242, (() => "warning 123") as never, "C:\\Windows")).toBeNull();
    expect(windowsProcessIncarnation(4242, (() => { throw new Error("denied"); }) as never, "C:\\Windows")).toBeNull();
  });
});
