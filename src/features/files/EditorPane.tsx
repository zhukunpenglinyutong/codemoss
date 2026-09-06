import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import type { Extension } from "@codemirror/state";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { Pluggable } from "unified";
import { useTranslation } from "react-i18next";
import Eye from "lucide-react/dist/esm/icons/eye";
import PencilLine from "lucide-react/dist/esm/icons/pencil-line";
import Save from "lucide-react/dist/esm/icons/save";
import { ipc, type FileContent } from "@/lib/ipc";
import { errorText } from "@/lib/errors";
import { Button } from "@/components/base/buttons/button";
import { CenteredSpinner, EmptyState } from "@/components/base/empty-state";
import { cx } from "@/utils/cx";
import { fileName, useFilesStore } from "./store";

const MARKDOWN_RE = /\.(md|markdown)$/i;
const REMARK_PLUGINS = [remarkGfm];
// rehype-raw parses inline HTML (<div align>, <img>, badges); sanitize keeps
// it safe; highlight runs last so its classes survive sanitization.
const REHYPE_PLUGINS: Pluggable[] = [
  rehypeRaw,
  [
    rehypeSanitize,
    {
      ...defaultSchema,
      tagNames: [
        ...(defaultSchema.tagNames ?? []),
        "details",
        "summary",
        "abbr",
        "mark",
        "ins",
        "del",
        "sub",
        "sup",
        "kbd",
        "var",
        "samp",
      ],
      attributes: {
        ...defaultSchema.attributes,
        "*": [...(defaultSchema.attributes?.["*"] ?? []), "className", "class"],
      },
    },
  ],
  rehypeHighlight,
];
const CM_BASIC_SETUP = { foldGutter: false, highlightActiveLine: true };
const BROWSER_LOADABLE_SRC_RE = /^(?:https?:|data:|blob:|asset:)/i;

function normalizePathSegments(path: string): string {
  const isAbsolute = /^([a-zA-Z]:[\\/]|\/|\\\\)/.test(path);
  const segments = path.split(/[\\/]+/);
  const out: string[] = [];
  for (const seg of segments) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!isAbsolute) out.push("..");
      continue;
    }
    out.push(seg);
  }
  const joined = out.join("/");
  if (isAbsolute) {
    const prefix = /^[a-zA-Z]:/.test(path) ? "" : "/";
    return prefix + joined;
  }
  return joined;
}

/** Local relative image src → absolute path next to the markdown file. */
function resolveMarkdownImageSrc(src: string, sourceFilePath: string): string {
  let cleaned: string;
  try {
    cleaned = decodeURIComponent(src);
  } catch {
    cleaned = src;
  }
  if (BROWSER_LOADABLE_SRC_RE.test(cleaned)) return cleaned;
  if (!/\.(?:apng|avif|bmp|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/i.test(cleaned)) {
    return cleaned;
  }
  const pathOnly = cleaned.replace(/[?#].*$/, "");
  if (/^([a-zA-Z]:[\\/]|\/|\\\\)/.test(pathOnly)) {
    return convertFileSrc(normalizePathSegments(pathOnly));
  }
  const sepIdx = Math.max(
    sourceFilePath.lastIndexOf("/"),
    sourceFilePath.lastIndexOf("\\"),
  );
  if (sepIdx <= 0) return cleaned;
  try {
    return convertFileSrc(
      normalizePathSegments(`${sourceFilePath.slice(0, sepIdx)}/${pathOnly}`),
    );
  } catch {
    return cleaned;
  }
}

/** Tracks the app theme class on <html> so CodeMirror follows light/dark. */
function useIsDark(): boolean {
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setDark(document.documentElement.classList.contains("dark")),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);
  return dark;
}

export function EditorPane({ path }: { path: string }) {
  const { t } = useTranslation();
  const entry = useFilesStore((s) => s.fileStates[path]);
  const reloadFile = useFilesStore((s) => s.reloadFile);

  if (!entry || entry.loading) {
    return <CenteredSpinner />;
  }
  if (entry.error) {
    return (
      <EmptyState className="flex-col gap-3 p-6">
        <p className="text-body-medium text-text-error-primary">{t("files.fileNotFound")}</p>
        <p className="max-w-md break-all text-caption-1-regular text-text-tertiary">
          {entry.error}
        </p>
        <Button variant="secondary" size="small" onClick={() => void reloadFile(path)}>
          {t("common.refresh")}
        </Button>
      </EmptyState>
    );
  }
  if (!entry.content) {
    return <CenteredSpinner />;
  }
  // key remounts the editor with a fresh draft whenever the file (re)loads.
  return <FileEditor key={`${path}:${entry.loadNonce}`} path={path} content={entry.content} />;
}

function FileEditor({ path, content }: { path: string; content: FileContent }) {
  const { t } = useTranslation();
  const setFileDirty = useFilesStore((s) => s.setFileDirty);
  // Inactive (invisible) editors stay mounted; only the visible tab may
  // answer Cmd/Ctrl+S, or every open file would save at once.
  const isActiveTab = useFilesStore((s) => s.activeFilePath === path);
  const dark = useIsDark();

  const [draft, setDraft] = useState(content.text ?? "");
  const [savedText, setSavedText] = useState(content.text ?? "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [mdMode, setMdMode] = useState<"edit" | "preview">("edit");
  const [langExt, setLangExt] = useState<Extension[]>([]);

  const name = fileName(path);
  const isMarkdown = MARKDOWN_RE.test(name);
  // Preview parses a deferred copy of the draft: the full rehype pipeline
  // (raw → sanitize → highlight) per keystroke would jank typing.
  const deferredDraft = useDeferredValue(draft);
  // Truncated files are partial: editing + saving would clobber the tail.
  const readOnly = content.truncated;
  const dirty = !readOnly && draft !== savedText;

  // Publish dirty state so the tab strip can dot the tab and confirm closes.
  useEffect(() => {
    setFileDirty(path, dirty);
    return () => setFileDirty(path, false);
  }, [dirty, path, setFileDirty]);

  // Resolve a CodeMirror grammar from the file extension (lazy-loaded).
  useEffect(() => {
    let cancelled = false;
    setLangExt([]);
    const desc = LanguageDescription.matchFilename(languages, name);
    if (!desc) return;
    void desc.load().then((ext) => {
      if (!cancelled) setLangExt([ext]);
    });
    return () => {
      cancelled = true;
    };
  }, [name]);

  const save = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await ipc.writeFile(path, draft);
      setSavedText(draft);
    } catch (e) {
      setSaveError(errorText(e));
    } finally {
      setSaving(false);
    }
  }, [path, draft]);

  // Cmd/Ctrl+S saves from anywhere while this editor is mounted. The listener
  // subscribes once; refs keep it reading the latest save/dirty/saving so it
  // isn't re-attached on every keystroke. Render-time ref writes are the
  // "latest ref" pattern here: the only reader is the keydown handler, which
  // fires after commit.
  const saveRef = useRef(save);
  saveRef.current = save;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const savingRef = useRef(saving);
  savingRef.current = saving;
  const activeRef = useRef(isActiveTab);
  activeRef.current = isActiveTab;
  useEffect(() => {
    if (readOnly) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!activeRef.current) return;
        if (dirtyRef.current && !savingRef.current) void saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [readOnly]);

  const markdownComponents = useMemo(
    () => ({
      // Unstyled <pre> from rehype-highlight gets basic chrome here.
      pre: (props: React.HTMLAttributes<HTMLPreElement>) => (
        <pre
          {...props}
          className="my-2 overflow-auto rounded-lg bg-background-secondary-default p-3 text-caption-1-regular"
        />
      ),
      code: (props: React.HTMLAttributes<HTMLElement>) => (
        <code {...props} className="font-mono text-[0.85em]" />
      ),
      img: (props: React.ImgHTMLAttributes<HTMLImageElement>) => (
        <img
          {...props}
          src={props.src ? resolveMarkdownImageSrc(String(props.src), path) : props.src}
          className="max-w-full"
        />
      ),
      a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
        const href = props.href ?? "";
        if (/^https?:/i.test(href)) {
          return (
            <a
              {...props}
              href={href}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void invoke("plugin:opener|open_url", { url: href }).catch(() => {});
              }}
            />
          );
        }
        return <a {...props} />;
      },
    }),
    [path],
  );

  if (content.kind === "image") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <EditorHeader name={name} />
        <EmptyState className="overflow-auto bg-background-secondary-default p-4">
          {content.dataUrl ? (
            <img src={content.dataUrl} alt={name} className="max-h-full max-w-full object-contain" />
          ) : (
            <p className="text-body-medium text-text-tertiary">{t("files.imageTooLarge")}</p>
          )}
        </EmptyState>
      </div>
    );
  }

  if (content.kind === "binary") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <EditorHeader name={name} />
        <EmptyState className="p-6">
          <p className="text-body-medium text-text-tertiary">{t("files.binaryFile")}</p>
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border-button-default px-3">
        <span className="truncate text-body-medium text-text-primary" title={path}>
          {name}
        </span>
        {dirty && (
          <span className="shrink-0 rounded-sm bg-badge-neutral-background px-1.5 py-0.5 text-caption-1-medium text-text-secondary">
            {t("files.unsavedChanges")}
          </span>
        )}
        {readOnly && (
          <span className="shrink-0 text-caption-1-regular text-text-tertiary">
            {t("files.fileTruncated")}
          </span>
        )}
        <div className="flex-1" />
        {isMarkdown && (
          <div className="flex shrink-0 items-center rounded-lg border border-border-button-default">
            <button
              type="button"
              onClick={() => setMdMode("edit")}
              className={cx(
                "flex h-6 items-center gap-1 rounded-l-lg px-2 text-caption-1-medium",
                mdMode === "edit"
                  ? "bg-background-tertiary-default text-text-primary"
                  : "text-text-tertiary hover:text-text-primary",
              )}
            >
              <PencilLine className="size-3" aria-hidden />
              {t("files.editMode")}
            </button>
            <button
              type="button"
              onClick={() => setMdMode("preview")}
              className={cx(
                "flex h-6 items-center gap-1 rounded-r-lg px-2 text-caption-1-medium",
                mdMode === "preview"
                  ? "bg-background-tertiary-default text-text-primary"
                  : "text-text-tertiary hover:text-text-primary",
              )}
            >
              <Eye className="size-3" aria-hidden />
              {t("files.preview")}
            </button>
          </div>
        )}
        {!readOnly && (
          <Button
            variant="secondary"
            size="xs"
            leadingIcon={Save}
            disabled={!dirty || saving}
            onClick={() => void save()}
          >
            {t("files.saveFile")}
          </Button>
        )}
      </div>
      {saveError && (
        <p className="shrink-0 break-all border-b border-border-button-default px-3 py-1.5 text-caption-1-regular text-text-error-primary">
          {saveError}
        </p>
      )}
      {isMarkdown && mdMode === "preview" ? (
        <div className="min-h-0 flex-1 overflow-auto p-4 text-body-medium text-text-primary [&_h1]:mb-2 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-semibold [&_li]:ml-4 [&_li]:list-disc [&_p]:mb-2 [&_a]:text-accent-600 [&_a]:underline">
          <ReactMarkdown
            remarkPlugins={REMARK_PLUGINS}
            rehypePlugins={REHYPE_PLUGINS}
            components={markdownComponents}
          >
            {deferredDraft}
          </ReactMarkdown>
        </div>
      ) : (
        <CodeMirror
          className="min-h-0 flex-1 overflow-hidden [&_.cm-editor]:h-full"
          height="100%"
          value={draft}
          onChange={setDraft}
          extensions={langExt}
          theme={dark ? "dark" : "light"}
          readOnly={readOnly}
          basicSetup={CM_BASIC_SETUP}
        />
      )}
    </div>
  );
}

export default EditorPane;

function EditorHeader({ name }: { name: string }) {
  return (
    <div className="flex h-10 shrink-0 items-center border-b border-border-button-default px-3">
      <span className="truncate text-body-medium text-text-primary">{name}</span>
    </div>
  );
}
