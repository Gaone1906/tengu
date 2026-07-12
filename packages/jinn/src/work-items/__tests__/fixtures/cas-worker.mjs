const request = JSON.parse(process.argv[2]);
process.env.JINN_HOME = request.home;

const store = await import("../../../../dist/src/work-items/store.js");
process.send?.("ready");

process.once("message", (message) => {
  if (message !== "go") return;
  try {
    const result = store.updateWorkItemConditional(request.id, { title: request.title }, {
      expectedVersion: request.expectedVersion,
      idempotencyKey: request.idempotencyKey,
      actor: "operator",
    });
    process.send?.({ ok: true, version: result?.item.version, replayed: result?.replayed });
  } catch (error) {
    process.send?.({
      ok: false,
      errorName: error instanceof Error ? error.name : "Error",
      currentVersion: error && typeof error === "object" && "currentVersion" in error ? error.currentVersion : undefined,
    });
  } finally {
    process.disconnect?.();
  }
});
