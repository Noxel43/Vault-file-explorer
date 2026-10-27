import { create } from "zustand";
import { api } from "../lib/api";
import { categoryOf, extOf } from "../lib/fileTypes";
import { EMPTY_FILTERS, applyFiltersAndSort, type Filters } from "../lib/filters";
import { THIS_PC, baseName, isVirtual, join, parentOf, pathKey, tagIdOf } from "../lib/path";
import type { Drive, Entry, FolderView, MetaSummary, Place, RawEntry, TagWithCount } from "../lib/types";
import { DEFAULT_VIEW, useSettings } from "./settings";

export interface Toast {
  id: number;
  text: string;
  kind: "info" | "error";
}

interface Clipboard {
  paths: string[];
  mode: "copy" | "cut";
}

interface ExplorerStore {
  location: string;
  history: string[];
  historyIndex: number;
  loading: boolean;
  error: string | null;

  entries: Entry[];
  meta: Map<string, MetaSummary>;
  view: FolderView;
  viewIsCustom: boolean;
  filters: Filters;
  keepFilters: boolean;
  visible: Entry[];
  patternError: string | null;

  selected: Set<string>;
  anchor: string | null;
  focus: string | null;
  renaming: string | null;
  clipboard: Clipboard | null;

  drives: Drive[];
  places: Place[];
  tags: TagWithCount[];
  toasts: Toast[];

  init: () => Promise<void>;
  navigate: (path: string, opts?: { push?: boolean; select?: string }) => Promise<void>;
  back: () => void;
  forward: () => void;
  up: () => void;
  refresh: () => Promise<void>;
  goToInput: (input: string) => Promise<boolean>;

  setView: (patch: Partial<FolderView>) => void;
  resetView: () => void;
  setFilters: (patch: Partial<Filters>) => void;
  clearFilters: () => void;
  setKeepFilters: (v: boolean) => void;

  select: (path: string, mode?: "single" | "toggle" | "range") => void;
  selectAll: () => void;
  clearSelection: () => void;
  moveFocus: (delta: number, extend: boolean) => void;
  selectedEntries: () => Entry[];

  open: (entry: Entry) => void;
  startRename: (path?: string) => void;
  cancelRename: () => void;
  commitRename: (path: string, newName: string) => Promise<void>;
  newFolder: () => Promise<void>;
  newFile: () => Promise<void>;
  deleteSelected: (permanent: boolean) => Promise<void>;
  copySelected: (mode: "copy" | "cut") => void;
  paste: () => Promise<void>;

  refreshMeta: () => Promise<void>;
  refreshTags: () => Promise<void>;
  refreshDrives: () => Promise<void>;
  toast: (text: string, kind?: Toast["kind"]) => void;
  dismissToast: (id: number) => void;
}

function enrich(raw: RawEntry, dir: string): Entry {
  const ext = extOf(raw.name, raw.isDir);
  return {
    ...raw,
    path: raw.path ?? join(dir, raw.name),
    lower: raw.name.toLowerCase(),
    ext,
    category: categoryOf(ext, raw.isDir),
  };
}

function normaliseView(v: Partial<FolderView> | null | undefined): FolderView {
  const base = useSettings.getState().defaultView ?? DEFAULT_VIEW;
  return { ...base, ...v, columns: { ...base.columns, ...v?.columns } };
}

let loadToken = 0;
let viewSaveTimer: number | undefined;
let toastId = 0;

export const useExplorer = create<ExplorerStore>((set, get) => {
  /** Re-run filter + sort; call after anything that changes entries, filters, view or meta. */
  const recompute = () => {
    const { entries, filters, view, meta, selected } = get();
    const { visible, patternError } = applyFiltersAndSort(entries, filters, view, meta);
    // Drop selections that no longer exist in the folder.
    const existing = new Set(entries.map((e) => e.path));
    const nextSel = new Set([...selected].filter((p) => existing.has(p)));
    set({ visible, patternError, selected: nextSel.size === selected.size ? selected : nextSel });
  };

  const load = async (path: string, keepSelection: boolean, selectPath?: string) => {
    const token = ++loadToken;
    set({ loading: true, error: null });
    try {
      let entries: Entry[] = [];
      let meta = new Map<string, MetaSummary>();
      let view = get().view;
      let viewIsCustom = false;
      let location = path;
      const tagId = tagIdOf(path);

      if (path === THIS_PC) {
        get().refreshDrives();
        view = normaliseView(null);
      } else if (tagId != null) {
        const paths = await api.pathsWithTag(tagId);
        const raws = await api.statPaths(paths);
        entries = raws.map((r) => enrich(r, ""));
        const parents = [...new Set(entries.map((e) => parentOf(e.path)).filter((p): p is string => !!p))];
        const metas = await Promise.all(parents.map((p) => api.getFolderMeta(p)));
        meta = new Map(metas.flat().map((m) => [pathKey(m.path), m]));
        view = normaliseView({ foldersFirst: false });
      } else {
        const [listing, savedView, folderMeta] = await Promise.all([
          api.listDir(path),
          api.getFolderView(path).catch(() => null),
          api.getFolderMeta(path).catch(() => [] as MetaSummary[]),
        ]);
        location = listing.path;
        entries = listing.entries.map((r) => enrich(r, listing.path));
        meta = new Map(folderMeta.map((m) => [pathKey(m.path), m]));
        let parsed: Partial<FolderView> | null = null;
        try {
          parsed = savedView ? JSON.parse(savedView) : null;
        } catch {
          parsed = null;
        }
        view = normaliseView(parsed);
        viewIsCustom = !!parsed;
        if (useSettings.getState().enabled("watcher")) api.watchDir(location).catch(() => {});
        useSettings.getState().update({ lastPath: location });
      }
      if (token !== loadToken) return; // a newer navigation won

      const prev = get();
      const sameFolder = prev.location === location;
      const selected = keepSelection && sameFolder ? prev.selected : new Set<string>();
      if (selectPath) {
        selected.clear();
        selected.add(selectPath);
      }
      set({
        location,
        entries,
        meta,
        view,
        viewIsCustom,
        loading: false,
        selected,
        anchor: selectPath ?? (keepSelection && sameFolder ? prev.anchor : null),
        focus: selectPath ?? (keepSelection && sameFolder ? prev.focus : null),
        filters: sameFolder || prev.keepFilters ? prev.filters : EMPTY_FILTERS,
      });
      recompute();
    } catch (e) {
      if (token !== loadToken) return;
      set({ loading: false, error: String(e) });
    }
  };

  return {
    location: THIS_PC,
    history: [],
    historyIndex: -1,
    loading: false,
    error: null,
    entries: [],
    meta: new Map(),
    view: DEFAULT_VIEW,
    viewIsCustom: false,
    filters: EMPTY_FILTERS,
    keepFilters: false,
    visible: [],
    patternError: null,
    selected: new Set(),
    anchor: null,
    focus: null,
    renaming: null,
    clipboard: null,
    drives: [],
    places: [],
    tags: [],
    toasts: [],

    init: async () => {
      const [places] = await Promise.all([api.getPlaces(), get().refreshDrives(), get().refreshTags()]);
      set({ places });
      const s = useSettings.getState();
      let start = THIS_PC;
      if (s.startLocation === "home") start = places.find((p) => p.id === "home")?.path ?? THIS_PC;
      if (s.startLocation === "last" && s.lastPath) start = s.lastPath;
      await get().navigate(start);
      if (get().error && start !== THIS_PC) await get().navigate(THIS_PC);
    },

    navigate: async (path, opts = {}) => {
      const { push = true, select } = opts;
      if (push) {
        const { history, historyIndex } = get();
        if (history[historyIndex] !== path) {
          const next = history.slice(0, historyIndex + 1);
          next.push(path);
          set({ history: next, historyIndex: next.length - 1 });
        }
      }
      set({ renaming: null });
      await load(path, false, select);
      // Record the canonical path the backend resolved to.
      const { history, historyIndex, location, error } = get();
      if (!error && history[historyIndex] !== location) {
        const h = [...history];
        h[historyIndex] = location;
        set({ history: h });
      }
    },

    back: () => {
      const { history, historyIndex, location } = get();
      if (historyIndex <= 0) return;
      set({ historyIndex: historyIndex - 1 });
      get().navigate(history[historyIndex - 1], { push: false, select: isVirtual(location) ? undefined : location });
    },

    forward: () => {
      const { history, historyIndex } = get();
      if (historyIndex >= history.length - 1) return;
      set({ historyIndex: historyIndex + 1 });
      get().navigate(history[historyIndex + 1], { push: false });
    },

    up: () => {
      const { location } = get();
      if (isVirtual(location)) {
        if (location !== THIS_PC) get().navigate(THIS_PC);
        return;
      }
      const parent = parentOf(location);
      if (parent) get().navigate(parent, { select: location });
    },

    refresh: () => load(get().location, true),

    goToInput: async (input) => {
      try {
        const resolved = await api.resolvePath(input);
        await get().navigate(resolved);
        return !get().error;
      } catch (e) {
        get().toast(String(e), "error");
        return false;
      }
    },

    setView: (patch) => {
      const view = { ...get().view, ...patch };
      set({ view, viewIsCustom: true });
      recompute();
      const { location } = get();
      if (isVirtual(location)) return;
      window.clearTimeout(viewSaveTimer);
      viewSaveTimer = window.setTimeout(() => {
        api.setFolderView(location, JSON.stringify(view)).catch(console.error);
      }, 300);
    },

    resetView: () => {
      const { location } = get();
      if (!isVirtual(location)) api.clearFolderView(location).catch(console.error);
      set({ view: normaliseView(null), viewIsCustom: false });
      recompute();
    },

    setFilters: (patch) => {
      set({ filters: { ...get().filters, ...patch } });
      recompute();
    },

    clearFilters: () => {
      set({ filters: EMPTY_FILTERS });
      recompute();
    },

    setKeepFilters: (keepFilters) => set({ keepFilters }),

    select: (path, mode = "single") => {
      const { selected, anchor, visible } = get();
      if (mode === "toggle") {
        const next = new Set(selected);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        set({ selected: next, anchor: path, focus: path });
      } else if (mode === "range" && anchor) {
        const a = visible.findIndex((e) => e.path === anchor);
        const b = visible.findIndex((e) => e.path === path);
        if (a < 0 || b < 0) return set({ selected: new Set([path]), anchor: path, focus: path });
        const [lo, hi] = a < b ? [a, b] : [b, a];
        set({ selected: new Set(visible.slice(lo, hi + 1).map((e) => e.path)), focus: path });
      } else {
        set({ selected: new Set([path]), anchor: path, focus: path });
      }
    },

    selectAll: () => {
      const { visible } = get();
      set({ selected: new Set(visible.map((e) => e.path)) });
    },

    clearSelection: () => set({ selected: new Set(), anchor: null }),

    moveFocus: (delta, extend) => {
      const { visible, focus } = get();
      if (!visible.length) return;
      const cur = focus ? visible.findIndex((e) => e.path === focus) : -1;
      let next = cur < 0 ? (delta > 0 ? 0 : visible.length - 1) : cur + delta;
      next = Math.max(0, Math.min(visible.length - 1, next));
      get().select(visible[next].path, extend ? "range" : "single");
    },

    selectedEntries: () => {
      const { selected, entries } = get();
      return entries.filter((e) => selected.has(e.path));
    },

    open: (entry) => {
      if (entry.isDir) get().navigate(entry.path);
      else api.openPath(entry.path).catch((e) => get().toast(String(e), "error"));
    },

    startRename: (path) => {
      const target = path ?? get().focus ?? [...get().selected][0];
      if (target && !isVirtual(get().location)) set({ renaming: target });
    },

    cancelRename: () => set({ renaming: null }),

    commitRename: async (path, newName) => {
      set({ renaming: null });
      if (!newName.trim() || newName === baseName(path)) return;
      try {
        const dest = await api.renamePath(path, newName);
        await load(get().location, false, dest);
      } catch (e) {
        get().toast(String(e), "error");
      }
    },

    newFolder: async () => {
      const { location } = get();
      if (isVirtual(location)) return;
      try {
        const path = await api.createFolder(location, "New folder");
        await load(location, false, path);
        set({ renaming: path });
      } catch (e) {
        get().toast(String(e), "error");
      }
    },

    newFile: async () => {
      const { location } = get();
      if (isVirtual(location)) return;
      try {
        const path = await api.createFile(location, "New file.txt");
        await load(location, false, path);
        set({ renaming: path });
      } catch (e) {
        get().toast(String(e), "error");
      }
    },

    deleteSelected: async (permanent) => {
      const paths = [...get().selected];
      if (!paths.length) return;
      try {
        await api.deletePaths(paths, permanent);
        get().toast(`${permanent ? "Deleted" : "Moved to Recycle Bin"}: ${paths.length} item${paths.length > 1 ? "s" : ""}`);
        await get().refresh();
      } catch (e) {
        get().toast(String(e), "error");
        await get().refresh();
      }
    },

    copySelected: (mode) => {
      const paths = [...get().selected];
      if (!paths.length) return;
      set({ clipboard: { paths, mode } });
      get().toast(`${mode === "copy" ? "Copied" : "Cut"} ${paths.length} item${paths.length > 1 ? "s" : ""}`);
    },

    paste: async () => {
      const { clipboard, location } = get();
      if (!clipboard || isVirtual(location)) return;
      try {
        const mode = clipboard.mode === "cut" ? "move" : "copy";
        const result = await api.transferPaths(clipboard.paths, location, mode);
        if (mode === "move") set({ clipboard: null });
        result.errors.forEach((err) => get().toast(err, "error"));
        await load(location, false, result.done[0]?.[1]);
        if (result.done.length > 1) set({ selected: new Set(result.done.map(([, to]) => to)) });
      } catch (e) {
        get().toast(String(e), "error");
      }
    },

    refreshMeta: async () => {
      const { location, entries } = get();
      if (location === THIS_PC) return;
      const parents = tagIdOf(location) != null
        ? [...new Set(entries.map((e) => parentOf(e.path)).filter((p): p is string => !!p))]
        : [location];
      const metas = await Promise.all(parents.map((p) => api.getFolderMeta(p)));
      set({ meta: new Map(metas.flat().map((m) => [pathKey(m.path), m])) });
      recompute();
    },

    refreshTags: async () => {
      set({ tags: await api.listTags() });
    },

    refreshDrives: async () => {
      set({ drives: await api.getDrives() });
    },

    toast: (text, kind = "info") => {
      const id = ++toastId;
      set({ toasts: [...get().toasts, { id, text, kind }] });
      window.setTimeout(() => get().dismissToast(id), kind === "error" ? 6000 : 2500);
    },

    dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  };
});
