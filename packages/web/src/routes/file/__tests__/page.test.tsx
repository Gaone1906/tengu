import { render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildFileReadRequest } from "@/lib/file-read-request";
import FilePage from "../page";

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

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      path: "fixture.md",
      title: "Fixture",
      content: "fixture body",
      truncated: false,
      totalChars: 12,
    }),
  } as Response);
  vi.stubGlobal("fetch", fetchMock);
});

describe("standalone /file route", () => {
  it.each([
    ["knowledge/product-checklist.md", "/api/knowledge/read?path=knowledge%2Fproduct-checklist.md"],
    ["docs/company-doctrine.md", "/api/knowledge/read?path=docs%2Fcompany-doctrine.md"],
    ["files/reports/result.txt", "/api/files/read?path=files/reports/result.txt"],
    ["uploads/2026-07/report.txt", "/api/files/read?path=uploads/2026-07/report.txt"],
    ["files/report%2F2026.txt", "/api/files/read?path=files/report%252F2026.txt"],
    ["files/report%5C2026.txt", "/api/files/read?path=files/report%255C2026.txt"],
    ["files/report%002026.txt", "/api/files/read?path=files/report%25002026.txt"],
    ["files/%2e", "/api/files/read?path=files/%252e"],
  ] as const)("decodes the outer query once and opens %s", async (path, expectedUrl) => {
    render(
      <MemoryRouter initialEntries={[`/file?path=${encodeURIComponent(path)}`]}>
        <FilePage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expectedUrl));
  });

  it("does not decode a double-encoded separator into a path root", async () => {
    render(
      <MemoryRouter initialEntries={["/file?path=files%252Foutside.txt"]}>
        <FilePage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
  });

  it.each([
    "/file?path=files%2F..%2Foutside.txt",
    "/file?path=files%2Fhas%00nul.txt",
    "/file?path=%2Fetc%2Fpasswd",
  ])("rejects an unsafe path after URLSearchParams decodes it once: %s", async (outerUrl) => {
    render(
      <MemoryRouter initialEntries={[outerUrl]}>
        <FilePage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
  });
});

describe("file URL encoding boundaries", () => {
  const urlFlowCases = [
    {
      outerUrl: "/file?path=files%2Freports%2Fresult.txt",
      urlSearchParamsValue: "files/reports/result.txt",
      helperRequestUrl: "/api/files/read?path=files/reports/result.txt",
      backendRequestedPath: "files/reports/result.txt",
    },
    {
      outerUrl: "/file?path=files%2Freport%252F2026.txt",
      urlSearchParamsValue: "files/report%2F2026.txt",
      helperRequestUrl: "/api/files/read?path=files/report%252F2026.txt",
      backendRequestedPath: "files/report%2F2026.txt",
    },
    {
      outerUrl: "/file?path=files%2Freport%255C2026.txt",
      urlSearchParamsValue: "files/report%5C2026.txt",
      helperRequestUrl: "/api/files/read?path=files/report%255C2026.txt",
      backendRequestedPath: "files/report%5C2026.txt",
    },
    {
      outerUrl: "/file?path=files%2Freport%25002026.txt",
      urlSearchParamsValue: "files/report%002026.txt",
      helperRequestUrl: "/api/files/read?path=files/report%25002026.txt",
      backendRequestedPath: "files/report%002026.txt",
    },
    {
      outerUrl: "/file?path=files%2F%252e",
      urlSearchParamsValue: "files/%2e",
      helperRequestUrl: "/api/files/read?path=files/%252e",
      backendRequestedPath: "files/%2e",
    },
  ] as const;

  it.each(urlFlowCases)(
    "$outerUrl -> $urlSearchParamsValue -> $helperRequestUrl -> $backendRequestedPath",
    ({ outerUrl, urlSearchParamsValue, helperRequestUrl, backendRequestedPath }) => {
      // Each URL layer decodes once. `%25` in the outer URL becomes literal `%`
      // filename data in the UI, then the helper encodes that `%` once for the
      // gateway. The gateway's URL parser therefore receives the original text.
      const decodedByUi = new URL(outerUrl, "http://viewer.test").searchParams.get("path");
      expect(decodedByUi).toBe(urlSearchParamsValue);

      const request = buildFileReadRequest(decodedByUi ?? "");
      expect(request).toEqual({ ok: true, url: helperRequestUrl });

      const decodedByBackend = new URL(helperRequestUrl, "http://gateway.test").searchParams.get("path");
      expect(decodedByBackend).toBe(backendRequestedPath);
    },
  );
});
