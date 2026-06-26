import { Fragment, lazy, memo, startTransition, Suspense, useCallback, useEffect, useMemo, useRef, useState, isValidElement, type ImgHTMLAttributes, type ReactNode, type MouseEvent } from "react";
import Check from "lucide-react/dist/esm/icons/check";
import Copy from "lucide-react/dist/esm/icons/copy";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { convertFileSrc } from "@tauri-apps/api/core";
import { LocalImage } from "./LocalImage";
import { ImageFullscreenViewer } from "../../markdown/imageFullscreen";
import type { MarkdownOutlineEntry } from "../../markdown/fastMarkdownRenderer";
import { extractOutlineFromMarkdown } from "../utils/messageOutlineExtractor";
import type {
  FullMarkdownComponents,
  FullMarkdownUrlTransform,
} from "./FullMarkdownRuntime";
import {
  LightweightMarkdown,
  resolveAdaptiveProgressiveRevealStepMs,
  PROGRESSIVE_REVEAL_CHUNK_CHARS,
  PROGRESSIVE_REVEAL_STEP_MS,
  normalizeProgressiveRevealChunkChars,
  normalizeProgressiveRevealStepMs,
  resolveProgressiveRevealValue,
  type LightweightMarkdownLinkRenderer,
} from "./LiveMarkdown";
import { ToolCallBlock } from "./ToolCallBlock";
import {
  areKatexAssetsReady,
  buildLatexRenderEntries,
  detectMathContent,
  isKatexRenderReady,
  loadKatexAssets,
  normalizeMarkdownMathForMessage,
  renderLatexFormula,
} from "../../markdown/markdownMath";
export { prewarmKatexAssets } from "../../markdown/markdownMath";

const MermaidBlock = lazy(() => import("./MermaidBlock"));
const FullMarkdownRuntime = lazy(() =>
  import("./FullMarkdownRuntime").then((module) => ({
    default: module.FullMarkdownRuntime,
  })),
);
import {
  decodeFileLink,
  isFileLinkUrl,
  isLinkableFilePath,
  toFileLink,
} from "../../../utils/remarkFileLinks";
import {
  getMarkdownInlineCodeInfo,
  normalizeOutsideMarkdownCode,
} from "../../../utils/markdownCodeRegions";
import { highlightLine } from "../../../utils/syntax";
import { detectCodexLeadMarker, type CodexLeadMarkerConfig } from "../constants/codexLeadMarkers";
import { parseToolCallBlocks, type Block } from "../utils/toolCallBlocks";
import {
  createMessageMarkdownOptionsHash,
  createMessageMarkdownPrecomputeRequest,
  isStaleMessageMarkdownPrecomputeResult,
  runMessageMarkdownPrecompute,
} from "../../markdown/messageMarkdownPrecompute";
import { classifyMessageMarkdownHeavyIslands } from "../../markdown/messageMarkdownHeavyIslands";
import { appendMarkdownPrecomputeDiagnostic } from "../../../services/rendererDiagnostics";

type MarkdownProps = {
  value: string;
  className?: string;
  workspaceId?: string | null;
  codeBlock?: boolean;
  codeBlockStyle?: "default" | "message";
  codeBlockCopyUseModifier?: boolean;
  streamingThrottleMs?: number;
  softBreaks?: boolean;
  preserveFormatting?: boolean;
  liveRenderMode?: "full" | "lightweight";
  progressiveReveal?: boolean;
  progressiveRevealStepMs?: number;
  progressiveRevealChunkChars?: number;
  codexLeadMarkerConfig?: CodexLeadMarkerConfig;
  onOpenFileLink?: (path: string) => void;
  onOpenFileLinkMenu?: (event: React.MouseEvent, path: string) => void;
  onRenderedValueChange?: (value: string) => void;
  onOutlineReady?: (outline: MarkdownOutlineEntry[]) => void;
};

type InlineCodeProps = {
  children: ReactNode;
  text: string;
};

function InlineCode({ children, text }: InlineCodeProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        window.clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const handleCopy = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (copyTimeoutRef.current) {
        window.clearTimeout(copyTimeoutRef.current);
      }
      copyTimeoutRef.current = window.setTimeout(() => {
        setCopied(false);
      }, 1200);
    } catch {
      // No-op: clipboard errors can occur in restricted contexts.
    }
  };

  return (
    <span className={`markdown-inline-code-copy${copied ? " is-copied" : ""}`}>
      <code>{children}</code>
      <button
        type="button"
        className="markdown-inline-code-copy-button"
        onClick={handleCopy}
        aria-label={t("messages.copyInlineCode", "复制行内代码")}
        title={copied ? t("messages.copied") : t("messages.copyInlineCode", "复制行内代码")}
      >
        <Copy className="markdown-inline-code-copy-icon markdown-inline-code-copy-icon-copy" size={11} />
        <Check className="markdown-inline-code-copy-icon markdown-inline-code-copy-icon-check" size={11} />
      </button>
    </span>
  );
}

type CodeBlockProps = {
  className?: string;
  value: string;
  copyUseModifier: boolean;
};

type PreProps = {
  node?: {
    tagName?: string;
    position?: {
      start?: { offset?: number };
      end?: { offset?: number };
    };
    children?: Array<{
      tagName?: string;
      properties?: { className?: string[] | string };
      children?: Array<{ value?: string }>;
    }>;
  };
  children?: ReactNode;
  copyUseModifier: boolean;
  sourceMarkdown: string;
  workspaceId: string | null;
  onOpenFileLink?: (path: string) => void;
  onOpenFileLinkMenu?: (event: React.MouseEvent, path: string) => void;
};

type LinkBlockProps = {
  urls: string[];
};

type DeferredCodeBlockProps = CodeBlockProps & {
  languageLabel: string;
  lineCount: number;
};

type DeferredMarkdownTableProps = {
  children: ReactNode;
  rowCount: number;
};

const MARKDOWN_LANGUAGE_SET = new Set(["markdown", "md", "mdx"]);
const HEAVY_CODE_BLOCK_MIN_LINES = 40;
const HEAVY_CODE_BLOCK_MIN_CHARS = 4_000;
const HEAVY_TABLE_MIN_ROWS = 12;
const MARKDOWN_ALERT_TONE_SET = new Set([
  "note",
  "tip",
  "important",
  "warning",
  "caution",
]);
const TOOL_CALL_XML_CANDIDATE_REGEX = /<\s*(?:antml:)?(?:function_calls|invoke)\b/i;

function stableToolCallHash(value: string) {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function buildToolCallBlockKey(block: Extract<Block, { kind: "tool-call" }>) {
  return `tcb-${block.startOffset}-${block.tagName}-${stableToolCallHash(block.keySignature)}`;
}

function areMarkdownPropsEqual(prev: MarkdownProps, next: MarkdownProps) {
  return (
    prev.value === next.value &&
    prev.className === next.className &&
    prev.workspaceId === next.workspaceId &&
    prev.codeBlock === next.codeBlock &&
    prev.codeBlockStyle === next.codeBlockStyle &&
    prev.codeBlockCopyUseModifier === next.codeBlockCopyUseModifier &&
    prev.streamingThrottleMs === next.streamingThrottleMs &&
    prev.softBreaks === next.softBreaks &&
    prev.preserveFormatting === next.preserveFormatting &&
    prev.liveRenderMode === next.liveRenderMode &&
    prev.progressiveReveal === next.progressiveReveal &&
    prev.progressiveRevealStepMs === next.progressiveRevealStepMs &&
    prev.progressiveRevealChunkChars === next.progressiveRevealChunkChars &&
    prev.codexLeadMarkerConfig === next.codexLeadMarkerConfig &&
    prev.onOpenFileLink === next.onOpenFileLink &&
    prev.onOpenFileLinkMenu === next.onOpenFileLinkMenu &&
    prev.onRenderedValueChange === next.onRenderedValueChange &&
    prev.onOutlineReady === next.onOutlineReady
  );
}

function extractLanguageTag(className?: string) {
  if (!className) {
    return null;
  }
  const match = className.match(/language-([\w-]+)/i);
  if (!match) {
    return null;
  }
  return match[1] ?? null;
}

function isLatexLanguage(languageTag: string | null) {
  const normalized = languageTag?.toLowerCase();
  return normalized === "latex" || normalized === "tex";
}

function isMarkdownLanguage(languageTag: string | null) {
  if (!languageTag) {
    return false;
  }
  return MARKDOWN_LANGUAGE_SET.has(languageTag.trim().toLowerCase());
}

function extractMarkdownContent(languageTag: string | null, value: string): string | null {
  if (isMarkdownLanguage(languageTag) && value.trim()) {
    return value;
  }
  const fencedMatch = value.match(/^```(?:markdown|md|mdx)\s*\n([\s\S]*?)(?:\n```\s*)?$/i);
  if (!fencedMatch) {
    return null;
  }
  const inner = (fencedMatch[1] ?? "").trim();
  return inner || null;
}

function shouldRenderMarkdownFenceAsCard(
  node: PreProps["node"],
  sourceMarkdown: string,
) {
  const startOffset = node?.position?.start?.offset;
  if (typeof startOffset !== "number" || startOffset < 0) {
    return false;
  }
  const lineStart = sourceMarkdown.lastIndexOf("\n", Math.max(0, startOffset - 1)) + 1;
  const leadingIndent = sourceMarkdown.slice(lineStart, startOffset);
  return leadingIndent.length === 0;
}

function extractCodeFromPre(node?: PreProps["node"]) {
  const codeNode = node?.children?.find((child) => child.tagName === "code");
  const className = codeNode?.properties?.className;
  const normalizedClassName = Array.isArray(className)
    ? className.join(" ")
    : className;
  const value =
    codeNode?.children?.map((child) => child.value ?? "").join("") ?? "";
  return {
    className: normalizedClassName,
    value: value.replace(/\n$/, ""),
  };
}

function normalizeUrlLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  const withoutBullet = trimmed.replace(/^(?:[-*]|\d+\.)\s+/, "");
  if (!/^https?:\/\/\S+$/i.test(withoutBullet)) {
    return null;
  }
  return withoutBullet;
}

function extractUrlLines(value: string) {
  const lines = value.split(/\r?\n/);
  const urls = lines
    .map((line) => normalizeUrlLine(line))
    .filter((line): line is string => Boolean(line));
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
  if (nonEmptyLines.length === 0) {
    return null;
  }
  if (urls.length !== nonEmptyLines.length) {
    return null;
  }
  return urls;
}

function normalizeListIndentation(value: string) {
  const lines = value.split(/\r?\n/);
  let inFence = false;
  let activeOrderedItem = false;
  let orderedBaseIndent = 4;
  let orderedIndentOffset: number | null = null;

  const countLeadingSpaces = (line: string) =>
    line.match(/^\s*/)?.[0].length ?? 0;
  const spaces = (count: number) => " ".repeat(Math.max(0, count));
  const normalized = lines.map((line) => {
    const fenceMatch = line.match(/^\s*(```|~~~)/);
    if (fenceMatch) {
      inFence = !inFence;
      activeOrderedItem = false;
      orderedIndentOffset = null;
      return line;
    }
    if (inFence) {
      return line;
    }
    if (!line.trim()) {
      return line;
    }

  const orderedMatch = line.match(/^(\s*)(\d+)\.(\s*)(.*)$/);
  const orderedContent = orderedMatch?.[4] ?? "";
  const orderedHasWhitespace = ((orderedMatch?.[3] ?? "").length ?? 0) > 0;
    const orderedLooksDecimal =
      Boolean(orderedContent) &&
      !orderedHasWhitespace &&
      /^\d/.test(orderedContent);
    if (orderedMatch && !orderedLooksDecimal) {
      const rawIndent = (orderedMatch[1] ?? "").length;
      const normalizedIndent = rawIndent;
      activeOrderedItem = true;
      orderedBaseIndent = normalizedIndent + 4;
      orderedIndentOffset = null;
      const normalizedBody = orderedContent.trimStart();
      const normalizedLine = normalizedBody
        ? `${spaces(normalizedIndent)}${orderedMatch[2] ?? ""}. ${normalizedBody}`
        : `${spaces(normalizedIndent)}${orderedMatch[2] ?? ""}.`;
      if (normalizedIndent !== rawIndent || normalizedLine !== line) {
        return normalizedLine;
      }
      return line;
    }

    const bulletMatch = line.match(/^(\s*)([-*+])\s+/);
    if (bulletMatch) {
      const rawIndent = (bulletMatch[1] ?? "").length;
      let targetIndent = rawIndent;

      if (activeOrderedItem) {
        if (orderedIndentOffset === null && rawIndent < orderedBaseIndent) {
          orderedIndentOffset = orderedBaseIndent - rawIndent;
        }
        if (orderedIndentOffset !== null) {
          const adjustedIndent = rawIndent + orderedIndentOffset;
          if (adjustedIndent <= orderedBaseIndent + 12) {
            targetIndent = adjustedIndent;
          }
        }
      }

      if (targetIndent !== rawIndent) {
        return `${spaces(targetIndent)}${line.trimStart()}`;
      }
      return line;
    }

    const leadingSpaces = countLeadingSpaces(line);
    if (activeOrderedItem && leadingSpaces < orderedBaseIndent) {
      activeOrderedItem = false;
      orderedIndentOffset = null;
    }
    return line;
  });
  return normalized.join("\n");
}

const FRAGMENTED_PARAGRAPH_MIN_RUN = 5;
const FRAGMENTED_PARAGRAPH_MAX_LENGTH = 14;
const FRAGMENTED_PARAGRAPH_MIN_TOTAL_CHARS = 12;
const FRAGMENTED_PARAGRAPH_EDGE_MIN_LENGTH = 6;
const FRAGMENTED_LINE_MIN_RUN = 6;
const FRAGMENTED_LINE_MAX_LENGTH = 10;
const FRAGMENTED_LINE_MIN_TOTAL_CHARS = 12;
const PARAGRAPH_BREAK_SPLIT_REGEX = /\r?\n[^\S\r\n]*\r?\n+/;
const MARKDOWN_IMAGE_FILE_EXTENSION_REGEX =
  /\.(png|jpe?g|gif|webp|bmp|tiff?|svg|ico|avif)(?:[?#].*)?$/i;

function hasParagraphBreak(value: string) {
  return PARAGRAPH_BREAK_SPLIT_REGEX.test(value);
}

function normalizeInlineOrderedListBreaks(value: string) {
  return value.replace(
    /([：:。！？!?；;])\s*(\d+)\.(?!\d)(\S)/g,
    "$1\n$2. $3",
  );
}

const REGEXP_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/g;
const blockquoteContinuationCache = new Map<string, RegExp>();

function getBlockquoteContinuationRegex(quotePrefix: string): RegExp {
  const cached = blockquoteContinuationCache.get(quotePrefix);
  if (cached) {
    return cached;
  }
  const escapedPrefix = quotePrefix.replace(REGEXP_SPECIAL_CHARS, "\\$&");
  const created = new RegExp(`^${escapedPrefix}(?:\\s+\\S|\\s*$)`);
  blockquoteContinuationCache.set(quotePrefix, created);
  return created;
}

function normalizeGithubBlockquoteAlerts(value: string) {
  if (!value.includes("[!")) {
    return value;
  }
  const lines = value.split(/\r?\n/);
  const normalized: string[] = [];
  let changed = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = line.match(/^(\s*>+)\s*\[!([A-Z]+)\]\s*$/i);
    if (!match) {
      normalized.push(line);
      continue;
    }

    const tone = (match[2] ?? "").trim().toLowerCase();
    if (!MARKDOWN_ALERT_TONE_SET.has(tone)) {
      normalized.push(line);
      continue;
    }

    changed = true;
    const quotePrefix = match[1] ?? ">";
    normalized.push(
      `${quotePrefix} <span class="markdown-alert-label markdown-alert-label-${tone}">${tone.toUpperCase()}</span>`,
    );

    const nextLine = lines[index + 1] ?? "";
    if (
      nextLine &&
      !/^\s*>+\s*$/.test(nextLine) &&
      getBlockquoteContinuationRegex(quotePrefix).test(nextLine)
    ) {
      normalized.push(quotePrefix);
    }
  }

  return changed ? normalized.join("\n") : value;
}

function startsWithMarkdownBlockSyntax(value: string) {
  const trimmed = value.trimStart();
  return (
    /^[-*+]\s/.test(trimmed) ||
    /^\d+\.(?:\s|$|(?!\d)\S)/.test(trimmed) ||
    /^>\s?/.test(trimmed) ||
    /^#{1,6}\s/.test(trimmed) ||
    /^```/.test(trimmed) ||
    /^\|/.test(trimmed)
  );
}

function endsWithSentencePunctuation(value: string) {
  return /[。！？!?;；:：]$/.test(value.trim());
}

function shouldMergeFragmentedParagraph(value: string) {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= FRAGMENTED_PARAGRAPH_MAX_LENGTH &&
    !startsWithMarkdownBlockSyntax(trimmed)
  );
}

function extractBlockquoteParagraphText(paragraph: string) {
  const lines = paragraph.split(/\r?\n/);
  const fragments: string[] = [];
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    const match = line.match(/^\s*>\s?(.*)$/);
    if (!match) {
      return null;
    }
    const content = (match[1] ?? "").trim();
    if (!content || startsWithMarkdownBlockSyntax(content)) {
      return null;
    }
    fragments.push(content);
  }
  if (fragments.length === 0) {
    return null;
  }
  return joinFragmentedParagraphs(fragments);
}

function joinFragmentedParagraphs(segments: string[]) {
  return segments.reduce((combined, segment) => {
    if (!segment) {
      return combined;
    }
    if (!combined) {
      return segment;
    }
    const previousChar = combined[combined.length - 1] ?? "";
    const nextChar = segment[0] ?? "";
    const shouldInsertSpace =
      /[A-Za-z0-9]/.test(previousChar) &&
      /[A-Za-z0-9]/.test(nextChar);
    return shouldInsertSpace ? `${combined} ${segment}` : `${combined}${segment}`;
  }, "");
}

function trimMergeWindowByPunctuation(
  entries: string[],
  start: number,
  end: number,
) {
  let mergeStart = start;
  let mergeEnd = end;
  while (mergeStart < mergeEnd) {
    const edge = entries[mergeStart] ?? "";
    if (
      edge.length >= FRAGMENTED_PARAGRAPH_EDGE_MIN_LENGTH &&
      endsWithSentencePunctuation(edge)
    ) {
      mergeStart += 1;
      continue;
    }
    break;
  }
  while (mergeEnd > mergeStart) {
    const edge = entries[mergeEnd - 1] ?? "";
    if (
      edge.length >= FRAGMENTED_PARAGRAPH_EDGE_MIN_LENGTH &&
      endsWithSentencePunctuation(edge)
    ) {
      mergeEnd -= 1;
      continue;
    }
    break;
  }
  return { mergeStart, mergeEnd };
}

function normalizeFragmentedParagraphBreaks(value: string) {
  if (!hasParagraphBreak(value)) {
    return value;
  }
  const paragraphs = value.split(PARAGRAPH_BREAK_SPLIT_REGEX);
  if (paragraphs.length < FRAGMENTED_PARAGRAPH_MIN_RUN) {
    return value;
  }
  const trimmedParagraphs = paragraphs.map((entry) => entry.trim());

  const normalized: string[] = [];
  let changed = false;
  let index = 0;
  while (index < paragraphs.length) {
    const current = paragraphs[index] ?? "";
    const currentQuoteText = extractBlockquoteParagraphText(current);
    if (
      currentQuoteText &&
      shouldMergeFragmentedParagraph(currentQuoteText)
    ) {
      let cursor = index;
      const quoteEntries: string[] = [];
      while (cursor < paragraphs.length) {
        const candidateQuoteText = extractBlockquoteParagraphText(paragraphs[cursor] ?? "");
        if (
          !candidateQuoteText ||
          !shouldMergeFragmentedParagraph(candidateQuoteText)
        ) {
          break;
        }
        quoteEntries.push(candidateQuoteText.trim());
        cursor += 1;
      }

      const { mergeStart, mergeEnd } = trimMergeWindowByPunctuation(
        quoteEntries,
        0,
        quoteEntries.length,
      );
      if (mergeStart > 0) {
        normalized.push(
          ...quoteEntries.slice(0, mergeStart).map((entry) => `> ${entry}`),
        );
      }
      const mergeCandidates = quoteEntries.slice(mergeStart, mergeEnd);
      const mergeTotalChars = mergeCandidates.reduce(
        (sum, entry) => sum + entry.length,
        0,
      );
      if (
        mergeCandidates.length >= FRAGMENTED_PARAGRAPH_MIN_RUN &&
        mergeTotalChars >= FRAGMENTED_PARAGRAPH_MIN_TOTAL_CHARS
      ) {
        normalized.push(`> ${joinFragmentedParagraphs(mergeCandidates)}`);
        changed = true;
      } else {
        normalized.push(
          ...mergeCandidates.map((entry) => `> ${entry}`),
        );
      }
      if (mergeEnd < quoteEntries.length) {
        normalized.push(
          ...quoteEntries
            .slice(mergeEnd)
            .map((entry) => `> ${entry}`),
        );
      }
      index = cursor;
      continue;
    }

    if (!shouldMergeFragmentedParagraph(current)) {
      normalized.push(current);
      index += 1;
      continue;
    }

    let cursor = index;
    while (cursor < paragraphs.length) {
      const candidate = paragraphs[cursor] ?? "";
      if (!shouldMergeFragmentedParagraph(candidate)) {
        break;
      }
      cursor += 1;
    }

    const { mergeStart, mergeEnd } = trimMergeWindowByPunctuation(
      trimmedParagraphs,
      index,
      cursor,
    );

    if (mergeStart > index) {
      normalized.push(...paragraphs.slice(index, mergeStart));
    }

    const mergeCandidates = trimmedParagraphs
      .slice(mergeStart, mergeEnd)
      .filter(Boolean);
    const mergeTotalChars = mergeCandidates.reduce(
      (sum, entry) => sum + entry.length,
      0,
    );
    if (
      mergeCandidates.length >= FRAGMENTED_PARAGRAPH_MIN_RUN &&
      mergeTotalChars >= FRAGMENTED_PARAGRAPH_MIN_TOTAL_CHARS
    ) {
      normalized.push(joinFragmentedParagraphs(mergeCandidates));
      changed = true;
    } else {
      normalized.push(...paragraphs.slice(mergeStart, mergeEnd));
    }

    if (mergeEnd < cursor) {
      normalized.push(...paragraphs.slice(mergeEnd, cursor));
    }
    index = cursor;
  }
  return changed ? normalized.join("\n\n") : value;
}

function shouldMergeFragmentedLine(value: string) {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= FRAGMENTED_LINE_MAX_LENGTH &&
    !startsWithMarkdownBlockSyntax(trimmed)
  );
}

function normalizeFragmentedLineBreaks(value: string) {
  if (!value.includes("\n")) {
    return value;
  }
  const blocks = value.split(PARAGRAPH_BREAK_SPLIT_REGEX);
  let changed = false;
  const normalizedBlocks = blocks.map((block) => {
    const lines = block.split(/\r?\n/);
    const normalizedLines: string[] = [];
    let index = 0;
    while (index < lines.length) {
      const current = lines[index] ?? "";
      if (!shouldMergeFragmentedLine(current)) {
        normalizedLines.push(current);
        index += 1;
        continue;
      }
      let cursor = index;
      const run: string[] = [];
      let totalChars = 0;
      while (cursor < lines.length) {
        const candidate = lines[cursor] ?? "";
        if (!shouldMergeFragmentedLine(candidate)) {
          break;
        }
        const trimmed = candidate.trim();
        run.push(trimmed);
        totalChars += trimmed.length;
        cursor += 1;
      }
      const runCompact = run.join("");
      const nonSpaceLength = runCompact.replace(/\s+/g, "").length;
      const cjkCount = (runCompact.match(/[\u4e00-\u9fff]/g) ?? []).length;
      const isCjkDominant = cjkCount >= Math.max(2, Math.floor(nonSpaceLength * 0.35));
      if (
        run.length >= FRAGMENTED_LINE_MIN_RUN &&
        totalChars >= FRAGMENTED_LINE_MIN_TOTAL_CHARS &&
        isCjkDominant
      ) {
        normalizedLines.push(joinFragmentedParagraphs(run));
        changed = true;
      } else {
        normalizedLines.push(...lines.slice(index, cursor));
      }
      index = cursor;
    }
    return normalizedLines.join("\n");
  });
  return changed ? normalizedBlocks.join("\n\n") : value;
}

function escapeHtmlAttribute(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function parseImageAttributes(raw: string) {
  const attributes: Record<string, string> = {};
  const pattern = /([a-zA-Z_:][-\w.:]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(raw)) !== null) {
    const key = match[1]?.toLowerCase();
    if (!key) {
      continue;
    }
    const value = match[3] ?? match[4] ?? match[5] ?? "";
    attributes[key] = value;
  }
  return attributes;
}

function toHtmlImageTag(src: string, alt?: string, title?: string) {
  const safeSrc = escapeHtmlAttribute(src.trim());
  if (!safeSrc) {
    return "";
  }
  const safeAlt = escapeHtmlAttribute((alt ?? "image").trim() || "image");
  const titlePart = title && title.trim()
    ? ` title="${escapeHtmlAttribute(title.trim())}"`
    : "";
  return `<img src="${safeSrc}" alt="${safeAlt}" loading="lazy"${titlePart} />`;
}

function normalizeMarkdownLocalImageSyntax(value: string) {
  return value.replace(
    /!\[([^\]]*)\]\((file:\/\/[^\s)]+|[A-Za-z]:[\\/][^\s)]*)(?:\s+"([^"]*)")?\)/g,
    (match, rawAlt: string, rawSrc: string, rawTitle: string) => {
      const normalizedLocalPath = normalizeImageLocalPath(rawSrc);
      let renderSrc = normalizedLocalPath ?? rawSrc;
      if (/^[A-Za-z]:[\\/]/.test(renderSrc)) {
        renderSrc = `/${renderSrc}`;
      }
      const next = toHtmlImageTag(renderSrc, rawAlt, rawTitle);
      return next || match;
    },
  );
}

function normalizeImageTags(value: string) {
  let changed = false;
  const withLocalMarkdownImages = normalizeMarkdownLocalImageSyntax(value);
  if (withLocalMarkdownImages !== value) {
    changed = true;
  }

  const withBlockTags = withLocalMarkdownImages.replace(
    /<image>\s*([\s\S]*?)\s*<\/image>/gi,
    (_match, body: string) => {
      const src = body.trim();
      const next = toHtmlImageTag(src);
      if (!next) {
        return _match;
      }
      changed = true;
      return next;
    },
  );

  const withSelfClosingTags = withBlockTags.replace(
    /<image\b([^>]*)\/?>/gi,
    (match, rawAttrs: string) => {
      const attrs = parseImageAttributes(rawAttrs ?? "");
      const src = attrs.src?.trim();
      if (!src) {
        return match;
      }
      const next = toHtmlImageTag(src, attrs.alt, attrs.title);
      if (!next) {
        return match;
      }
      changed = true;
      return next;
    },
  );

  return changed ? withSelfClosingTags : value;
}

function safeDecodeUrl(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function stripFileScheme(value: string) {
  if (!value.startsWith("file://")) {
    return value;
  }
  const withoutScheme = value.slice("file://".length);
  if (withoutScheme.startsWith("localhost/")) {
    return `/${withoutScheme.slice("localhost/".length)}`;
  }
  if (withoutScheme.startsWith("/")) {
    return withoutScheme;
  }
  return `/${withoutScheme}`;
}

function isLikelyAbsoluteFilePath(value: string) {
  if (!value.startsWith("/")) {
    return false;
  }
  const pathBody = value.slice(1);
  if (!pathBody) {
    return false;
  }
  return pathBody.includes("/") || pathBody.includes(".");
}

function resolveLocalFileHref(url: string) {
  const trimmed = url.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }
  const normalized = repairFragmentedResourceToken(
    stripFileScheme(safeDecodeUrl(trimmed)),
  );
  const pathWithoutFragment = normalized.split("#", 1)[0] ?? normalized;
  if (
    normalized.startsWith("/") ||
    normalized.startsWith("./") ||
    normalized.startsWith("../") ||
    normalized.startsWith("~/") ||
    /^[A-Za-z]:[\\/]/.test(normalized)
  ) {
    if (normalized.startsWith("/") && !isLikelyAbsoluteFilePath(pathWithoutFragment)) {
      return null;
    }
    return normalized;
  }
  return isLinkableFilePath(normalized) ? normalized : null;
}

function decodeUrlValueSafe(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function looksLikeResourceReference(value: string) {
  const compact = value.replace(/\s+/g, "");
  if (!compact) {
    return false;
  }
  return (
    /(https?:\/\/|file:\/\/|\/Users\/|data:image\/)/i.test(compact) ||
    /^[A-Za-z]:[\\/]/.test(compact) ||
    MARKDOWN_IMAGE_FILE_EXTENSION_REGEX.test(compact)
  );
}

function repairFragmentedResourceToken(value: string) {
  const trimmed = value.trim();
  if (!trimmed || !looksLikeResourceReference(trimmed)) {
    return trimmed;
  }
  let repaired = trimmed;
  repaired = repaired.replace(/(https?):\s*\/\s*\//gi, "$1://");
  repaired = repaired.replace(/file:\s*\/\s*\//gi, "file://");
  repaired = repaired.replace(/([A-Za-z0-9])\s+([./\\:_-])/g, "$1$2");
  repaired = repaired.replace(/([./\\:_-])\s+([A-Za-z0-9])/g, "$1$2");
  return repaired.trim();
}

function normalizeFragmentedResourceReferences(value: string) {
  const withMarkdownTargets = value.replace(
    /(!?\[[^\]]*]\()([\s\S]*?)(\))/g,
    (match, prefix: string, rawTarget: string, suffix: string) => {
      const repaired = repairFragmentedResourceToken(rawTarget);
      if (!repaired || repaired === rawTarget || !looksLikeResourceReference(repaired)) {
        return match;
      }
      return `${prefix}${repaired}${suffix}`;
    },
  );
  const source = withMarkdownTargets;
  const lines = source.split(/\r?\n/);
  let changed = false;
  const normalized = lines.map((line) => {
    if (!looksLikeResourceReference(line)) {
      return line;
    }
    const repaired = repairFragmentedResourceToken(line);
    if (repaired !== line) {
      changed = true;
    }
    return repaired;
  });
  if (!changed) {
    return source;
  }
  return normalized.join("\n");
}

function normalizeImageLocalPath(src: string) {
  const decoded = repairFragmentedResourceToken(decodeUrlValueSafe(src.trim()));
  if (!decoded) {
    return null;
  }
  if (/^\/[A-Za-z]:[\\/]/.test(decoded)) {
    return decoded.slice(1);
  }
  if (decoded.startsWith("file://")) {
    const withoutScheme = decoded.slice("file://".length);
    const withoutHost = withoutScheme.startsWith("localhost/")
      ? withoutScheme.slice("localhost/".length)
      : withoutScheme;
    if (/^\/[A-Za-z]:[\\/]/.test(withoutHost)) {
      return withoutHost.slice(1);
    }
    if (/^[A-Za-z]:[\\/]/.test(withoutHost)) {
      return withoutHost;
    }
    if (withoutHost.startsWith("/")) {
      return withoutHost;
    }
    return `/${withoutHost}`;
  }
  if (
    decoded.startsWith("/") ||
    decoded.startsWith("./") ||
    decoded.startsWith("../") ||
    decoded.startsWith("~/") ||
    /^[A-Za-z]:[\\/]/.test(decoded) ||
    /^\\\\[^\\]/.test(decoded)
  ) {
    return decoded;
  }
  return null;
}

function normalizeMarkdownImageSrc(src: string) {
  const trimmed = src.trim();
  if (!trimmed) {
    return "";
  }
  const cleaned = repairFragmentedResourceToken(
    trimmed
    .replace(/^<(.+)>$/, "$1")
    .replace(/^['"](.+)['"]$/, "$1")
    .trim(),
  );
  if (!cleaned) {
    return "";
  }
  if (
    cleaned.startsWith("data:") ||
    cleaned.startsWith("http://") ||
    cleaned.startsWith("https://") ||
    cleaned.startsWith("asset://")
  ) {
    return cleaned;
  }
  const localPath = normalizeImageLocalPath(cleaned);
  const imageLikeLocal = MARKDOWN_IMAGE_FILE_EXTENSION_REGEX.test(cleaned);
  if (!localPath && !imageLikeLocal) {
    return "";
  }
  try {
    return convertFileSrc(localPath ?? cleaned);
  } catch {
    return "";
  }
}

function LinkBlock({ urls }: LinkBlockProps) {
  return (
    <div className="markdown-linkblock">
      {urls.map((url, index) => (
        <a
          key={`${url}-${index}`}
          href={url}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void openUrl(url);
          }}
        >
          {url}
        </a>
      ))}
    </div>
  );
}

function extractLatexContent(languageTag: string | null, value: string): string | null {
  if (isLatexLanguage(languageTag) && value.trim()) {
    return value;
  }
  const fencedMatch = value.match(/^```(?:latex|tex)\s*\n([\s\S]*?)(?:\n```\s*)?$/i);
  if (!fencedMatch) {
    return null;
  }
  const inner = (fencedMatch[1] ?? "").trim();
  return inner || null;
}

function renderHighlightedCodeLines(value: string, languageTag: string | null) {
  return value.split("\n").map((line, index) => (
    <span
      key={`${index}:${line.length}`}
      className="markdown-codeblock-line"
      dangerouslySetInnerHTML={{ __html: highlightLine(line, languageTag) }}
    />
  ));
}

function CodeBlock({ className, value, copyUseModifier }: CodeBlockProps) {
  const { t } = useTranslation();
  const [copiedMode, setCopiedMode] = useState<"plain" | "fenced" | null>(null);
  const copyTimeoutRef = useRef<number | null>(null);
  const languageTag = extractLanguageTag(className);
  const languageLabel = languageTag ?? "Code";
  const fencedValue = `\`\`\`${languageTag ?? ""}\n${value}\n\`\`\``;
  const highlightedLines = useMemo(
    () => renderHighlightedCodeLines(value, languageTag),
    [value, languageTag],
  );

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        window.clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const handleCopy = async (event: MouseEvent<HTMLButtonElement>) => {
    try {
      const nextValue = copyUseModifier && event.altKey ? fencedValue : value;
      await navigator.clipboard.writeText(nextValue);
      setCopiedMode(nextValue === fencedValue ? "fenced" : "plain");
      if (copyTimeoutRef.current) {
        window.clearTimeout(copyTimeoutRef.current);
      }
      copyTimeoutRef.current = window.setTimeout(() => {
        setCopiedMode(null);
      }, 1200);
    } catch {
      // No-op: clipboard errors can occur in restricted contexts.
    }
  };

  const handleCopyFenced = async () => {
    try {
      await navigator.clipboard.writeText(fencedValue);
      setCopiedMode("fenced");
      if (copyTimeoutRef.current) {
        window.clearTimeout(copyTimeoutRef.current);
      }
      copyTimeoutRef.current = window.setTimeout(() => {
        setCopiedMode(null);
      }, 1200);
    } catch {
      // No-op: clipboard errors can occur in restricted contexts.
    }
  };

  return (
    <div className="markdown-codeblock">
      <div className="markdown-codeblock-header">
        <span className="markdown-codeblock-language">{languageLabel}</span>
        <div className="markdown-codeblock-actions">
          <button
            type="button"
            className={`ghost markdown-codeblock-copy${copiedMode === "plain" ? " is-copied" : ""}`}
            onClick={handleCopy}
            aria-label={t("messages.copyCodeBlock")}
            title={copiedMode === "plain" ? t("messages.copied") : t("messages.copy")}
          >
            {copiedMode === "plain" ? t("messages.copied") : t("messages.copy")}
          </button>
          <button
            type="button"
            className={`ghost markdown-codeblock-copy${copiedMode === "fenced" ? " is-copied" : ""}`}
            onClick={handleCopyFenced}
            aria-label={t("messages.copyCodeBlockWithFence")}
            title={copiedMode === "fenced" ? t("messages.copied") : t("messages.copyWithFence")}
          >
            {copiedMode === "fenced" ? t("messages.copied") : t("messages.copyWithFence")}
          </button>
        </div>
      </div>
      <pre>
        <code className={className}>{highlightedLines}</code>
      </pre>
    </div>
  );
}

function DeferredCodeBlock({
  className,
  value,
  copyUseModifier,
  languageLabel,
  lineCount,
}: DeferredCodeBlockProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [copiedMode, setCopiedMode] = useState<"plain" | "fenced" | null>(null);
  const copyTimeoutRef = useRef<number | null>(null);
  const languageTag = extractLanguageTag(className);
  const fencedValue = `\`\`\`${languageTag ?? ""}\n${value}\n\`\`\``;

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        window.clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const commitCopiedMode = (mode: "plain" | "fenced") => {
    setCopiedMode(mode);
    if (copyTimeoutRef.current) {
      window.clearTimeout(copyTimeoutRef.current);
    }
    copyTimeoutRef.current = window.setTimeout(() => {
      setCopiedMode(null);
    }, 1200);
  };

  const handleCopy = async (event: MouseEvent<HTMLButtonElement>) => {
    try {
      const nextValue = copyUseModifier && event.altKey ? fencedValue : value;
      await navigator.clipboard.writeText(nextValue);
      commitCopiedMode(nextValue === fencedValue ? "fenced" : "plain");
    } catch {
      // No-op: clipboard errors can occur in restricted contexts.
    }
  };

  const handleCopyFenced = async () => {
    try {
      await navigator.clipboard.writeText(fencedValue);
      commitCopiedMode("fenced");
    } catch {
      // No-op: clipboard errors can occur in restricted contexts.
    }
  };

  if (expanded) {
    return (
      <CodeBlock
        className={className}
        value={value}
        copyUseModifier={copyUseModifier}
      />
    );
  }

  return (
    <div className="markdown-codeblock markdown-heavy-island-placeholder">
      <div className="markdown-codeblock-header">
        <span className="markdown-codeblock-language">{languageLabel}</span>
        <div className="markdown-codeblock-actions">
          <button
            type="button"
            className={`ghost markdown-codeblock-copy${copiedMode === "plain" ? " is-copied" : ""}`}
            onClick={handleCopy}
            aria-label={t("messages.copyCodeBlock")}
            title={copiedMode === "plain" ? t("messages.copied") : t("messages.copy")}
          >
            {copiedMode === "plain" ? t("messages.copied") : t("messages.copy")}
          </button>
          <button
            type="button"
            className={`ghost markdown-codeblock-copy${copiedMode === "fenced" ? " is-copied" : ""}`}
            onClick={handleCopyFenced}
            aria-label={t("messages.copyCodeBlockWithFence")}
            title={copiedMode === "fenced" ? t("messages.copied") : t("messages.copyWithFence")}
          >
            {copiedMode === "fenced" ? t("messages.copied") : t("messages.copyWithFence")}
          </button>
        </div>
      </div>
      <div className="markdown-heavy-island-placeholder-body">
        <strong>{t("messages.markdownHeavyBlockDeferred")}</strong>
        <span>
          {t("messages.markdownHeavyBlockMeta", {
            kind: languageLabel,
            lines: lineCount,
          })}
        </span>
        <button type="button" onClick={() => setExpanded(true)}>
          {t("messages.markdownHeavyBlockShow")}
        </button>
      </div>
    </div>
  );
}

function MarkdownBlock({
  className,
  value,
  copyUseModifier,
  workspaceId,
  onOpenFileLink,
  onOpenFileLinkMenu,
}: CodeBlockProps & Pick<PreProps, "workspaceId" | "onOpenFileLink" | "onOpenFileLinkMenu">) {
  const { t } = useTranslation();
  const [copiedMode, setCopiedMode] = useState<"plain" | "fenced" | null>(null);
  const copyTimeoutRef = useRef<number | null>(null);
  const languageTag = extractLanguageTag(className);
  const languageLabel = (languageTag ?? "markdown").toUpperCase();
  const fencedValue = `\`\`\`${languageTag ?? "markdown"}\n${value}\n\`\`\``;

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        window.clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const handleCopy = async (event: MouseEvent<HTMLButtonElement>) => {
    try {
      const nextValue = copyUseModifier && event.altKey ? fencedValue : value;
      await navigator.clipboard.writeText(nextValue);
      setCopiedMode(nextValue === fencedValue ? "fenced" : "plain");
      if (copyTimeoutRef.current) {
        window.clearTimeout(copyTimeoutRef.current);
      }
      copyTimeoutRef.current = window.setTimeout(() => {
        setCopiedMode(null);
      }, 1200);
    } catch {
      // No-op: clipboard errors can occur in restricted contexts.
    }
  };

  const handleCopyFenced = async () => {
    try {
      await navigator.clipboard.writeText(fencedValue);
      setCopiedMode("fenced");
      if (copyTimeoutRef.current) {
        window.clearTimeout(copyTimeoutRef.current);
      }
      copyTimeoutRef.current = window.setTimeout(() => {
        setCopiedMode(null);
      }, 1200);
    } catch {
      // No-op: clipboard errors can occur in restricted contexts.
    }
  };

  return (
    <div className="markdown-codeblock markdown-codeblock-markdown">
      <div className="markdown-codeblock-header">
        <span className="markdown-codeblock-language">{languageLabel}</span>
        <div className="markdown-codeblock-actions">
          <button
            type="button"
            className={`ghost markdown-codeblock-copy${copiedMode === "plain" ? " is-copied" : ""}`}
            onClick={handleCopy}
            aria-label={t("messages.copyCodeBlock")}
            title={copiedMode === "plain" ? t("messages.copied") : t("messages.copy")}
          >
            {copiedMode === "plain" ? t("messages.copied") : t("messages.copy")}
          </button>
          <button
            type="button"
            className={`ghost markdown-codeblock-copy${copiedMode === "fenced" ? " is-copied" : ""}`}
            onClick={handleCopyFenced}
            aria-label={t("messages.copyCodeBlockWithFence")}
            title={copiedMode === "fenced" ? t("messages.copied") : t("messages.copyWithFence")}
          >
            {copiedMode === "fenced" ? t("messages.copied") : t("messages.copyWithFence")}
          </button>
        </div>
      </div>
      <div className="markdown-codeblock-markdown-content">
        <Markdown
          value={value}
          className="markdown markdown-codeblock-markdown-rendered"
          workspaceId={workspaceId}
          codeBlockStyle="message"
          codeBlockCopyUseModifier={copyUseModifier}
          streamingThrottleMs={0}
          onOpenFileLink={onOpenFileLink}
          onOpenFileLinkMenu={onOpenFileLinkMenu}
        />
      </div>
    </div>
  );
}

function LatexBlock({ className, value, copyUseModifier }: CodeBlockProps) {
  const { t } = useTranslation();
  const [copiedMode, setCopiedMode] = useState<"plain" | "fenced" | null>(null);
  const copyTimeoutRef = useRef<number | null>(null);
  const languageTag = extractLanguageTag(className);
  const languageLabel = languageTag ? languageTag.toUpperCase() : "LaTeX";
  const fencedValue = `\`\`\`${languageTag ?? "latex"}\n${value}\n\`\`\``;
  const entries = useMemo(
    () => buildLatexRenderEntries(value),
    [value],
  );
  const [katexReady, setKatexReady] = useState(
    () => isKatexRenderReady(),
  );
  useEffect(() => {
    if (katexReady) return;
    let cancelled = false;
    loadKatexAssets().then(() => {
      if (cancelled) return;
      startTransition(() => setKatexReady(true));
    });
    return () => {
      cancelled = true;
    };
  }, [katexReady]);
  const renderedEntries = useMemo(
    () => entries.map((entry) => (
      entry.kind === "label"
        ? { ...entry }
        : { ...entry, html: katexReady ? renderLatexFormula(entry.source) : null }
    )),
    [entries, katexReady],
  );
  const hasFormulaRenderFailure = renderedEntries.some(
    (entry) => entry.kind === "formula" && !entry.html,
  );

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        window.clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const handleCopy = async (event: MouseEvent<HTMLButtonElement>) => {
    try {
      const nextValue = copyUseModifier && event.altKey ? fencedValue : value;
      await navigator.clipboard.writeText(nextValue);
      setCopiedMode(nextValue === fencedValue ? "fenced" : "plain");
      if (copyTimeoutRef.current) {
        window.clearTimeout(copyTimeoutRef.current);
      }
      copyTimeoutRef.current = window.setTimeout(() => {
        setCopiedMode(null);
      }, 1200);
    } catch {
      // No-op: clipboard errors can occur in restricted contexts.
    }
  };

  const handleCopyFenced = async () => {
    try {
      await navigator.clipboard.writeText(fencedValue);
      setCopiedMode("fenced");
      if (copyTimeoutRef.current) {
        window.clearTimeout(copyTimeoutRef.current);
      }
      copyTimeoutRef.current = window.setTimeout(() => {
        setCopiedMode(null);
      }, 1200);
    } catch {
      // No-op: clipboard errors can occur in restricted contexts.
    }
  };

  if (hasFormulaRenderFailure) {
    return (
      <CodeBlock
        className={className}
        value={value}
        copyUseModifier={copyUseModifier}
      />
    );
  }

  return (
    <div className="markdown-codeblock markdown-latexblock">
      <div className="markdown-codeblock-header">
        <span className="markdown-codeblock-language">{languageLabel}</span>
        <div className="markdown-codeblock-actions">
          <button
            type="button"
            className={`ghost markdown-codeblock-copy${copiedMode === "plain" ? " is-copied" : ""}`}
            onClick={handleCopy}
            aria-label={t("messages.copyCodeBlock")}
            title={copiedMode === "plain" ? t("messages.copied") : t("messages.copy")}
          >
            {copiedMode === "plain" ? t("messages.copied") : t("messages.copy")}
          </button>
          <button
            type="button"
            className={`ghost markdown-codeblock-copy${copiedMode === "fenced" ? " is-copied" : ""}`}
            onClick={handleCopyFenced}
            aria-label={t("messages.copyCodeBlockWithFence")}
            title={copiedMode === "fenced" ? t("messages.copied") : t("messages.copyWithFence")}
          >
            {copiedMode === "fenced" ? t("messages.copied") : t("messages.copyWithFence")}
          </button>
        </div>
      </div>
      <div className="markdown-latexblock-content">
        {renderedEntries.map((entry, index) => (
          entry.kind === "label" ? (
            <p
              key={`latex-label-${index}-${entry.text}`}
              className="markdown-latexblock-label"
            >
              {entry.text}
            </p>
          ) : (
            <div
              key={`latex-formula-${index}`}
              className="markdown-latexblock-formula"
              dangerouslySetInnerHTML={{ __html: entry.html ?? "" }}
            />
          )
        ))}
      </div>
    </div>
  );
}

function MermaidFallback() {
  return (
    <div className="markdown-codeblock markdown-mermaidblock">
      <div className="markdown-codeblock-header">
        <span className="markdown-codeblock-language">Mermaid</span>
      </div>
      <div className="markdown-mermaidblock-loading">Loading...</div>
    </div>
  );
}

function extractMermaidContent(languageTag: string | null, value: string): string | null {
  // Case 1: react-markdown correctly parsed the language tag
  if (languageTag === "mermaid" && value.trim()) {
    return value;
  }
  // Case 2: fenced marker leaked into the content (e.g. ```mermaid\n...\n```)
  const fencedMatch = value.match(/^```mermaid\s*\n([\s\S]*?)(?:\n```\s*)?$/);
  if (fencedMatch) {
    const inner = (fencedMatch[1] ?? "").trim();
    if (inner) return inner;
  }
  return null;
}

function flattenNodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(flattenNodeText).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return flattenNodeText(node.props?.children);
  }
  return "";
}

function countMarkdownTableRowsFromNode(node: unknown): number {
  if (!node || typeof node !== "object") {
    return 0;
  }
  const record = node as {
    tagName?: string;
    children?: unknown[];
  };
  const ownCount = record.tagName === "tr" ? 1 : 0;
  const childCount = Array.isArray(record.children)
    ? record.children.reduce<number>(
      (total, child) => total + countMarkdownTableRowsFromNode(child),
      0,
    )
    : 0;
  return ownCount + childCount;
}

function DeferredMarkdownTable({ children, rowCount }: DeferredMarkdownTableProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  if (expanded) {
    return <table>{children}</table>;
  }
  return (
    <div className="markdown-heavy-island-placeholder markdown-heavy-table-placeholder">
      <div className="markdown-heavy-island-placeholder-body">
        <strong>{t("messages.markdownHeavyBlockDeferred")}</strong>
        <span>
          {t("messages.markdownHeavyBlockMeta", {
            kind: t("messages.markdownHeavyBlockTable"),
            lines: rowCount,
          })}
        </span>
        <button type="button" onClick={() => setExpanded(true)}>
          {t("messages.markdownHeavyBlockShow")}
        </button>
      </div>
    </div>
  );
}

function extractAlertToneFromNode(node: ReactNode): string | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const tone = extractAlertToneFromNode(child);
      if (tone) {
        return tone;
      }
    }
    return null;
  }
  if (!isValidElement<{ className?: string; children?: ReactNode }>(node)) {
    return null;
  }
  const className = typeof node.props?.className === "string" ? node.props.className : "";
  const toneMatch = className.match(/\bmarkdown-alert-label-(note|tip|important|warning|caution)\b/);
  if (toneMatch?.[1]) {
    return toneMatch[1];
  }
  return extractAlertToneFromNode(node.props?.children);
}

function PreBlock({
  node,
  children,
  copyUseModifier,
  sourceMarkdown,
  workspaceId,
  onOpenFileLink,
  onOpenFileLinkMenu,
}: PreProps) {
  const { className, value } = extractCodeFromPre(node);
  if (!className && !value && children) {
    return <pre>{children}</pre>;
  }
  const urlLines = extractUrlLines(value);
  if (urlLines) {
    return <LinkBlock urls={urlLines} />;
  }
  const languageTag = extractLanguageTag(className);
  const markdownContent = extractMarkdownContent(languageTag, value ?? "");
  if (markdownContent && shouldRenderMarkdownFenceAsCard(node, sourceMarkdown)) {
    return (
      <MarkdownBlock
        className={className}
        value={markdownContent}
        copyUseModifier={copyUseModifier}
        workspaceId={workspaceId}
        onOpenFileLink={onOpenFileLink}
        onOpenFileLinkMenu={onOpenFileLinkMenu}
      />
    );
  }
  const mermaidContent = extractMermaidContent(languageTag, value ?? "");
  if (mermaidContent) {
    return (
      <Suspense fallback={<MermaidFallback />}>
        <MermaidBlock value={mermaidContent} copyUseModifier={copyUseModifier} />
      </Suspense>
    );
  }
  const latexContent = extractLatexContent(languageTag, value ?? "");
  if (latexContent) {
    return (
      <LatexBlock
        className={className}
        value={latexContent}
        copyUseModifier={copyUseModifier}
      />
    );
  }
  const isSingleLine = !value.includes("\n");
  if (isSingleLine) {
    const highlightedHtml = highlightLine(value, languageTag);
    return (
      <pre className="markdown-codeblock-single">
        <code
          className={className}
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
        />
      </pre>
    );
  }
  const codeLineCount = value.split(/\r?\n/).length;
  if (
    codeLineCount >= HEAVY_CODE_BLOCK_MIN_LINES ||
    value.length >= HEAVY_CODE_BLOCK_MIN_CHARS
  ) {
    return (
      <DeferredCodeBlock
        className={className}
        value={value}
        copyUseModifier={copyUseModifier}
        languageLabel={languageTag ?? "Code"}
        lineCount={codeLineCount}
      />
    );
  }
  return (
    <CodeBlock
      className={className}
      value={value}
      copyUseModifier={copyUseModifier}
    />
  );
}

export const Markdown = memo(function Markdown({
  value,
  className,
  workspaceId = null,
  codeBlock,
  codeBlockStyle = "default",
  codeBlockCopyUseModifier = false,
  streamingThrottleMs = 80,
  softBreaks = false,
  preserveFormatting = false,
  liveRenderMode = "full",
  progressiveReveal = false,
  progressiveRevealStepMs = PROGRESSIVE_REVEAL_STEP_MS,
  progressiveRevealChunkChars = PROGRESSIVE_REVEAL_CHUNK_CHARS,
  codexLeadMarkerConfig,
  onOpenFileLink,
  onOpenFileLinkMenu,
  onRenderedValueChange,
  onOutlineReady,
}: MarkdownProps) {
  // Throttle rapid value changes during streaming to reduce expensive
  // ReactMarkdown re-parses that block the main thread and cause input lag.
  //
  // Strategy: keep the latest value in a ref and schedule a single timer
  // that fires every THROTTLE_MS. The timer reads from the ref so it
  // always renders the most recent content, even if many updates arrived
  // between ticks. This prevents the timer-cancellation starvation that
  // occurs when every value change cancels and reschedules the timer
  // (on Windows the events can arrive faster than the throttle window,
  // causing the deferred update to never execute).
  const [throttledValue, setThrottledValue] = useState(value);
  const [imageFullscreen, setImageFullscreen] = useState<{
    src: string;
    alt: string;
  } | null>(null);
  const lastUpdateRef = useRef(Date.now());
  const outlineCacheRef = useRef<{
    value: string;
    outline: MarkdownOutlineEntry[];
  } | null>(null);

  // Best-effort outline extraction for the floater. We use a lightweight
  // line-by-line scan over the raw markdown value (NOT the rendered
  // HAST) because the messages surface does not run the fast pipeline;
  // the floater only needs heading title + depth + source line, and
  // extracting from raw markdown keeps the cost bounded. We do NOT
  // extend `MarkdownOutlineEntry` (its id/startLine/endLine/anchor
  // fields are sufficient; we just compute them locally). If the
  // consumer does not pass `onOutlineReady`, the work is a no-op.
  useEffect(() => {
    if (!onOutlineReady) {
      return;
    }
    const cachedOutline = outlineCacheRef.current;
    const outline =
      cachedOutline?.value === throttledValue
        ? cachedOutline.outline
        : extractOutlineFromMarkdown(throttledValue);
    if (cachedOutline?.value !== throttledValue) {
      outlineCacheRef.current = {
        value: throttledValue,
        outline,
      };
    }
    try {
      onOutlineReady(outline);
    } catch {
      // consumer-side callback must not break the renderer
    }
  }, [throttledValue, onOutlineReady]);
  const throttleTimerRef = useRef<number>(0);
  const mountedRef = useRef(true);
  const latestValueRef = useRef(value);
  const previousThrottleMsRef = useRef(Math.max(0, streamingThrottleMs));
  const resolvedThrottleMs = Math.max(0, streamingThrottleMs);
  latestValueRef.current = value;
  const scheduleThrottledValueUpdate = useCallback((nextValue: string) => {
    startTransition(() => {
      setThrottledValue((currentValue) => (
        currentValue === nextValue ? currentValue : nextValue
      ));
    });
  }, []);

  useEffect(() => {
    const now = Date.now();
    if (previousThrottleMsRef.current !== resolvedThrottleMs) {
      previousThrottleMsRef.current = resolvedThrottleMs;
      if (throttleTimerRef.current) {
        window.clearTimeout(throttleTimerRef.current);
        throttleTimerRef.current = 0;
      }
      scheduleThrottledValueUpdate(value);
      lastUpdateRef.current = now;
      return;
    }
    const elapsed = now - lastUpdateRef.current;
    if (resolvedThrottleMs === 0) {
      scheduleThrottledValueUpdate(value);
      lastUpdateRef.current = now;
      return;
    }
    // If enough time has passed, update immediately
    if (elapsed >= resolvedThrottleMs) {
      scheduleThrottledValueUpdate(value);
      lastUpdateRef.current = now;
      return;
    }
    // A timer is already pending — it will read latestValueRef when it fires,
    // so there is nothing else to do.
    if (throttleTimerRef.current) {
      return;
    }
    // Schedule a deferred flush. This timer is NOT cancelled when value
    // changes; it will fire once and read the latest value from the ref.
    throttleTimerRef.current = window.setTimeout(() => {
      throttleTimerRef.current = 0;
      if (!mountedRef.current || typeof window === "undefined") {
        return;
      }
      scheduleThrottledValueUpdate(latestValueRef.current);
      lastUpdateRef.current = Date.now();
    }, resolvedThrottleMs - elapsed);
  }, [resolvedThrottleMs, scheduleThrottledValueUpdate, value]);

  // Clean up only on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (throttleTimerRef.current) {
        window.clearTimeout(throttleTimerRef.current);
        throttleTimerRef.current = 0;
      }
    };
  }, []);

  const resolvedProgressiveStepMs = normalizeProgressiveRevealStepMs(
    progressiveRevealStepMs,
  );
  const resolvedProgressiveChunkChars = normalizeProgressiveRevealChunkChars(
    progressiveRevealChunkChars,
  );
  const [progressiveValue, setProgressiveValue] = useState(() => (
    progressiveReveal
      ? resolveProgressiveRevealValue(
        "",
        value,
        resolvedProgressiveChunkChars,
      )
      : value
  ));
  const progressiveTimerRef = useRef<number>(0);
  const latestProgressiveTargetRef = useRef(value);
  const previousProgressiveRevealRef = useRef(progressiveReveal);
  const scheduleProgressiveValueUpdate = useCallback(
    (
      updater: string | ((currentValue: string) => string),
    ) => {
      startTransition(() => {
        setProgressiveValue((currentValue) => {
          const nextValue = typeof updater === "function"
            ? updater(currentValue)
            : updater;
          return nextValue === currentValue ? currentValue : nextValue;
        });
      });
    },
    [],
  );

  useEffect(() => {
    if (!progressiveReveal) {
      if (progressiveTimerRef.current) {
        window.clearTimeout(progressiveTimerRef.current);
        progressiveTimerRef.current = 0;
      }
      latestProgressiveTargetRef.current = throttledValue;
      scheduleProgressiveValueUpdate(throttledValue);
      previousProgressiveRevealRef.current = false;
      return;
    }

    latestProgressiveTargetRef.current = throttledValue;
    scheduleProgressiveValueUpdate((currentValue) => {
      const wasProgressiveReveal = previousProgressiveRevealRef.current;
      previousProgressiveRevealRef.current = true;
      if (!wasProgressiveReveal) {
        return resolveProgressiveRevealValue(
          "",
          throttledValue,
          resolvedProgressiveChunkChars,
        );
      }
      const nextValue = resolveProgressiveRevealValue(
        currentValue,
        throttledValue,
        resolvedProgressiveChunkChars,
      );
      return nextValue === currentValue ? currentValue : nextValue;
    });
  }, [
    progressiveReveal,
    resolvedProgressiveChunkChars,
    scheduleProgressiveValueUpdate,
    throttledValue,
  ]);

  useEffect(() => {
    if (!progressiveReveal) {
      return undefined;
    }
    if (progressiveValue === latestProgressiveTargetRef.current) {
      return undefined;
    }
    if (progressiveTimerRef.current) {
      return undefined;
    }
    const pendingTextLength = Math.max(
      0,
      latestProgressiveTargetRef.current.length - progressiveValue.length,
    );
    const adaptiveStepMs = resolveAdaptiveProgressiveRevealStepMs(
      progressiveValue.length,
      pendingTextLength,
      resolvedProgressiveStepMs,
    );
    progressiveTimerRef.current = window.setTimeout(() => {
      progressiveTimerRef.current = 0;
      if (!mountedRef.current) {
        return;
      }
      scheduleProgressiveValueUpdate((currentValue) => {
        const nextValue = resolveProgressiveRevealValue(
          currentValue,
          latestProgressiveTargetRef.current,
          resolvedProgressiveChunkChars,
        );
        return nextValue === currentValue ? currentValue : nextValue;
      });
    }, adaptiveStepMs);
    return undefined;
  }, [
    progressiveReveal,
    progressiveValue,
    resolvedProgressiveChunkChars,
    resolvedProgressiveStepMs,
    scheduleProgressiveValueUpdate,
  ]);

  useEffect(() => {
    return () => {
      if (progressiveTimerRef.current) {
        window.clearTimeout(progressiveTimerRef.current);
        progressiveTimerRef.current = 0;
      }
    };
  }, []);

  const renderValue = progressiveReveal ? progressiveValue : throttledValue;

  useEffect(() => {
    onRenderedValueChange?.(renderValue);
  }, [onRenderedValueChange, renderValue]);

  // Memoize heavy text normalization to avoid re-running on every render
  const content = useMemo(() => {
    if (codeBlock) {
      return `\`\`\`\n${renderValue}\n\`\`\``;
    }
    if (preserveFormatting) {
      return renderValue;
    }
    if (liveRenderMode === "lightweight") {
      return renderValue.replace(/\r\n/g, "\n");
    }
    const normalizeDisplayText = (text: string) =>
      normalizeImageTags(
        normalizeMarkdownMathForMessage(
          normalizeFragmentedResourceReferences(
            normalizeListIndentation(
              normalizeInlineOrderedListBreaks(
                normalizeGithubBlockquoteAlerts(
                  normalizeFragmentedLineBreaks(normalizeFragmentedParagraphBreaks(text)),
                ),
              ),
            ),
          ),
        ),
      );
    return normalizeOutsideMarkdownCode(renderValue, normalizeDisplayText);
  }, [renderValue, codeBlock, liveRenderMode, preserveFormatting]);
  const markdownHeavyIslandSummary = useMemo(
    () => classifyMessageMarkdownHeavyIslands(content),
    [content],
  );
  const shouldDeferMarkdownHeavyIslands =
    liveRenderMode !== "lightweight" &&
    !codeBlock &&
    markdownHeavyIslandSummary.totalHeavyIslands > 0;
  const toolCallBlocks = useMemo(() => parseToolCallBlocks(content), [content]);
  const shouldRenderToolCallSegments = !(
    toolCallBlocks.length === 1 && toolCallBlocks[0]?.kind === "md"
  );
  const sourceMarkdownRef = useRef(content);
  sourceMarkdownRef.current = content;

  // Stable callback refs for file link handlers
  const onOpenFileLinkRef = useRef(onOpenFileLink);
  onOpenFileLinkRef.current = onOpenFileLink;
  const onOpenFileLinkMenuRef = useRef(onOpenFileLinkMenu);
  onOpenFileLinkMenuRef.current = onOpenFileLinkMenu;

  const handleFileLinkClick = useCallback((event: React.MouseEvent, path: string) => {
    event.preventDefault();
    event.stopPropagation();
    onOpenFileLinkRef.current?.(path);
  }, []);
  const handleFileLinkContextMenu = useCallback((
    event: React.MouseEvent,
    path: string,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    onOpenFileLinkMenuRef.current?.(event, path);
  }, []);

  // Memoize ReactMarkdown components to prevent full re-initialization on every render.
  // This is critical: when components/plugins change reference, ReactMarkdown
  // discards its entire internal HAST tree and re-parses from scratch.
  const enableCodexLeadEnhancement = className?.includes("markdown-codex-canvas") ?? false;
  const components = useMemo<FullMarkdownComponents>(() => {
    const result: FullMarkdownComponents = {
      a: ({ href, children }) => {
        const url = href ?? "";
        if (isFileLinkUrl(url)) {
          const path = decodeFileLink(url);
          return (
            <a
              href={href}
              onClick={(event) => handleFileLinkClick(event, path)}
              onContextMenu={(event) => handleFileLinkContextMenu(event, path)}
            >
              {children}
            </a>
          );
        }
        const localFilePath = resolveLocalFileHref(url);
        if (localFilePath) {
          return (
            <a
              href={href}
              onClick={(event) => handleFileLinkClick(event, localFilePath)}
              onContextMenu={(event) =>
                handleFileLinkContextMenu(event, localFilePath)
              }
            >
              {children}
            </a>
          );
        }
        const isExternal =
          url.startsWith("http://") ||
          url.startsWith("https://") ||
          url.startsWith("mailto:");

        if (!isExternal) {
          return <a href={href}>{children}</a>;
        }

        return (
          <a
            href={href}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void openUrl(url);
            }}
          >
            {children}
          </a>
        );
      },
      code: ({ className: codeClassName, children }) => {
        if (codeClassName) {
          return <code className={codeClassName}>{children}</code>;
        }
        const text = flattenNodeText(children).trim();
        const inlineCode = <InlineCode text={text}>{children}</InlineCode>;
        if (!text || !isLinkableFilePath(text)) {
          return inlineCode;
        }
        const href = toFileLink(text);
        return (
          <a
            href={href}
            onClick={(event) => handleFileLinkClick(event, text)}
            onContextMenu={(event) => handleFileLinkContextMenu(event, text)}
          >
            {inlineCode}
          </a>
        );
      },
      img: ({ src, alt, ...props }) => {
        const imageProps = props as ImgHTMLAttributes<HTMLImageElement>;
        const fallbackLocalPath = normalizeImageLocalPath(src ?? "");
        const normalizedSrc = normalizeMarkdownImageSrc(src ?? "");
        if (!normalizedSrc) {
          return null;
        }
        return (
          <LocalImage
            {...imageProps}
            src={normalizedSrc}
            localPath={fallbackLocalPath}
            workspaceId={workspaceId}
            alt={alt ?? "image"}
            loading="lazy"
            onClick={() =>
              setImageFullscreen({
                src: normalizedSrc,
                alt: alt ?? "image",
              })
            }
          />
        );
      },
      table: ({ node, children }) => {
        const rowCount = countMarkdownTableRowsFromNode(node);
        if (!shouldDeferMarkdownHeavyIslands || rowCount < HEAVY_TABLE_MIN_ROWS) {
          return <table>{children}</table>;
        }
        return (
          <DeferredMarkdownTable rowCount={rowCount}>
            {children}
          </DeferredMarkdownTable>
        );
      },
    };

    if (enableCodexLeadEnhancement) {
      result.p = ({ children }) => {
        const plainText = flattenNodeText(children);
        const lead = detectCodexLeadMarker(plainText, codexLeadMarkerConfig);
        if (!lead) {
          return <p>{children}</p>;
        }
        return (
          <p className={`markdown-lead-paragraph markdown-lead-${lead.tone}`}>
            <span className="markdown-lead-icon" aria-hidden>{lead.icon}</span>
            <span className="markdown-lead-text">{children}</span>
          </p>
        );
      };
    }

    if (codeBlockStyle === "message") {
      result.pre = ({ node, children }) => (
        <PreBlock
          node={node as PreProps["node"]}
          copyUseModifier={codeBlockCopyUseModifier}
          sourceMarkdown={sourceMarkdownRef.current}
          workspaceId={workspaceId}
          onOpenFileLink={onOpenFileLink}
          onOpenFileLinkMenu={onOpenFileLinkMenu}
        >
          {children}
        </PreBlock>
      );
    }

    result.blockquote = ({ children }) => {
      const alertTone = extractAlertToneFromNode(children);
      return (
        <blockquote className={alertTone ? `markdown-alert markdown-alert-${alertTone}` : undefined}>
          {children}
        </blockquote>
      );
    };

    return result;
  }, [
    handleFileLinkClick,
    handleFileLinkContextMenu,
    enableCodexLeadEnhancement,
    codexLeadMarkerConfig,
    codeBlockStyle,
    codeBlockCopyUseModifier,
    onOpenFileLink,
    onOpenFileLinkMenu,
    shouldDeferMarkdownHeavyIslands,
    workspaceId,
  ]);

  const hasMathContent = useMemo(() => detectMathContent(value), [value]);
  const markdownPrecomputeOptionsHash = useMemo(() => createMessageMarkdownOptionsHash({
    codexLeadEnhanced: enableCodexLeadEnhancement,
    codeBlockStyle,
    hasFileLinkHandlers: Boolean(onOpenFileLink || onOpenFileLinkMenu),
    hasMathContent,
    preserveFormatting,
    softBreaks,
  }), [
    codeBlockStyle,
    enableCodexLeadEnhancement,
    hasMathContent,
    onOpenFileLink,
    onOpenFileLinkMenu,
    preserveFormatting,
    softBreaks,
  ]);
  useEffect(() => {
    if (liveRenderMode === "lightweight" || codeBlock) {
      return undefined;
    }
    const request = createMessageMarkdownPrecomputeRequest({
      messageId: workspaceId ? `workspace:${workspaceId}` : "message:unknown",
      source: content,
      optionsHash: markdownPrecomputeOptionsHash,
    });
    let cancelled = false;
    void runMessageMarkdownPrecompute(request).then((result) => {
      if (cancelled) {
        return;
      }
      if (isStaleMessageMarkdownPrecomputeResult(result, request)) {
        appendMarkdownPrecomputeDiagnostic({
          mode: result.mode,
          durationMs: result.durationMs,
          contentLength: result.sourceLength,
          contentHash: result.contentHash,
          thresholdReason: result.thresholdReason,
          cacheState: result.cacheState,
          fallbackReason: "stale-drop",
          evidenceClass: "proxy",
          heavyCategoryCounts: markdownHeavyIslandSummary.categoryCounts,
          totalHeadings: result.precomputeResult?.totalHeadings,
          totalHeavyBlocks: result.precomputeResult?.totalHeavyBlocks,
          totalSourceLines: result.precomputeResult?.totalSourceLines,
        });
        return;
      }
      appendMarkdownPrecomputeDiagnostic({
        mode: result.mode,
        durationMs: result.durationMs,
        contentLength: result.sourceLength,
        contentHash: result.contentHash,
        thresholdReason: result.thresholdReason,
        cacheState: result.cacheState,
        fallbackReason: result.fallbackReason,
        evidenceClass: result.evidenceClass,
        heavyCategoryCounts: markdownHeavyIslandSummary.categoryCounts,
        totalHeadings: result.precomputeResult?.totalHeadings,
        totalHeavyBlocks: result.precomputeResult?.totalHeavyBlocks,
        totalSourceLines: result.precomputeResult?.totalSourceLines,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [
    codeBlock,
    content,
    liveRenderMode,
    markdownPrecomputeOptionsHash,
    markdownHeavyIslandSummary.categoryCounts,
    workspaceId,
  ]);
  const [katexReady, setKatexReady] = useState(
    () => areKatexAssetsReady(),
  );
  useEffect(() => {
    if (!hasMathContent || katexReady) return;
    let cancelled = false;
    loadKatexAssets().then(() => {
      if (cancelled) return;
      startTransition(() => setKatexReady(true));
    });
    return () => {
      cancelled = true;
    };
  }, [hasMathContent, katexReady]);
  const urlTransform = useCallback<FullMarkdownUrlTransform>((url: string) => {
    const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url);
    if (
      isFileLinkUrl(url) ||
      url.startsWith("http://") ||
      url.startsWith("https://") ||
      url.startsWith("file://") ||
      url.startsWith("mailto:") ||
      url.startsWith("#") ||
      url.startsWith("/") ||
      url.startsWith("./") ||
      url.startsWith("../") ||
      /^[A-Za-z]:[\\/]/.test(url)
    ) {
      return url;
    }
    if (!hasScheme) {
      return url;
    }
    return "";
  }, []);
  const renderLightweightLink = useCallback<LightweightMarkdownLinkRenderer>(
    ({ href, children }) => {
      const safeHref = urlTransform(href);
      if (!safeHref) {
        return <>{children}</>;
      }
      if (isFileLinkUrl(safeHref)) {
        const path = decodeFileLink(safeHref);
        return (
          <a
            href={safeHref}
            onClick={(event) => handleFileLinkClick(event, path)}
            onContextMenu={(event) => handleFileLinkContextMenu(event, path)}
          >
            {children}
          </a>
        );
      }
      const localFilePath = resolveLocalFileHref(safeHref);
      if (localFilePath) {
        return (
          <a
            href={safeHref}
            onClick={(event) => handleFileLinkClick(event, localFilePath)}
            onContextMenu={(event) => handleFileLinkContextMenu(event, localFilePath)}
          >
            {children}
          </a>
        );
      }
      const isExternal =
        safeHref.startsWith("http://") ||
        safeHref.startsWith("https://") ||
        safeHref.startsWith("mailto:");
      if (!isExternal) {
        return <a href={safeHref}>{children}</a>;
      }
      return (
        <a
          href={safeHref}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void openUrl(safeHref);
          }}
        >
          {children}
        </a>
      );
    },
    [handleFileLinkClick, handleFileLinkContextMenu, urlTransform],
  );

  const renderMarkdownContent = useCallback((nextContent: string) => {
    const hasSyntaxIncompleteInlineCode =
      getMarkdownInlineCodeInfo(nextContent).hasUnclosedInlineCode;
    const shouldUseStreamingInlineCodeFallback =
      streamingThrottleMs !== undefined &&
      hasSyntaxIncompleteInlineCode &&
      TOOL_CALL_XML_CANDIDATE_REGEX.test(nextContent);
    if (liveRenderMode === "lightweight" || shouldUseStreamingInlineCodeFallback) {
      return (
        <LightweightMarkdown
          value={nextContent}
          renderLink={renderLightweightLink}
        />
      );
    }
    return (
      <Suspense
        fallback={(
          <LightweightMarkdown
            value={nextContent}
            renderLink={renderLightweightLink}
          />
        )}
      >
        <FullMarkdownRuntime
          value={nextContent}
          softBreaks={softBreaks}
          katexReady={katexReady}
          urlTransform={urlTransform}
          components={components}
        />
      </Suspense>
    );
  }, [
    components,
    katexReady,
    liveRenderMode,
    renderLightweightLink,
    softBreaks,
    streamingThrottleMs,
    urlTransform,
  ]);

  return (
    <div className={className}>
      <ImageFullscreenViewer
        open={!!imageFullscreen}
        src={imageFullscreen?.src ?? ""}
        alt={imageFullscreen?.alt}
        workspaceId={workspaceId}
        onClose={() => setImageFullscreen(null)}
      />
      {shouldRenderToolCallSegments
        ? toolCallBlocks.map((block, index) => {
          if (block.kind === "md") {
            return (
              <Fragment key={`md-${index}`}>
                {renderMarkdownContent(block.content)}
              </Fragment>
            );
          }
          return (
            <ToolCallBlock
              key={buildToolCallBlockKey(block)}
              raw={block.raw}
              tool={block.tool}
              params={block.params}
              complete={block.complete}
              isLive={!block.complete}
            />
          );
        })
        : renderMarkdownContent(content)}
    </div>
  );
}, areMarkdownPropsEqual);
