import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
// PrismAsyncLight ships NO grammars by default (the full `Prism` build bundles
// ~200, ~250KB gzip). We register only the languages the app's file/markdown
// surfaces can produce, so this chunk carries a handful of grammars instead of
// all of them. Unregistered languages (e.g. an exotic fenced code block) simply
// render unhighlighted — acceptable graceful degradation.
import { PrismAsyncLight as SyntaxHighlighter } from "react-syntax-highlighter";
import {
  oneDark,
  oneLight,
} from "react-syntax-highlighter/dist/esm/styles/prism";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import ruby from "react-syntax-highlighter/dist/esm/languages/prism/ruby";
import go from "react-syntax-highlighter/dist/esm/languages/prism/go";
import rust from "react-syntax-highlighter/dist/esm/languages/prism/rust";
import java from "react-syntax-highlighter/dist/esm/languages/prism/java";
import kotlin from "react-syntax-highlighter/dist/esm/languages/prism/kotlin";
import swift from "react-syntax-highlighter/dist/esm/languages/prism/swift";
import c from "react-syntax-highlighter/dist/esm/languages/prism/c";
import cpp from "react-syntax-highlighter/dist/esm/languages/prism/cpp";
import csharp from "react-syntax-highlighter/dist/esm/languages/prism/csharp";
import php from "react-syntax-highlighter/dist/esm/languages/prism/php";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";
import toml from "react-syntax-highlighter/dist/esm/languages/prism/toml";
import ini from "react-syntax-highlighter/dist/esm/languages/prism/ini";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import scss from "react-syntax-highlighter/dist/esm/languages/prism/scss";
import less from "react-syntax-highlighter/dist/esm/languages/prism/less";
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import graphql from "react-syntax-highlighter/dist/esm/languages/prism/graphql";
import docker from "react-syntax-highlighter/dist/esm/languages/prism/docker";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import { CodeBlockChrome } from "./code-block-chrome";

// The languages reachable from file-view's EXT_TO_LANG (plus common fenced-block langs).
const PRISM_LANGUAGES: Record<string, unknown> = {
  typescript, tsx, javascript, jsx, python, ruby, go, rust, java, kotlin,
  swift, c, cpp, csharp, php, json, yaml, toml, ini, bash, css, scss, less,
  markup, sql, graphql, docker, markdown,
};
for (const [name, grammar] of Object.entries(PRISM_LANGUAGES)) {
  SyntaxHighlighter.registerLanguage(name, grammar);
}

export { SyntaxHighlighter, oneDark, oneLight };

/** GitHub-flavored markdown rendering with highlighted fenced code blocks.
 *  Shared by the file viewer and the skills pages so documents read the same
 *  everywhere. */
export function MarkdownView({
  content,
  isDark,
}: {
  content: string;
  isDark: boolean;
}) {
  const codeTheme = isDark ? oneDark : oneLight;
  return (
    <div className="jinn-markdown min-w-0 max-w-full break-words [overflow-wrap:anywhere] text-[length:var(--text-body)] leading-[1.7] text-[var(--text-secondary)]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1
              className="text-[length:var(--text-title1)] font-[var(--weight-bold)] mt-[var(--space-6)] mb-[var(--space-3)]"
              style={{ color: "var(--text-primary)" }}
            >
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2
              className="text-[length:var(--text-title2)] font-[var(--weight-semibold)] mt-[var(--space-6)] mb-[var(--space-2)] pb-[var(--space-1)]"
              style={{
                color: "var(--text-primary)",
                borderBottom: "1px solid var(--separator)",
              }}
            >
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3
              className="text-[length:var(--text-title3)] font-[var(--weight-semibold)] mt-[var(--space-5)] mb-[var(--space-2)]"
              style={{ color: "var(--text-primary)" }}
            >
              {children}
            </h3>
          ),
          h4: ({ children }) => (
            <h4
              className="text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] mt-[var(--space-4)] mb-[var(--space-1)]"
              style={{ color: "var(--text-primary)" }}
            >
              {children}
            </h4>
          ),
          p: ({ children }) => (
            <p className="mb-[var(--space-4)]">{children}</p>
          ),
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--accent)" }}
              className="underline"
            >
              {children}
            </a>
          ),
          ul: ({ children }) => (
            <ul className="list-disc ml-[var(--space-6)] mb-[var(--space-4)] space-y-[var(--space-1)]">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal ml-[var(--space-6)] mb-[var(--space-4)] space-y-[var(--space-1)]">
              {children}
            </ol>
          ),
          blockquote: ({ children }) => (
            <blockquote
              className="pl-[var(--space-4)] my-[var(--space-4)]"
              style={{
                borderLeft: "3px solid var(--separator)",
                color: "var(--text-tertiary)",
              }}
            >
              {children}
            </blockquote>
          ),
          strong: ({ children }) => (
            <strong
              className="font-[var(--weight-semibold)]"
              style={{ color: "var(--text-primary)" }}
            >
              {children}
            </strong>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto mb-[var(--space-4)]">
              <table
                className="border-collapse w-full text-[length:var(--text-subheadline)]"
                style={{ border: "1px solid var(--separator)" }}
              >
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th
              className="text-left px-[var(--space-3)] py-[var(--space-2)] font-[var(--weight-semibold)]"
              style={{
                border: "1px solid var(--separator)",
                color: "var(--text-primary)",
                background: "var(--fill-tertiary)",
              }}
            >
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td
              className="px-[var(--space-3)] py-[var(--space-2)]"
              style={{ border: "1px solid var(--separator)" }}
            >
              {children}
            </td>
          ),
          hr: () => (
            <hr
              className="my-[var(--space-6)]"
              style={{ border: 0, borderTop: "1px solid var(--separator)" }}
            />
          ),
          pre: ({ children }) => <>{children}</>,
          code(props) {
            const { children, className, node, ...rest } = props as {
              children?: React.ReactNode;
              className?: string;
              node?: unknown;
              inline?: boolean;
            };
            const match = /language-(\w+)/.exec(className ?? "");
            const source = String(children ?? "");
            const text = source.replace(/\n$/, "");
            // Inline code (no language class and no newline) → styled <code>.
            const isInline = !match && !source.includes("\n");
            if (isInline) {
              return (
                <code
                  style={{
                    background: "var(--fill-secondary)",
                    color: "var(--accent)",
                    padding: "2px 6px",
                    borderRadius: "6px",
                    fontSize: "13px",
                    fontFamily: "var(--font-mono)",
                  }}
                  {...rest}
                >
                  {children}
                </code>
              );
            }
            return (
              <CodeBlockChrome
                code={text}
                language={match ? match[1] : "text"}
                className="mb-[var(--space-4)]"
              >
                <SyntaxHighlighter
                  language={match ? match[1] : "text"}
                  style={codeTheme}
                  customStyle={{
                    margin: 0,
                    maxWidth: "100%",
                    fontSize: "13px",
                    fontFamily: "var(--font-mono)",
                  }}
                  codeTagProps={{ style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } }}
                  wrapLongLines
                >
                  {text}
                </SyntaxHighlighter>
              </CodeBlockChrome>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
