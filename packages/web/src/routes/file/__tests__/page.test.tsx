import { render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
});
