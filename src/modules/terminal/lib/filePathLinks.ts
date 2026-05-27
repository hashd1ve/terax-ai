// Pure path-token detection for terminal file-path linkification.
//
// The terminal link provider scans each rendered line for tokens that *look*
// like file paths — absolute (`/abs/file.rs`), explicitly relative
// (`./rel.ts`, `../up.ts`), or workspace-relative (`src/app/App.tsx`) — with an
// optional `:line(:col)` suffix (e.g. `src/app/App.tsx:1341:5`).
//
// Detection is shape-based and synchronous: it runs on every hover/render, so
// it must stay cheap and must NOT touch the filesystem. Existence is *not*
// verified here — see resolveLeafPath/openFileTab at click time. We bias toward
// precision over recall: a token must have a path-ish shape (a slash and/or a
// known file extension) before it linkifies, so prose words don't light up.

export type PathMatch = {
  /** The full matched token including any line/col suffix, as shown on screen. */
  readonly text: string;
  /** The path portion (suffix stripped). */
  readonly path: string;
  /** 1-based line number from a `:line` suffix, if present. */
  readonly line?: number;
  /** 1-based column number from a `:line:col` suffix, if present. */
  readonly col?: number;
  /** 0-based index of the first char of `text` within the source line. */
  readonly startIndex: number;
  /** 0-based index just past the last char of `text`. */
  readonly endIndex: number;
};

// File extensions worth linkifying when a token has no slash (a bare filename
// like `App.tsx`). Slash-bearing tokens are linkified regardless of extension.
// Keep this list focused on source/config/text files an editor can open.
const KNOWN_EXTENSIONS = new Set([
  // web / js / ts
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts",
  // rust / go / c-family / others
  "rs", "go", "py", "rb", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp",
  "cs", "php", "lua", "sh", "bash", "zsh", "fish",
  // markup / styles / data / config
  "html", "htm", "css", "scss", "sass", "less", "vue", "svelte", "json",
  "jsonc", "yaml", "yml", "toml", "xml", "md", "mdx", "txt", "lock", "env",
  "sql", "graphql", "gql", "proto", "ini", "cfg", "conf", "gitignore",
]);

// Spans belonging to a URL (`scheme://...`). A URL's `//host` and `/path`
// fragments are path-shaped and would otherwise linkify as files, colliding
// with the WebLinksAddon (which owns URLs). We detect URL spans and skip any
// path token that overlaps one. `\S+` greedily takes the rest of the URL.
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

// A candidate token: a run of characters allowed in unquoted paths. We stop at
// whitespace and shell metacharacters that can't appear mid-path. Backslashes
// are excluded so Windows-style separators aren't mistaken for escapes here;
// Terax paths are posix-style (WSL/macOS/Linux).
const TOKEN_RE = /[A-Za-z0-9_./~@+-]+(?::\d+(?::\d+)?)?/g;

// Trailing punctuation that commonly hugs a path in prose/logs but isn't part
// of it (e.g. "see src/app.ts." or "(src/app.ts)").
const TRAILING_TRIM = /[).,;:!?'"\]}>]+$/;

function fileExtension(path: string): string | null {
  const slash = path.lastIndexOf("/");
  const base = slash === -1 ? path : path.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  // No extension, or a leading-dot dotfile (".env" → treat "env" as ext).
  if (dot <= 0) {
    if (dot === 0 && base.length > 1) return base.slice(1).toLowerCase();
    return null;
  }
  return base.slice(dot + 1).toLowerCase();
}

/** True when a bare path (no `:line` suffix) has a shape worth linkifying. */
function looksLikePath(path: string): boolean {
  // Absolute or explicitly relative paths are always path-shaped.
  if (
    path.startsWith("/") ||
    path.startsWith("./") ||
    path.startsWith("../") ||
    path.startsWith("~/")
  ) {
    // Require at least one more char beyond the prefix marker.
    return path.length > 1 && path !== "./" && path !== "../" && path !== "~/";
  }
  const hasSlash = path.includes("/");
  const ext = fileExtension(path);
  const hasKnownExt = ext !== null && KNOWN_EXTENSIONS.has(ext);
  // Workspace-relative needs *either* a slash (dir/file) or a known file
  // extension (bare filename) — and ideally both. A bare word with no slash
  // and no known extension is prose, not a path.
  if (hasSlash) {
    // Avoid linkifying things like "a/b" with no extension and only one char
    // segments? Keep it permissive for dir-style paths but require it not be
    // purely numeric like "1/2" (rare in real paths, common in fractions).
    return true;
  }
  return hasKnownExt;
}

/**
 * Parse a single terminal line into file-path matches with their column ranges.
 *
 * Pure and synchronous. Returns matches in left-to-right order. Relative paths
 * are returned as-is (the `path` field); resolution against a cwd happens at
 * the call site, not here.
 */
export function parsePathTokens(lineText: string): PathMatch[] {
  const matches: PathMatch[] = [];

  // Collect URL spans up front so path tokens inside them can be skipped.
  const urlRanges: Array<[number, number]> = [];
  URL_RE.lastIndex = 0;
  let u: RegExpExecArray | null;
  while ((u = URL_RE.exec(lineText)) !== null) {
    urlRanges.push([u.index, u.index + u[0].length]);
  }

  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(lineText)) !== null) {
    const raw = m[0];
    const start = m.index;

    // Skip tokens that fall within a URL — the WebLinksAddon handles those.
    const rawEnd = start + raw.length;
    if (urlRanges.some(([a, b]) => start < b && rawEnd > a)) continue;

    // Trim trailing prose punctuation, adjusting the end index.
    const trimmed = raw.replace(TRAILING_TRIM, "");
    if (trimmed.length === 0) continue;
    const text = trimmed;
    const endIndex = start + text.length;

    // Split an optional :line(:col) suffix off the path.
    let path = text;
    let line: number | undefined;
    let col: number | undefined;
    const suffix = /^(.*?):(\d+)(?::(\d+))?$/.exec(text);
    if (suffix) {
      const candidatePath = suffix[1];
      // Only treat `:N` as a line suffix when the left side is itself
      // path-shaped; otherwise things like `12:34` (a time) don't match.
      if (candidatePath.length > 0 && looksLikePath(candidatePath)) {
        path = candidatePath;
        line = Number.parseInt(suffix[2], 10);
        if (suffix[3] !== undefined) col = Number.parseInt(suffix[3], 10);
      }
    }

    if (!looksLikePath(path)) continue;

    matches.push({
      text,
      path,
      ...(line !== undefined ? { line } : {}),
      ...(col !== undefined ? { col } : {}),
      startIndex: start,
      endIndex,
    });
  }
  return matches;
}

/**
 * Resolve a (possibly relative) path against a leaf's current working dir.
 *
 * - Absolute paths (`/...`) are returned normalized.
 * - `~/` expands against `home` when provided.
 * - Relative paths join onto `cwd`. When `cwd` is null and the path is
 *   relative, returns null (caller can't open an unrooted path safely).
 *
 * Pure: collapses `.`/`..` segments without touching the filesystem.
 */
export function resolveLeafPath(
  rawPath: string,
  cwd: string | null,
  home?: string | null,
): string | null {
  let path = rawPath;
  if (path.startsWith("~/") && home) {
    path = `${home.replace(/\/+$/, "")}/${path.slice(2)}`;
  } else if (path === "~" && home) {
    return normalizePosix(home);
  }
  if (path.startsWith("/")) return normalizePosix(path);
  // Relative: must have a cwd to anchor against.
  if (!cwd) return null;
  return normalizePosix(`${cwd.replace(/\/+$/, "")}/${path}`);
}

/** Collapse `.`/`..` and duplicate slashes in a posix-style absolute path. */
function normalizePosix(path: string): string {
  const isAbsolute = path.startsWith("/");
  const parts = path.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!isAbsolute) out.push("..");
      continue;
    }
    out.push(part);
  }
  const joined = out.join("/");
  return isAbsolute ? `/${joined}` : joined;
}
