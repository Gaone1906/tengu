import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-company-prefix-store-"));
process.env.JINN_HOME = home;
fs.writeFileSync(
  path.join(home, "config.yaml"),
  "engines:\n  default: claude\n  claude: {}\nportal:\n  companyName: IC-IDEV\n  companyPrefix: JNN\n",
  "utf8",
);

type Store = typeof import("../store.js");
let store: Store;

beforeAll(async () => {
  store = await import("../store.js");
});

describe("Todo allocation from configured company name", () => {
  it("uses the configured override for the first Todo", () => {
    expect(store.createWorkItem({ title: "company identity" }).id).toBe("JNN-1");
  });

  it("mints under a newly configured prefix while preserving the prior namespace's sequence", () => {
    fs.writeFileSync(
      path.join(home, "config.yaml"),
      "engines:\n  default: claude\n  claude: {}\nportal:\n  companyName: AI\n  companyPrefix: ACM\n",
      "utf8",
    );
    // v2 allocator is per-prefix: a reconfigured company prefix opens its own
    // namespace instead of being refused by a frozen singleton.
    expect(store.createWorkItem({ title: "new namespace" }).id).toBe("ACM-1");
    fs.writeFileSync(
      path.join(home, "config.yaml"),
      "engines:\n  default: claude\n  claude: {}\nportal:\n  companyName: IC-IDEV\n  companyPrefix: JNN\n",
      "utf8",
    );
    expect(store.createWorkItem({ title: "continued identity" }).id).toBe("JNN-2");
  });
});
