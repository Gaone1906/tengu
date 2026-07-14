import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-company-prefix-store-"));
process.env.JINN_HOME = home;
fs.writeFileSync(
  path.join(home, "config.yaml"),
  "engines:\n  default: claude\n  claude: {}\nportal:\n  companyName: IC-IDEV\n",
  "utf8",
);

type Store = typeof import("../store.js");
let store: Store;

beforeAll(async () => {
  store = await import("../store.js");
});

describe("Todo allocation from configured company name", () => {
  it("uses the configured company prefix for the first Todo", () => {
    expect(store.createWorkItem({ title: "company identity" }).id).toBe("ICI-1");
  });

  it("keeps the frozen prefix even if the configured company later becomes too short", () => {
    fs.writeFileSync(
      path.join(home, "config.yaml"),
      "engines:\n  default: claude\n  claude: {}\nportal:\n  companyName: AI\n",
      "utf8",
    );
    expect(store.createWorkItem({ title: "frozen identity" }).id).toBe("ICI-2");
  });
});
