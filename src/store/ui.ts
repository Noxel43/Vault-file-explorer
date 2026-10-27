import { create } from "zustand";

export interface ContextMenuState {
  x: number;
  y: number;
  kind: "item" | "background";
}

export interface ConfirmState {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
}

export type SettingsTab = "general" | "appearance" | "modules" | "tags" | "about";

interface UiStore {
  contextMenu: ContextMenuState | null;
  confirm: ConfirmState | null;
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  editingPath: boolean;
  /** Incremented to ask a component to take keyboard focus. */
  focusSearchToken: number;
  focusTagInputToken: number;
  /** Columns in the grid view, so arrow keys can move vertically. */
  gridColumns: number;

  openContextMenu: (m: ContextMenuState) => void;
  closeContextMenu: () => void;
  askConfirm: (c: ConfirmState) => void;
  closeConfirm: () => void;
  openSettings: (tab?: SettingsTab) => void;
  closeSettings: () => void;
  setEditingPath: (v: boolean) => void;
  focusSearch: () => void;
  focusTagInput: () => void;
  setGridColumns: (n: number) => void;
}

export const useUi = create<UiStore>((set, get) => ({
  contextMenu: null,
  confirm: null,
  settingsOpen: false,
  settingsTab: "general",
  editingPath: false,
  focusSearchToken: 0,
  focusTagInputToken: 0,
  gridColumns: 1,

  openContextMenu: (contextMenu) => set({ contextMenu }),
  closeContextMenu: () => set({ contextMenu: null }),
  askConfirm: (confirm) => set({ confirm }),
  closeConfirm: () => set({ confirm: null }),
  openSettings: (tab) => set({ settingsOpen: true, settingsTab: tab ?? get().settingsTab }),
  closeSettings: () => set({ settingsOpen: false }),
  setEditingPath: (editingPath) => set({ editingPath }),
  focusSearch: () => set({ focusSearchToken: get().focusSearchToken + 1 }),
  focusTagInput: () => set({ focusTagInputToken: get().focusTagInputToken + 1 }),
  setGridColumns: (gridColumns) => set({ gridColumns }),
}));
