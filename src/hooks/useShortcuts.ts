import { useEffect } from "react";
import { requestDelete } from "../components/actions";
import { useExplorer } from "../store/explorer";
import { useSettings } from "../store/settings";
import { useUi } from "../store/ui";

function isTyping(el: EventTarget | null) {
  const t = el as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

/** Global keyboard shortcuts. Kept in one place so they're easy to find and rebind later. */
export function useShortcuts() {
  useEffect(() => {
    let typeAhead = "";
    let typeAheadTimer: number | undefined;

    const onKey = (e: KeyboardEvent) => {
      const ui = useUi.getState();
      if (ui.settingsOpen || ui.confirm) return;
      if (ui.contextMenu) {
        if (e.key === "Escape") ui.closeContextMenu();
        return;
      }
      const ex = useExplorer.getState();
      const settings = useSettings.getState();
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key;
      const typing = isTyping(e.target);

      const handled = (fn: () => void) => {
        e.preventDefault();
        fn();
      };

      // Shortcuts that work even while typing in a field.
      if (ctrl && key.toLowerCase() === "l") return handled(() => ui.setEditingPath(true));
      if (e.altKey && key.toLowerCase() === "d") return handled(() => ui.setEditingPath(true));
      if (ctrl && !e.shiftKey && key.toLowerCase() === "f") return handled(() => ui.focusSearch());
      if (ctrl && e.shiftKey && key.toLowerCase() === "f")
        return handled(() => settings.update({ filterBarOpen: !settings.filterBarOpen }));
      if (ctrl && key === ",") return handled(() => ui.openSettings());
      if (key === "F5" || (ctrl && key.toLowerCase() === "r")) return handled(() => ex.refresh());
      if (e.altKey && key === "ArrowLeft") return handled(ex.back);
      if (e.altKey && key === "ArrowRight") return handled(ex.forward);
      if (e.altKey && key === "ArrowUp") return handled(ex.up);
      if (typing) return;

      const grid = ex.view.mode === "grid";
      const cols = grid ? ui.gridColumns : 1;

      switch (true) {
        case key === "Backspace":
          return handled(ex.back);
        case key === "ArrowDown":
          return handled(() => ex.moveFocus(cols, e.shiftKey));
        case key === "ArrowUp":
          return handled(() => ex.moveFocus(-cols, e.shiftKey));
        case grid && key === "ArrowRight":
          return handled(() => ex.moveFocus(1, e.shiftKey));
        case grid && key === "ArrowLeft":
          return handled(() => ex.moveFocus(-1, e.shiftKey));
        case key === "PageDown":
          return handled(() => ex.moveFocus(cols * 15, e.shiftKey));
        case key === "PageUp":
          return handled(() => ex.moveFocus(-cols * 15, e.shiftKey));
        case key === "Home":
          return handled(() => ex.moveFocus(-ex.visible.length, e.shiftKey));
        case key === "End":
          return handled(() => ex.moveFocus(ex.visible.length, e.shiftKey));
        case key === "Enter": {
          const sel = ex.selectedEntries();
          if (sel.length === 1) return handled(() => ex.open(sel[0]));
          const files = sel.filter((s) => !s.isDir);
          if (files.length) return handled(() => files.forEach((f) => ex.open(f)));
          return;
        }
        case key === "F2":
          return handled(() => ex.startRename());
        case key === "Delete":
          return handled(() => requestDelete(e.shiftKey));
        case key === "Escape":
          if (ex.selected.size) return handled(ex.clearSelection);
          if (ex.filters.query) return handled(() => ex.setFilters({ query: "" }));
          return;
        case ctrl && key.toLowerCase() === "a":
          return handled(ex.selectAll);
        case ctrl && e.shiftKey && key.toLowerCase() === "c":
          return handled(() => navigator.clipboard.writeText(ex.selectedEntries().map((x) => x.path).join("\n")));
        case ctrl && key.toLowerCase() === "c":
          return handled(() => ex.copySelected("copy"));
        case ctrl && key.toLowerCase() === "x":
          return handled(() => ex.copySelected("cut"));
        case ctrl && key.toLowerCase() === "v":
          return handled(ex.paste);
        case ctrl && e.shiftKey && key.toLowerCase() === "n":
          return handled(ex.newFolder);
        case ctrl && key === "1":
          return handled(() => ex.setView({ mode: "details" }));
        case ctrl && key === "2":
          return handled(() => ex.setView({ mode: "list" }));
        case ctrl && key === "3":
          return handled(() => ex.setView({ mode: "grid" }));
        case ctrl && key.toLowerCase() === "h":
          return handled(() => ex.setView({ showHidden: !ex.view.showHidden }));
        case ctrl && key.toLowerCase() === "i":
          return handled(() => settings.update({ panelOpen: !settings.panelOpen }));
        case ctrl && key.toLowerCase() === "b":
          return handled(() => settings.update({ sidebarOpen: !settings.sidebarOpen }));
      }

      // Type-ahead: jump to the first item whose name starts with what's typed.
      if (key.length === 1 && !ctrl && !e.altKey) {
        typeAhead += key.toLowerCase();
        window.clearTimeout(typeAheadTimer);
        typeAheadTimer = window.setTimeout(() => (typeAhead = ""), 800);
        const match = ex.visible.find((x) => x.lower.startsWith(typeAhead));
        if (match) ex.select(match.path);
      }
    };

    // Mouse back/forward buttons.
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3) useExplorer.getState().back();
      if (e.button === 4) useExplorer.getState().forward();
    };

    window.addEventListener("keydown", onKey);
    window.addEventListener("mouseup", onMouse);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mouseup", onMouse);
    };
  }, []);
}
