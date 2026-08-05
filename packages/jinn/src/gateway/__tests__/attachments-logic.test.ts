import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-attlogic-"));
process.env.JINN_HOME = tmp;

type Files = typeof import("../files.js");
type Reg = typeof import("../../sessions/registry.js");
type Paths = typeof import("../../shared/paths.js");

let files: Files;
let reg: Reg;
let paths: Paths;

beforeAll(async () => {
  paths = await import("../../shared/paths.js");
  reg = await import("../../sessions/registry.js");
  files = await import("../files.js");
  (await import("../../shared/db.js")).initDb();
});

/** Simulate a first-message upload that landed in FILES_DIR before a session existed. */
function seedFilesDirUpload(id: string, filename: string, bytes: Buffer): void {
  const dir = path.join(paths.FILES_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), bytes);
  reg.insertFile({ id, filename, size: bytes.length, mimetype: filename.endsWith(".zip") ? "application/zip" : "image/png", path: null });
}

describe("rehomeAttachmentsToSession", () => {
  it("moves FILES_DIR uploads into uploads/<date>/<sessionId>/ and records the new path", () => {
    seedFilesDirUpload("f1", "diagram.png", Buffer.from("PNG"));
    files.rehomeAttachmentsToSession(["f1"], "sess-new");

    const meta = reg.getFile("f1")!;
    expect(meta.path).toBeTruthy();
    expect(files.isServablePath(meta.path!)).toBe(true);
    expect(meta.path!.includes(path.join("uploads"))).toBe(true);
    expect(meta.path!.includes("sess-new")).toBe(true);
    expect(fs.existsSync(meta.path!)).toBe(true);
    // original FILES_DIR location is gone
    expect(fs.existsSync(path.join(paths.FILES_DIR, "f1", "diagram.png"))).toBe(false);
  });

  it("is a no-op for files already outside FILES_DIR (already session-scoped)", () => {
    // f1 was re-homed already — running again must not throw or move anything.
    const before = reg.getFile("f1")!.path;
    files.rehomeAttachmentsToSession(["f1"], "sess-new");
    expect(reg.getFile("f1")!.path).toBe(before);
  });
});

describe("fileIdsToMedia", () => {
  it("maps file IDs to media descriptors, deriving type from mimetype (incl. zip → file)", () => {
    seedFilesDirUpload("img", "shot.png", Buffer.from("PNG"));
    seedFilesDirUpload("zip", "bundle.zip", Buffer.from("PKzipdata"));

    const media = files.fileIdsToMedia(["img", "zip", "missing"]);
    expect(media).toHaveLength(2); // missing id skipped
    expect(media[0]).toMatchObject({ type: "image", url: "/api/files/img", name: "shot.png" });
    expect(media[1]).toMatchObject({ type: "file", url: "/api/files/zip", name: "bundle.zip", mimeType: "application/zip" });
  });

  it("maps video MIME types to video media descriptors", () => {
    reg.insertFile({ id: "vid", filename: "clip.mp4", size: 4, mimetype: "video/mp4", path: null });

    expect(files.fileIdsToMedia(["vid"])).toEqual([
      expect.objectContaining({ type: "video", url: "/api/files/vid", name: "clip.mp4", mimeType: "video/mp4" }),
    ]);
  });

  it("returns [] for non-array input", () => {
    expect(files.fileIdsToMedia(undefined)).toEqual([]);
    expect(files.fileIdsToMedia("nope")).toEqual([]);
  });
});
