import { useId, type CSSProperties } from "react";
import SquareTerminal from "lucide-react/dist/esm/icons/square-terminal";
import claudeIcon from "@/assets/model-icons/claude.svg";
import deepseekIcon from "@/assets/model-icons/deepseek.svg";

/**
 * Per-CLI brand marks for the engine picker (ported from the previous
 * desktop-cc-gui demo's EngineIcon). Image marks (claude / dsh) are
 * static assets; the rest are monochrome glyphs that follow `currentColor`,
 * so they ride the theme like every other icon.
 */

/** Brand names stay literal in every locale (Claude Code, Codex CLI, …). */
export const CLI_DISPLAY_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  grok: "Grok CLI",
  kimi: "Kimi CLI",
  pi: "PI CLI",
  omp: "OMP CLI",
  dsh: "DeepSeek Harness",
};

export type EngineIconId =
  | "claude"
  | "codex"
  | "grok"
  | "kimi"
  | "pi"
  | "omp"
  | "dsh";
/**
 * Infer a provider brand from a model name so cross-provider engines
 * (e.g. OMP CLI serving Kimi K3) show the model's own mark in the model
 * list instead of the engine's. Returns null when no brand matches —
 * callers fall back to the engine icon.
 */
export function inferModelEngine(name: string): EngineIconId | null {
  const lower = name.toLowerCase();
  if (/\b(claude|sonnet|opus|haiku)\b/.test(lower)) return "claude";
  if (/\b(gpt|codex|openai)\b/.test(lower) || /\bo[134]\b/.test(lower)) return "codex";
  if (/\bgrok\b/.test(lower)) return "grok";
  if (/\b(kimi|moonshot)\b/.test(lower) || /\bk\d/.test(lower)) return "kimi";
  if (/\bdeepseek\b/.test(lower)) return "dsh";
  return null;
}

interface EngineIconProps {
  engine: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
}

interface SvgGlyphProps {
  size: number;
  className?: string;
  style?: CSSProperties;
}

const KIMI_ICON_PATHS = [
  "M21.846 0a1.923 1.923 0 110 3.846H20.15a.226.226 0 01-.227-.226V1.923C19.923.861 20.784 0 21.846 0z",
  "M11.065 11.199l7.257-7.2c.137-.136.06-.41-.116-.41H14.3a.164.164 0 00-.117.051l-7.82 7.756c-.122.12-.302.013-.302-.179V3.82c0-.127-.083-.23-.185-.23H3.186c-.103 0-.186.103-.186.23V19.77c0 .128.083.23.186.23h2.69c.103 0 .186-.102.186-.23v-3.25c0-.069.025-.135.069-.178l2.424-2.406a.158.158 0 01.205-.023l6.484 4.772a7.677 7.677 0 003.453 1.283c.108.012.2-.095.2-.23v-3.06c0-.117-.07-.212-.164-.227a5.028 5.028 0 01-2.027-.807l-5.613-4.064c-.117-.078-.132-.279-.028-.381z",
] as const;

const GROK_ICON_PATHS = [
  "M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815",
] as const;

const PI_ICON_PATHS = [
  "M1 1h16.5v11H12v5.5H6.5V23H1V1zm5.5 5.5V12H12V6.5H6.5z",
  "M17.5 12H23v11h-5.5V12z",
] as const;
/**
 * Official omp mark from omp.sh: a π filled with the brand gradient
 * (pink → violet → cyan, oklch stops verbatim from the site). Unlike the
 * monochrome glyphs it ships its own colors, so it renders identically in
 * both themes. The gradient id is per-instance via useId — multiple omp
 * icons on one page must not share a defs id.
 */
function OmpGlyph({ size, className, style }: SvgGlyphProps) {
  // useId emits ":rN:"; colons break url(#…) fragment refs in WebKit.
  const gradientId = useId().replace(/:/g, "");
  return (
    <svg
      viewBox="0 0 64 64"
      className={className}
      style={{ width: size, height: size, flexShrink: 0, ...style }}
      aria-hidden
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="oklch(0.7 0.24 340)" />
          <stop offset=".5" stopColor="oklch(0.62 0.21 295)" />
          <stop offset="1" stopColor="oklch(0.81 0.14 200)" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${gradientId})`}
        d="M10 14h44v9H43v33h-9V23h-9v22h-9V23H10z"
      />
    </svg>
  );
}

const OPENAI_ICON_PATH =
  "M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 0 0-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 0 1 .476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 0 1 4.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 0 1-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 0 0 5.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0 0 10.205 0a5.947 5.947 0 0 0-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 0 0 4.162 1.713z";

function MonochromeGlyph({
  size,
  className,
  style,
  paths,
}: SvgGlyphProps & { paths: readonly string[] }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      fillRule="evenodd"
      className={className}
      style={{ width: size, height: size, flexShrink: 0, ...style }}
      aria-hidden
    >
      {paths.map((pathData) => (
        <path key={pathData} d={pathData} />
      ))}
    </svg>
  );
}

export function EngineIcon({ engine, size = 14, className, style }: EngineIconProps) {
  const iconStyle: CSSProperties = {
    width: size,
    height: size,
    flexShrink: 0,
    ...style,
  };

  switch (engine) {
    case "claude":
      return (
        <img src={claudeIcon} alt="Claude" className={className} style={iconStyle} aria-hidden />
      );
    case "codex":
      return <MonochromeGlyph paths={[OPENAI_ICON_PATH]} size={size} className={className} style={style} />;
    case "grok":
      return <MonochromeGlyph paths={GROK_ICON_PATHS} size={size} className={className} style={style} />;
    case "kimi":
      return <MonochromeGlyph paths={KIMI_ICON_PATHS} size={size} className={className} style={style} />;
    case "pi":
      return <MonochromeGlyph paths={PI_ICON_PATHS} size={size} className={className} style={style} />;
    case "omp":
      return <OmpGlyph size={size} className={className} style={style} />;
    case "dsh":
      return (
        <img
          src={deepseekIcon}
          alt="DeepSeek Harness"
          className={className}
          style={iconStyle}
          aria-hidden
        />
      );
    default:
      return (
        <SquareTerminal
          className={className}
          style={iconStyle}
          aria-hidden
        />
      );
  }
}
