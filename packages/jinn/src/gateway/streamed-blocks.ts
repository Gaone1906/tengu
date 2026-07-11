export interface StreamedBlockForPersistence {
  id?: string;
  role?: string;
  content: string;
  toolCall?: string;
  media?: unknown[];
  blocks?: Array<{ type: string }>;
}

export function shouldPreserveStreamedBlocks(args: {
  quietPreempted: boolean;
  streamedBlocks: StreamedBlockForPersistence[];
}): boolean {
  return !args.quietPreempted && args.streamedBlocks.length > 0;
}

export function completedStreamedBlockIds(args: {
  quietPreempted: boolean;
  rateLimited: boolean;
  result: string | null | undefined;
  error: string | null | undefined;
  streamedBlocks: StreamedBlockForPersistence[];
}): Set<string> {
  const hasTerminalResponse = Boolean(args.result?.trim() || args.error?.trim());
  if (
    !hasTerminalResponse
    || args.rateLimited
    || !shouldPreserveStreamedBlocks(args)
  ) {
    return new Set();
  }

  const exactResult = args.result?.trim() ?? "";
  return new Set(args.streamedBlocks.flatMap((message) => {
    if (!message.id) return [];
    const durableBlock = message.blocks?.some((block) =>
      block.type === "delegation" || block.type === "dispatch",
    );
    const plainInterimProse =
      (message.role === undefined || message.role === "assistant")
      && !message.blocks?.length
      && Boolean(message.content.trim())
      && (!exactResult || message.content.trim() !== exactResult);
    const preserve =
      message.role === "user"
      || message.role === "notification"
      || Boolean(message.media?.length)
      || Boolean(message.toolCall)
      || durableBlock
      || plainInterimProse;
    return preserve ? [message.id] : [];
  }));
}
