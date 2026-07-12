import { render, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigationType } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getSession: (...args: unknown[]) => getSession(...args),
    },
  };
});

import { LegacyWorkflowSessionError } from "@/lib/api";
import { LegacyWorkflowSessionPreflight } from "../page";

let currentLocation = "";
let navigationType = "";

function RouterProbe() {
  const location = useLocation();
  currentLocation = `${location.pathname}${location.search}`;
  navigationType = useNavigationType();
  return null;
}

describe("historical Workflow Session chat redirect", () => {
  beforeEach(() => {
    getSession.mockReset().mockRejectedValue(new LegacyWorkflowSessionError(
      410,
      "Workflow runs are no longer sessions.",
      {
        workflowId: "release-review",
        runId: "run-old",
        openPath: "/workflow/release-review?mode=runs&run=run-old",
      },
    ));
  });

  it("replaces a direct chat location with the authoritative Workflow run", async () => {
    render(
      <MemoryRouter initialEntries={["/?session=legacy-session"]}>
        <RouterProbe />
        <LegacyWorkflowSessionPreflight sessionId="legacy-session" />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(currentLocation).toBe("/workflow/release-review?mode=runs&run=run-old");
    });
    expect(navigationType).toBe("REPLACE");
    expect(getSession).toHaveBeenCalledWith("legacy-session", expect.objectContaining({ messages: false }));
  });
});
