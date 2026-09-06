import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { WebglAddon } from "@xterm/addon-webgl";

export interface XtermModules {
  Terminal: typeof Terminal;
  FitAddon: typeof FitAddon;
  WebglAddon: typeof WebglAddon;
}

// xterm (~330KB min + CSS) must stay out of the startup chunk: it loads on
// the first terminal open, and the module-level promise caches that load.
let xtermPromise: Promise<XtermModules> | null = null;

export function loadXterm(): Promise<XtermModules> {
  return (xtermPromise ??= Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
    import("@xterm/addon-webgl"),
    import("@xterm/xterm/css/xterm.css"),
  ]).then(([xterm, fit, webgl]) => ({
    Terminal: xterm.Terminal,
    FitAddon: fit.FitAddon,
    WebglAddon: webgl.WebglAddon,
  })));
}
