import type { WorkItem } from "../work-items/store.js";
import type {
  ActivityReceipt,
  ChatBlockEnvelope,
  CompanyChangedEvent,
} from "../shared/types.js";
import type { GatewayEmit } from "../shared/gateway-events.js";
import { blockFallbackText } from "../shared/blocks.js";

export interface ActivityOperation {
  id: string;
  toolName: string;
}

export interface ChatActivityContext {
  sessionExists: (sessionId: string) => boolean;
  hasBlock?: (sessionId: string, blockId: string) => boolean;
  nextActivityOrder?: (sessionId: string, blockId: string) => number;
  applyBlock: (sessionId: string, envelope: ChatBlockEnvelope, fallback: string) => unknown;
  emit: GatewayEmit;
  log?: (message: string) => void;
}

function todoBlockStatus(status: WorkItem["status"]) {
  if (status === "backlog" || status === "assigned") return "queued" as const;
  if (status === "executing") return "running" as const;
  if (status === "done") return "completed" as const;
  if (status === "cancelled") return "error" as const;
  return "waiting" as const;
}

export function todoActivityBlock(item: WorkItem, action: string): ChatBlockEnvelope {
  return {
    op: "put",
    block: {
      id: `todo:${item.id}`,
      type: "todo-activity",
      version: item.version,
      status: todoBlockStatus(item.status),
      title: item.title,
      summary: item.status.replace(/_/g, " "),
      payload: {
        todoId: item.id,
        action,
        status: item.status,
        assignee: item.assignee,
        approvalState: item.approvalState,
        parentId: item.parentId,
        rootId: item.rootId,
        depth: item.depth,
        updatedAt: item.updatedAt,
      },
    },
  };
}

function stampActivityReceipt(
  envelope: ChatBlockEnvelope,
  operation: ActivityOperation | undefined,
): ChatBlockEnvelope {
  if (!operation) return envelope;
  const activityReceipt: ActivityReceipt = {
    id: envelope.block.id,
    operationId: operation.id,
    toolName: operation.toolName,
  };
  return {
    ...envelope,
    block: {
      ...envelope.block,
      payload: { ...envelope.block.payload, activityReceipt },
    },
  };
}

function stampActivityOrder(envelope: ChatBlockEnvelope, activityOrder: number | undefined): ChatBlockEnvelope {
  if (activityOrder === undefined) return envelope;
  return {
    ...envelope,
    block: { ...envelope.block, activityOrder },
  };
}

/** One persistence/event boundary for all server-authored company mutations.
 * The domain record is already durable when this runs. A verified acting
 * Session gets one stable transcript block; every real mutation gets exactly
 * one company event after that persistence. */
export function persistAndEmitActivityBlock(options: {
  context: ChatActivityContext;
  sessionId?: string;
  operation?: ActivityOperation;
  envelope?: ChatBlockEnvelope;
  companyEvent?: CompanyChangedEvent;
  idempotentReplay?: boolean;
}): string | undefined {
  const { context, sessionId } = options;
  const sourceEnvelope = options.envelope;
  let activityReceiptId: string | undefined;
  if (sourceEnvelope && sessionId && options.operation && context.sessionExists(sessionId)) {
    if (options.idempotentReplay) {
      if (options.operation && context.hasBlock?.(sessionId, sourceEnvelope.block.id)) {
        activityReceiptId = sourceEnvelope.block.id;
      }
    } else {
      try {
        const envelope = stampActivityOrder(
          stampActivityReceipt(sourceEnvelope, options.operation),
          context.nextActivityOrder?.(sessionId, sourceEnvelope.block.id),
        );
        const fallback = blockFallbackText(envelope.block);
        context.applyBlock(sessionId, envelope, fallback);
        context.emit("session:delta", {
          sessionId,
          type: "block",
          content: fallback,
          block: envelope,
        });
        activityReceiptId = envelope.block.id;
      } catch (error) {
        context.log?.(`activity receipt persistence failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (options.companyEvent) context.emit("company:changed", options.companyEvent);
  return activityReceiptId;
}
