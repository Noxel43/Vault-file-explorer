import type { AppInfo } from "../lib/types";

export type Tier = AppInfo["tier"];
export const TIER_ORDER: Tier[] = ["lite", "standard", "full"];

export type ModuleId =
  | "filters"
  | "metadata"
  | "watcher"
  | "statusbar"
  | "tags"
  | "thumbnails"
  | "preview"
  | "search"
  | "batchRename"
  | "archives"
  | "encryption"
  | "conversion"
  | "addons";

export interface ModuleDef {
  id: ModuleId;
  name: string;
  description: string;
  /** Lowest installation tier that ships this module. */
  tier: Tier;
  /** Not built yet — shown in Settings as upcoming. */
  planned?: boolean;
}

export const MODULES: ModuleDef[] = [
  { id: "filters", name: "Filter bar", description: "Filter the open folder by name, pattern, type, date, size and tags.", tier: "lite" },
  { id: "metadata", name: "Metadata panel", description: "Inspect files and edit tags, descriptions, keywords and ratings.", tier: "lite" },
  { id: "watcher", name: "Live updates", description: "Refresh the open folder automatically when files change on disk.", tier: "lite" },
  { id: "statusbar", name: "Status bar", description: "Item, filter and selection counts at the bottom of the window.", tier: "lite" },
  { id: "tags", name: "Tag library", description: "Tags in the sidebar, with a view of every file carrying a tag.", tier: "standard" },
  { id: "thumbnails", name: "Image thumbnails", description: "Show image previews in grid view.", tier: "standard" },
  { id: "preview", name: "Preview pane", description: "Inline previews for images, audio, PDF, code and 3D files.", tier: "standard", planned: true },
  { id: "search", name: "Indexed search", description: "Background indexing and instant search across drives.", tier: "standard", planned: true },
  { id: "batchRename", name: "Batch rename", description: "Rename many files with patterns and regex, with a live preview.", tier: "standard", planned: true },
  { id: "archives", name: "Archive tools", description: "Create, browse and selectively extract zip, 7z and rar.", tier: "full", planned: true },
  { id: "encryption", name: "Encryption", description: "Encrypt files and folders into .vault containers.", tier: "full", planned: true },
  { id: "conversion", name: "File conversion", description: "Convert media, documents and 3D models between formats.", tier: "full", planned: true },
  { id: "addons", name: "Themes & addons", description: "Install .vtheme and .vaddon packages with the mod manager.", tier: "full", planned: true },
];

export function isInstalled(m: ModuleDef, tier: Tier): boolean {
  return !m.planned && TIER_ORDER.indexOf(m.tier) <= TIER_ORDER.indexOf(tier);
}

export type ModuleState = Record<ModuleId, boolean>;

export interface Preset {
  id: string;
  name: string;
  description: string;
  modules: ModuleId[];
}

export const PRESETS: Preset[] = [
  {
    id: "minimal",
    name: "Minimal",
    description: "Just browsing, with a filter bar.",
    modules: ["filters", "watcher"],
  },
  {
    id: "balanced",
    name: "Balanced",
    description: "Everyday browsing with metadata and a status bar.",
    modules: ["filters", "metadata", "watcher", "statusbar", "tags"],
  },
  {
    id: "everything",
    name: "Everything",
    description: "Every installed module switched on.",
    modules: MODULES.map((m) => m.id),
  },
];

export function presetState(preset: Preset): ModuleState {
  return Object.fromEntries(MODULES.map((m) => [m.id, preset.modules.includes(m.id)])) as ModuleState;
}

export const DEFAULT_MODULES: ModuleState = presetState(PRESETS[2]);
