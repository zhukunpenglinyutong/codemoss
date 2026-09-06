import { isValidElement, memo, useMemo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import Copy from "lucide-react/dist/esm/icons/copy";
import Check from "lucide-react/dist/esm/icons/check";
import { useFilesStore } from "@/features/files/store";
import { useCopied } from "@/hooks/use-copied";
import {
  decodeFileLink,
  isFileLinkUrl,
  isLinkableFilePath,
  resolveFilePath,
  toFileLink,
} from "@/lib/fileLinks";

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeHighlight];

function openFileFromChat(rawPath: string, workspacePath: string) {
  const path = resolveFilePath(rawPath, workspacePath);
  if (!path) return;
  // Opens as a center-area tab; visible at every window width.
  void useFilesStore.getState().openFile(path);
}

function openExternalUrl(url: string) {
  void invoke("plugin:opener|open_url", { url }).catch(() => {});
}

/** Green dotted-underline file link (parity with desktop-cc-gui). */
function FileLink({
  href,
  path,
  workspacePath,
  children,
}: {
  href: string;
  path: string;
  workspacePath: string;
  children: ReactNode;
}) {
  const resolved = resolveFilePath(path, workspacePath);
  return (
    <a
      className="md-file-link"
      href={href}
      title={resolved ?? path}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        openFileFromChat(path, workspacePath);
      }}
    >
      {children}
    </a>
  );
}

/** Pull the raw text out of a rendered <code> node (hljs wraps tokens in
 * spans, so children is a tree, not a string). */
function extractText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement(node)) return extractText(node.props.children);
  return "";
}

/** shadcn-style code block card: language header + copy button, theme-aware
 * muted surface. Single-line fences render compact with a floating copy. */
function CodeBlock({ children }: { children?: ReactNode }) {
  const { t } = useTranslation();
  const { copied, copy } = useCopied();

  const codeProps = isValidElement(children) ? children.props : undefined;
  const language = /language-([\w+-]+)/.exec(codeProps?.className ?? "")?.[1] ?? null;
  const value = extractText(codeProps?.children).replace(/\n$/, "");

  const copyButton = (
    <button
      type="button"
      className="md-codeblock-copy"
      aria-label={copied ? t("common.copied") : t("chat.copy")}
      title={copied ? t("common.copied") : t("chat.copy")}
      onClick={() => copy(value)}
    >
      {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
    </button>
  );

  if (!value.includes("\n")) {
    return (
      <div className="md-codeblock-single-wrap">
        <div className="md-codeblock-single-actions">{copyButton}</div>
        <pre className="md-codeblock-single">{children}</pre>
      </div>
    );
  }

  return (
    <div className="md-codeblock">
      <div className="md-codeblock-header">
        <span className="md-codeblock-language">{(language ?? "text").toUpperCase()}</span>
        {copyButton}
      </div>
      <pre>{children}</pre>
    </div>
  );
}

export default memo(function Markdown({
  text,
  workspacePath,
}: {
  text: string;
  workspacePath: string;
}) {
  // Stable components map: a new reference makes ReactMarkdown discard its
  // HAST tree and re-parse the whole document.
  const components = useMemo<Components>(
    () => ({
      a: ({ href, children }) => {
        const url = href ?? "";
        if (isFileLinkUrl(url)) {
          return (
            <FileLink href={url} path={decodeFileLink(url)} workspacePath={workspacePath}>
              {children}
            </FileLink>
          );
        }
        if (/^(https?:|mailto:)/.test(url)) {
          return (
            <a
              href={url}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openExternalUrl(url);
              }}
            >
              {children}
            </a>
          );
        }
        // A relative/absolute link target that is itself a file path.
        if (url && isLinkableFilePath(url)) {
          return (
            <FileLink href={url} path={url} workspacePath={workspacePath}>
              {children}
            </FileLink>
          );
        }
        // Unrecognized or blocked scheme (blanked by urlTransform, file:,
        // in-page "#" which would hit HashRouter, ...): render the label as
        // plain text, never a navigable anchor.
        return <span>{children}</span>;
      },
      code: ({ className, children }) => {
        // Block code (inside <pre>) carries the hljs class — leave it alone.
        if (className) return <code className={className}>{children}</code>;
        const value = String(children ?? "").trim();
        if (!value || !isLinkableFilePath(value)) return <code>{children}</code>;
        return (
          <FileLink href={toFileLink(value)} path={value} workspacePath={workspacePath}>
            <code>{children}</code>
          </FileLink>
        );
      },
      pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
    }),
    [workspacePath],
  );

  return (
    <div className="prose-chat text-body-regular text-text-primary">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={components}
        urlTransform={(url) =>
          // file: is deliberately excluded: model output must not smuggle in
          // local-file URLs. Real file paths are handled via FileLink above.
          isFileLinkUrl(url) ||
          /^(https?|mailto):/i.test(url) ||
          url.startsWith("#") ||
          url.startsWith("/") ||
          url.startsWith("./") ||
          url.startsWith("../") ||
          /^[A-Za-z]:[\\/]/.test(url)
            ? url
            : ""
        }
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
