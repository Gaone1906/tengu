import type {
  WorkflowAttemptCommand,
  WorkflowAttemptCompletion,
  WorkflowAttemptCompletionListener,
  WorkflowSessionExecutor as WorkflowSessionExecutorContract,
  Session,
} from "../shared/types.js";
import type { SessionManager } from "../sessions/manager.js";

export type WorkflowSessionReceiptReader =
  (sessionId: string) => { session: Session; finalText?: string } | null;

/** The sole adapter between the Workflow runtime and conversational execution. */
export class WorkflowSessionExecutor implements WorkflowSessionExecutorContract {
  constructor(
    private readonly sessions: SessionManager,
    private readonly readReceipt: WorkflowSessionReceiptReader = () => null,
  ) {}

  startAttempt(command: WorkflowAttemptCommand): Promise<{ sessionId: string }> {
    return this.sessions.runWorkflowAttempt(command);
  }

  stopAttempt(input: { sessionId: string; reason: string }): Promise<void> {
    return this.sessions.stopWorkflowAttempt(input);
  }

  subscribe(listener: WorkflowAttemptCompletionListener): () => void {
    return this.sessions.subscribeWorkflowAttemptCompletion(listener);
  }

  readTerminalCompletion(sessionId: string): WorkflowAttemptCompletion | null {
    const receipt = this.readReceipt(sessionId);
    const session = receipt?.session;
    const provenance = session?.workflowProvenance;
    if (!session?.attemptOutcome || provenance?.kind !== "phase" || !provenance.phase
      || session.attemptTerminalVersion !== 1) return null;
    return {
      sessionId,
      owner: { workflowId: provenance.workflowId, runId: provenance.runId, nodeId: provenance.phase.nodeId, attempt: provenance.phase.attempt },
      terminalVersion: 1,
      outcome: session.attemptOutcome,
      completedAt: session.lastActivity,
      ...(receipt?.finalText ? { finalText: receipt.finalText } : {}),
      ...(session.lastError ? { error: session.lastError } : {}),
    };
  }
}
