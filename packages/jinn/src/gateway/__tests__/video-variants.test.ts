import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalPath = process.env.PATH;
const roots: string[] = [];

function sourceFixture(): { source: string; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-video-variants-"));
  roots.push(root);
  const source = path.join(root, "source.mp4");
  fs.writeFileSync(source, Buffer.alloc(32 * 1024, 7));
  return { source, root };
}

function installFakeFfmpeg(root: string, mode: "success" | "fail" = "success"): string {
  const bin = path.join(root, "bin");
  const log = path.join(root, "ffmpeg.log");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, "ffmpeg"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$FAKE_FFMPEG_LOG"\nif [ "$1" = "-version" ]; then exit 0; fi\n${mode === "fail" ? "exit 1" : ""}\nfor arg in "$@"; do output="$arg"; done\nprintf 'variant' > "$output"\n`,
  );
  fs.chmodSync(path.join(bin, "ffmpeg"), 0o755);
  process.env.PATH = bin;
  process.env.FAKE_FFMPEG_LOG = log;
  return log;
}

async function loadVariants() {
  vi.resetModules();
  return import("../video-variants.js");
}

beforeEach(() => {
  process.env.PATH = originalPath;
  delete process.env.FAKE_FFMPEG_LOG;
});

afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.FAKE_FFMPEG_LOG;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("video variants", () => {
  it("deduplicates concurrent low-quality generation and returns the cached path", async () => {
    const { source, root } = sourceFixture();
    const log = installFakeFfmpeg(root);
    const variants = await loadVariants();

    expect(variants.ensureLowVariant(source, "same-video")).toBeNull();
    expect(variants.ensureLowVariant(source, "same-video")).toBeNull();

    await vi.waitFor(() => {
      expect(variants.ensureLowVariant(source, "same-video")).toMatch(/low\.mp4$/);
    });
    const invocations = fs.readFileSync(log, "utf8").trim().split("\n");
    expect(invocations).toHaveLength(2); // one availability probe, one transcode
  });

  it("memoises a failed transcode instead of retry-looping", async () => {
    const { source, root } = sourceFixture();
    const log = installFakeFfmpeg(root, "fail");
    const variants = await loadVariants();

    expect(variants.ensureLowVariant(source, "broken-video")).toBeNull();
    await vi.waitFor(() => expect(fs.readFileSync(log, "utf8").trim().split("\n")).toHaveLength(2));
    expect(variants.ensureLowVariant(source, "broken-video")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fs.readFileSync(log, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("falls back cleanly and logs once when ffmpeg is unavailable", async () => {
    const { source, root } = sourceFixture();
    process.env.PATH = path.join(root, "empty-bin");
    const logger = await import("../../shared/logger.js");
    const warn = vi.spyOn(logger.logger, "warn").mockImplementation(() => {});
    const variants = await import("../video-variants.js");

    expect(variants.ensureLowVariant(source, "no-ffmpeg")).toBeNull();
    await expect(variants.ensurePoster(source, "no-ffmpeg")).resolves.toBeNull();
    expect(variants.ensureLowVariant(source, "another-video")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/ffmpeg/i);
  });
});
