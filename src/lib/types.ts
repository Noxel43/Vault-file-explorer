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

export interface DirListing {
  path: string;
  entries: RawEntry[];
  skipped: number;
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

export interface AppInfo {
  version: string;
  tier: "lite" | "standard" | "full";
  dataDir: string;
  platform: string;
}

export type ViewMode = "details" | "list" | "grid";
export type SortKey = "name" | "modified" | "created" | "size" | "type";

export interface ColumnWidths {
  name: number;
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
