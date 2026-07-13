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

const specialChatPaths = [
  ["files/nested dir/report.txt", "/api/files/read?path=files/nested%20dir/report.txt"],
  ["files/100%.txt", "/api/files/read?path=files/100%25.txt"],
  ["files/topic#1.txt", "/api/files/read?path=files/topic%231.txt"],
  ["files/query?.txt", "/api/files/read?path=files/query%3F.txt"],
  ["files/café.txt", "/api/files/read?path=files/caf%C3%A9.txt"],
  ["files/文档.txt", "/api/files/read?path=files/%E6%96%87%E6%A1%A3.txt"],
] as const;

const literalPercentChatPaths = [
  ["files/report%2F2026.txt", "/api/files/read?path=files/report%252F2026.txt"],
  ["files/report%5C2026.txt", "/api/files/read?path=files/report%255C2026.txt"],
  ["files/report%002026.txt", "/api/files/read?path=files/report%25002026.txt"],
  ["files/%2e", "/api/files/read?path=files/%252e"],
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

  it.each(specialChatPaths)("linkifies and opens special chat path %s", async (path, expectedUrl) => {
    render(<ChatFileHarness path={path} />);

    const link = screen.getByTitle(`Open ${path} in viewer`);
    expect(link.getAttribute("href")).toBe(`/file?path=${encodeURIComponent(path)}`);
    fireEvent.click(link);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expectedUrl));
  });

  it.each(literalPercentChatPaths)("round-trips literal percent-like chat path %s", async (path, expectedUrl) => {
    render(<ChatFileHarness path={path} />);

    const link = screen.getByTitle(`Open ${path} in viewer`);
    expect(link.getAttribute("href")).toBe(`/file?path=${encodeURIComponent(path)}`);
    fireEvent.click(link);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expectedUrl));
  });

  it("keeps a lone-surrogate supported-root path as inline code", () => {
    const path = `files/bad${String.fromCharCode(0xd800)}.txt`;

    expect(() => render(<ChatFileHarness path={path} />)).not.toThrow();
    expect(screen.getByText(path, { selector: "code" })).toBeTruthy();
    expect(screen.queryByTitle(`Open ${path} in viewer`)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "files/../outside.txt",
    "files/./report.txt",
    "files//report.txt",
    "files/nested\\report.txt",
    "files/has\0nul.txt",
    "files/has\u0001control.txt",
  ])("keeps unsafe supported-root chat path %s as inline code", (path) => {
    render(<ChatFileHarness path={path} />);

    expect(screen.getByText(path, { selector: "code" })).toBeTruthy();
    expect(screen.queryByTitle(`Open ${path} in viewer`)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["secrets/api-keys.json", /Unsupported file root/],
    ["../outside.txt", /traversal/],
    ["files/../outside.txt", /traversal/],
    ["files//outside.txt", /normalized/],
    ["files%2Foutside.txt", /Unsupported file root/],
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

  it("shows invalid Unicode safely without fetching or a broken pop-out link", async () => {
    const path = `files/bad${String.fromCharCode(0xd800)}.txt`;
    render(<FileView path={path} embedded />);

    expect(await screen.findByText(/invalid Unicode/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTitle("Open in new browser tab")).toBeNull();
  });

  it("does not label the JSON read route as a binary download", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        path: "files/archive.zip",
        resolvedPath: "/managed/files/archive.zip",
        mime: "application/zip",
        size: 1024,
        binary: true,
        tooLarge: false,
      }),
    } as Response);

    render(<FileView path="files/archive.zip" embedded />);

    expect(await screen.findByText(/Binary file/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Download file" })).toBeNull();
  });
});
