const workflowMutationTails = new Map<string, Promise<void>>();

/** Serialize every production trigger-store writer for one evidence root. */
export async function withWorkflowMutationLock<T>(root: string, mutate: () => Promise<T>): Promise<T> {
  const previous = workflowMutationTails.get(root) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  workflowMutationTails.set(root, tail);
  await previous;
  try {
    return await mutate();
  } finally {
    release();
    if (workflowMutationTails.get(root) === tail) workflowMutationTails.delete(root);
  }
}
