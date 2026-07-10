interface ActivePollExecution {
  root: string;
  name: string;
  bindingRevision: string;
  controller: AbortController;
  settled: Promise<void>;
}

const activePollExecutions = new Set<ActivePollExecution>();

export function registerPollExecution(execution: ActivePollExecution): () => void {
  activePollExecutions.add(execution);
  return () => activePollExecutions.delete(execution);
}

export async function abortPollExecutions(
  root: string,
  name?: string,
  bindingRevision?: string,
): Promise<void> {
  const matches = [...activePollExecutions].filter((execution) =>
    execution.root === root
    && (name === undefined || execution.name === name)
    && (bindingRevision === undefined || execution.bindingRevision === bindingRevision));
  for (const execution of matches) execution.controller.abort();
  await Promise.allSettled(matches.map((execution) => execution.settled));
}
