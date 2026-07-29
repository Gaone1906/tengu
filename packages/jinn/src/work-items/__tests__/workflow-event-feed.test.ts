import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Throwaway registry (SESSIONS_DB resolves from JINN_HOME at module load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-event-feed-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Labels = typeof import("../labels.js");
type Transitions = typeof import("../transitions.js");
type Feed = typeof import("../workflow-event-feed.js");

let store: Store;
let labels: Labels;
let tr: Transitions;
let feed: Feed;

beforeAll(async () => {
  store = await import("../store.js");
  labels = await import("../labels.js");
  tr = await import("../transitions.js");
  feed = await import("../workflow-event-feed.js");
});

describe("workflow Todo event feed", () => {
  it("carries the Todo's labels by id and name alongside the immutable provenance snapshot", () => {
    const review = labels.createLabel({ name: "Needs Review" });
    const item = store.createWorkItem({ title: "labelled todo", status: "executing", department: "platform", assignee: "worker" });
    labels.setWorkItemLabels(item.id, [review.id], "operator");
    tr.transition(item.id, "in_review", "worker");

    const pending = feed.createWorkflowTodoEventFeed({ ownerId: "test-owner" }).listPendingEvents();
    const event = pending.find((candidate) => candidate.workItemId === item.id);

    expect(event).toMatchObject({
      toStatus: "in_review",
      item: { source: "human", department: "platform", assignee: "worker", labels: [{ id: review.id, name: "needs-review" }] },
    });
  });

  it("carries the actor that performed the transition, including for rows written before the filter existed", () => {
    const item = store.createWorkItem({ title: "actor todo", status: "executing" });
    tr.transition(item.id, "in_review", "operator");
    // The audit row this test reads was written by the unchanged transition path,
    // so it stands in for every pre-existing event: `actor` is a first-class
    // column, never part of the provenance snapshot the replay shape-checks.
    const pending = feed.createWorkflowTodoEventFeed({ ownerId: "test-owner" }).listPendingEvents();

    expect(pending.find((candidate) => candidate.workItemId === item.id)!.actor).toBe("operator");
  });

  it("reads an unlabelled Todo as an empty label set", () => {
    const item = store.createWorkItem({ title: "bare todo", status: "executing" });
    tr.transition(item.id, "in_review", "worker");

    const pending = feed.createWorkflowTodoEventFeed({ ownerId: "test-owner" }).listPendingEvents();

    expect(pending.find((candidate) => candidate.workItemId === item.id)!.item.labels).toEqual([]);
  });
});
