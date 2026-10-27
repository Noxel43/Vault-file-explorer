import type { Category } from "./fileTypes";
import type { Entry, FolderView, MetaSummary } from "./types";

export type DatePreset = "any" | "today" | "week" | "month" | "year" | "older" | "custom";
export type PatternMode = "glob" | "regex";

export interface Filters {
  /** Space-separated terms, all must appear in the name. */
  query: string;
  /** Glob ("*.png; report-*") or regex, depending on patternMode. */
  pattern: string;
  patternMode: PatternMode;
  types: Category[];
  dateField: "modified" | "created";
  datePreset: DatePreset;
  dateFrom: string; // yyyy-mm-dd, used when datePreset === "custom"
  dateTo: string;
  sizeMin: number | null; // bytes
  sizeMax: number | null;
  tagIds: number[];
  tagMode: "any" | "all";
}

export const EMPTY_FILTERS: Filters = {
  query: "",
  pattern: "",
  patternMode: "glob",
  types: [],
  dateField: "modified",
  datePreset: "any",
  dateFrom: "",
  dateTo: "",
  sizeMin: null,
  sizeMax: null,
  tagIds: [],
  tagMode: "any",
};

export function activeFilterCount(f: Filters): number {
  return (
    (f.query.trim() ? 1 : 0) +
    (f.pattern.trim() ? 1 : 0) +
    (f.types.length ? 1 : 0) +
    (f.datePreset !== "any" ? 1 : 0) +
    (f.sizeMin != null || f.sizeMax != null ? 1 : 0) +
    (f.tagIds.length ? 1 : 0)
  );
}

/** Convert a glob like "*.png" or "IMG_????.jpg" to a case-insensitive RegExp. */
export function globToRegex(glob: string): RegExp {
  let re = "";
  for (const ch of glob) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

/** Build a name matcher from the pattern field. Returns an error string for bad regex. */
export function compilePattern(pattern: string, mode: PatternMode): ((name: string) => boolean) | string | null {
  const p = pattern.trim();
  if (!p) return null;
  if (mode === "regex") {
    try {
      const re = new RegExp(p, "i");
      return (name) => re.test(name);
    } catch (e) {
      return (e as Error).message;
    }
  }
  // Multiple globs separated by ; or , — match any. A leading "!" excludes.
  const parts = p.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
  const include = parts.filter((s) => !s.startsWith("!")).map(globToRegex);
  const exclude = parts.filter((s) => s.startsWith("!")).map((s) => globToRegex(s.slice(1)));
  return (name) =>
    (include.length === 0 || include.some((r) => r.test(name))) && !exclude.some((r) => r.test(name));
}

function dateRange(f: Filters): [number, number] | null {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const DAY = 86_400_000;
  switch (f.datePreset) {
    case "any":
      return null;
    case "today":
      return [startOfDay, Infinity];
    case "week":
      return [startOfDay - 6 * DAY, Infinity];
    case "month":
      return [startOfDay - 29 * DAY, Infinity];
    case "year":
      return [startOfDay - 364 * DAY, Infinity];
    case "older":
      return [0, startOfDay - 364 * DAY];
    case "custom": {
      const from = f.dateFrom ? new Date(f.dateFrom + "T00:00:00").getTime() : 0;
      const to = f.dateTo ? new Date(f.dateTo + "T00:00:00").getTime() + DAY : Infinity;
      return [from, to];
    }
  }
}

export interface ApplyResult {
  visible: Entry[];
  patternError: string | null;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function applyFiltersAndSort(
  entries: Entry[],
  f: Filters,
  view: FolderView,
  meta: Map<string, MetaSummary>,
): ApplyResult {
  const terms = f.query.toLowerCase().split(/\s+/).filter(Boolean);
  const compiled = compilePattern(f.pattern, f.patternMode);
  const patternError = typeof compiled === "string" ? compiled : null;
  const matchPattern = typeof compiled === "function" ? compiled : null;
  const types = f.types.length ? new Set(f.types) : null;
  const range = dateRange(f);
  const tagSet = f.tagIds.length ? f.tagIds : null;
  const sizeActive = f.sizeMin != null || f.sizeMax != null;

  const visible = entries.filter((e) => {
    if (!view.showHidden && (e.hidden || e.system)) return false;
    for (const t of terms) if (!e.lower.includes(t)) return false;
    if (matchPattern && !matchPattern(e.name)) return false;
    if (types && !types.has(e.category)) return false;
    if (range) {
      const t = f.dateField === "created" ? e.created : e.modified;
      if (t < range[0] || t >= range[1]) return false;
    }
    if (sizeActive) {
      // Size filters only make sense for files; folders are excluded while active.
      if (e.isDir) return false;
      if (f.sizeMin != null && e.size < f.sizeMin) return false;
      if (f.sizeMax != null && e.size > f.sizeMax) return false;
    }
    if (tagSet) {
      const m = meta.get(e.path.toLowerCase());
      if (!m) return false;
      const ok =
        f.tagMode === "all" ? tagSet.every((id) => m.tagIds.includes(id)) : tagSet.some((id) => m.tagIds.includes(id));
      if (!ok) return false;
    }
    return true;
  });

  const dir = view.sortDir === "asc" ? 1 : -1;
  const byName = (a: Entry, b: Entry) => collator.compare(a.name, b.name);
  let cmp: (a: Entry, b: Entry) => number;
  switch (view.sortKey) {
    case "modified":
      cmp = (a, b) => a.modified - b.modified || byName(a, b);
      break;
    case "created":
      cmp = (a, b) => a.created - b.created || byName(a, b);
      break;
    case "size":
      cmp = (a, b) => a.size - b.size || byName(a, b);
      break;
    case "type":
      cmp = (a, b) => (a.ext < b.ext ? -1 : a.ext > b.ext ? 1 : 0) || byName(a, b);
      break;
    default:
      cmp = byName;
  }
  visible.sort((a, b) => {
    if (view.foldersFirst && a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return cmp(a, b) * dir;
  });

  return { visible, patternError };
}
