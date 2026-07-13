import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/lib/conversations";
import { FileOpenContext } from "../file-open-context";
import { FileView } from "../file-view";
import { ChatMessages } from "../chat-messages";

vi.mock("@/routes/providers", () => ({
  useTheme: () => ({ theme: "light" }),
}));

vi.mock("@/components/markdown-view", () => ({
  MarkdownView: ({ content }: { content: string }) => <div>{content}</div>,
  SyntaxHighlighter: ({ children }: { children: string }) => <pre>{children}</pre>,
  oneDark: {},
  oneLight: {},
}));

const fetchMock = vi.fn<typeof fetch>();

function responseFor(request: string): Response {
  const rawPath = new URL(request, "http://gateway.test").searchParams.get("path") ?? "";
  const body = request.startsWith("/api/knowledge/read")
    ? {
        path: rawPath,
        title: "Knowledge file",
        content: "knowledge body",
        truncated: false,
        totalChars: 14,
      }
    : {
        path: rawPath,
        resolvedPath: `/managed/${rawPath}`,
        mime: "text/plain",
        size: 12,
        content: "managed body",
        binary: false,
        tooLarge: false,
      };
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) => responseFor(String(input)));
  vi.stubGlobal("fetch", fetchMock);
});

const supportedPaths = [
  ["knowledge/product-checklist.md", "/api/knowledge/read?path=knowledge%2Fproduct-checklist.md"],
  ["docs/company-doctrine.md", "/api/knowledge/read?path=docs%2Fcompany-doctrine.md"],
  ["files/reports/result.txt", "/api/files/read?path=files/reports/result.txt"],
  ["uploads/2026-07/report.txt", "/api/files/read?path=uploads/2026-07/report.txt"],
] as const;

function ChatFileHarness({ path }: { path: string }) {
  const [openedPath, setOpenedPath] = useState<string | null>(null);
  const messages: Message[] = [{
    id: `message-${path}`,
    role: "assistant",
    content: `Open \`${path}\``,
    timestamp: 1,
  }];

  return (
    <FileOpenContext.Provider value={setOpenedPath}>
      <ChatMessages messages={messages} loading={false} />
      {openedPath ? <FileView path={openedPath} embedded /> : null}
    </FileOpenContext.Provider>
  );
}

describe("FileView requests opened from chat", () => {
  it.each(supportedPaths)("routes %s to its scoped read endpoint", async (path, expectedUrl) => {
    render(<ChatFileHarness path={path} />);

    const link = screen.getByTitle(`Open ${path} in viewer`);
    expect(link.getAttribute("href")).toBe(`/file?path=${encodeURIComponent(path)}`);
    fireEvent.click(link);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expectedUrl));
  });

  it("preserves literal managed separators while encoding special path segments", async () => {
    const path = "files/nested dir/100% #? café 文档.txt";
    render(<FileView path={path} embedded />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/files/read?path=files/nested%20dir/100%25%20%23%3F%20caf%C3%A9%20%E6%96%87%E6%A1%A3.txt",
    ));
  });

  it.each([
    ["secrets/api-keys.json", /Unsupported file root/],
    ["../outside.txt", /traversal/],
    ["files/../outside.txt", /traversal/],
    ["files/%2e%2e/outside.txt", /encoded traversal/],
    ["files%2Foutside.txt", /encoded separator/],
    ["/etc/passwd", /relative/],
    ["C:\\Windows\\system.ini", /relative|forward slash/],
    ["files\\outside.txt", /forward slash/],
    ["files/has\0nul.txt", /control bytes/],
    ["files/has\u0001control.txt", /control bytes/],
  ] as const)("rejects unsafe viewer path %s before fetching", async (path, errorPattern) => {
    render(<FileView path={path} embedded />);

    expect(await screen.findByText(errorPattern)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders a knowledge response without managed-file-only metadata", async () => {
    render(<FileView path="knowledge/product-checklist.md" />);

    expect(await screen.findByText("knowledge body")).toBeTruthy();
    expect(screen.queryByText(/NaN B|undefined/)).toBeNull();
  });
});
