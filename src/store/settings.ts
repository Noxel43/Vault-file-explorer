import { create } from "zustand";
import { api } from "../lib/api";
import type { AppInfo, FolderView } from "../lib/types";
import { DEFAULT_MODULES, MODULES, isInstalled, type ModuleId, type ModuleState } from "../modules/registry";

export const THEMES = [
  { id: "dark", name: "Graphite" },
  { id: "midnight", name: "Midnight" },
  { id: "nord", name: "Nord" },
  { id: "light", name: "Daylight" },
] as const;
export type ThemeId = (typeof THEMES)[number]["id"];

export const DEFAULT_VIEW: FolderView = {
  mode: "details",
  sortKey: "name",
  sortDir: "asc",
  foldersFirst: true,
  showHidden: false,
  iconSize: 96,
  columns: { name: 360, modified: 170, type: 110, size: 90, tags: 140 },
};

export interface AppSettings {
  theme: ThemeId;
  /** Overrides the theme's accent colour when set. */
  accent: string | null;
  density: "compact" | "comfortable";
  defaultView: FolderView;
  confirmDelete: boolean;
  startLocation: "this-pc" | "home" | "last";
  lastPath: string | null;
  modules: ModuleState;
  sidebarOpen: boolean;
  sidebarWidth: number;
  panelOpen: boolean;
  panelWidth: number;
  filterBarOpen: boolean;
}

const DEFAULTS: AppSettings = {
  theme: "dark",
  accent: null,
  density: "comfortable",
  defaultView: DEFAULT_VIEW,
  confirmDelete: true,
  startLocation: "this-pc",
  lastPath: null,
  modules: DEFAULT_MODULES,
  sidebarOpen: true,
  sidebarWidth: 220,
  panelOpen: true,
  panelWidth: 300,
  filterBarOpen: false,
};

interface SettingsStore extends AppSettings {
  loaded: boolean;
  info: AppInfo | null;
  load: () => Promise<void>;
  update: (patch: Partial<AppSettings>) => void;
  /** Is the module installed in this tier *and* switched on? */
  enabled: (id: ModuleId) => boolean;
}

let saveTimer: number | undefined;

export const useSettings = create<SettingsStore>((set, get) => ({
  ...DEFAULTS,
  loaded: false,
  info: null,

  load: async () => {
    const [info, stored] = await Promise.all([api.appInfo(), api.getSettings(["app"])]);
    let saved: Partial<AppSettings> = {};
    try {
      saved = stored.app ? JSON.parse(stored.app) : {};
    } catch {
      /* corrupt settings fall back to defaults */
    }
    set({
      ...DEFAULTS,
      ...saved,
      defaultView: { ...DEFAULT_VIEW, ...saved.defaultView, columns: { ...DEFAULT_VIEW.columns, ...saved.defaultView?.columns } },
      modules: { ...DEFAULT_MODULES, ...saved.modules },
      info,
      loaded: true,
    });
  },

  update: (patch) => {
    set(patch);
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      const s = get();
      const data: AppSettings = Object.fromEntries(
        (Object.keys(DEFAULTS) as (keyof AppSettings)[]).map((k) => [k, s[k]]),
      ) as unknown as AppSettings;
      api.setSetting("app", JSON.stringify(data)).catch(console.error);
    }, 250);
  },

  enabled: (id) => {
    const { info, modules } = get();
    const def = MODULES.find((m) => m.id === id);
    if (!def || !info) return false;
    return isInstalled(def, info.tier) && modules[id];
  },
}));

/** Hook form of `enabled` that re-renders when modules change. */
export function useModule(id: ModuleId): boolean {
  return useSettings((s) => {
    const def = MODULES.find((m) => m.id === id);
    return !!def && !!s.info && isInstalled(def, s.info.tier) && s.modules[id];
  });
}
