import type { Category } from "./fileTypes";

/** Raw entry as returned by the Rust `list_dir` / `stat_paths` commands. */
export interface RawEntry {
  name: string;
  path?: string;
  isDir: boolean;
  size: number;
  modified: number;
  created: number;
  hidden: boolean;
  system: boolean;
  readonly: boolean;
  symlink: boolean;
}

/** Entry enriched once on load so sorting/filtering never recomputes these. */
export interface Entry extends RawEntry {
  path: string;
  lower: string;
  ext: string;
  category: Category;
}

/** `[name, flags, size, modified, created]` — see `Packed` in fs_ops.rs. */
export type PackedEntry = [string, number, number, number, number];

export interface DirListing {
  path: string;
  entries: PackedEntry[];
  skipped: number;
}

export function unpack([name, flags, size, modified, created]: PackedEntry): RawEntry {
  return {
    name,
    size,
    modified,
    created,
    isDir: (flags & 1) !== 0,
    hidden: (flags & 2) !== 0,
    system: (flags & 4) !== 0,
    readonly: (flags & 8) !== 0,
    symlink: (flags & 16) !== 0,
  };
}

export interface Drive {
  path: string;
  label: string;
  kind: string;
  total: number;
  free: number;
}

export interface Place {
  id: string;
  name: string;
  path: string;
}

export interface Tag {
  id: number;
  name: string;
  color: string;
}

export interface TagWithCount extends Tag {
  count: number;
}

export interface FileMeta {
  path: string;
  description: string;
  keywords: string[];
  rating: number;
  tags: Tag[];
}

export interface MetaSummary {
  path: string;
  tagIds: number[];
  rating: number;
  hasNotes: boolean;
}

export interface TransferResult {
  done: [string, string][];
  errors: string[];
}

/** `[name, flags, size, modified, created, index into dirs]`, see `ResultRow` in index/mod.rs. */
export type SearchRow = [string, number, number, number, number, number];

export interface SearchResults {
  rows: SearchRow[];
  dirs: string[];
  /** Matches found; `rows` holds the best of them. */
  total: number;
  categories: Partial<Record<Category, number>>;
  patternError: string | null;
  /** False while the index is still loading from disk. */
  ready: boolean;
  /** A newer search replaced this one. */
  stale: boolean;
  tookMs: number;
}

export interface IndexStatus {
  state: "off" | "loading" | "scanning" | "idle";
  files: number;
  dirs: number;
  revision: number;
  foldersWalked: number;
  skipped: number;
  lastScan: number;
  memoryBytes: number;
  diskBytes: number;
  roots: string[];
}

export interface TextPreview {
  text: string;
  encoding: string;
  truncated: boolean;
  binary: boolean;
}

export interface AppInfo {
  version: string;
  tier: "lite" | "standard" | "full";
  dataDir: string;
  platform: string;
}

export type ViewMode = "details" | "list" | "grid";
/** "relevance" and "folder" only apply to search results. */
export type SortKey = "name" | "modified" | "created" | "size" | "type" | "relevance" | "folder";

export interface ColumnWidths {
  name: number;
  location: number;
  modified: number;
  type: number;
  size: number;
  tags: number;
}

/** Per-folder view settings, persisted in SQLite. */
export interface FolderView {
  mode: ViewMode;
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  foldersFirst: boolean;
  showHidden: boolean;
  iconSize: number;
  columns: ColumnWidths;
}
