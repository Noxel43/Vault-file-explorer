import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { ContextMenu } from "./components/ContextMenu";
import { FileView } from "./components/FileView";
import { FilterBar } from "./components/FilterBar";
import { MetaPanel } from "./components/MetaPanel";
import { ConfirmDialog, Toasts } from "./components/Overlays";
import { SettingsDialog } from "./components/SettingsDialog";
import { SearchHeader } from "./components/SearchHeader";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { PreviewPane } from "./components/preview/PreviewPane";
import { ThisPc } from "./components/ThisPc";
import { Toolbar } from "./components/Toolbar";
import { useShortcuts } from "./hooks/useShortcuts";
import { SEARCH, THIS_PC, pathKey } from "./lib/path";
import { useExplorer } from "./store/explorer";
import { useModule, useSettings } from "./store/settings";
import { api } from "./lib/api";
import type { IndexStatus } from "./lib/types";
import "./styles/tokens.css";
import "./styles/app.css";

const MIN_MAIN_WIDTH = 320;
const MIN_PREVIEW_WIDTH = 220;

/** Drag handle between panes. `side` says which edge of the handle the pane sits on. */
function Resizer({ value, onChange, side, min, max }: {
  value: number;
  onChange: (v: number) => void;
  side: "left" | "right";
  min: number;
  max: number;
}) {
  return (
    <div
      className="resizer"
      onPointerDown={(e) => {
        e.preventDefault();
        const startX = e.clientX;
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        el.classList.add("dragging");
        const move = (ev: PointerEvent) => {
          const delta = side === "left" ? ev.clientX - startX : startX - ev.clientX;
          onChange(Math.round(Math.max(min, Math.min(max, value + delta))));
        };
        const up = () => {
          el.classList.remove("dragging");
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
      }}
    />
  );
}

function useWindowWidth() {
  const [width, setWidth] = useState(window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

function useAppearance() {
  const theme = useSettings((s) => s.theme);
  const accent = useSettings((s) => s.accent);
  const density = useSettings((s) => s.density);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.dataset.density = density;
    if (accent) root.style.setProperty("--accent", accent);
    else root.style.removeProperty("--accent");
  }, [theme, accent, density]);
}

/** Refresh the listing when the watched folder changes on disk. */
function useLiveUpdates() {
  const enabled = useModule("watcher");
  useEffect(() => {
    if (!enabled) {
      api.unwatchDir().catch(() => {});
      return;
    }
    const loc = useExplorer.getState().location;
    if (loc && !loc.startsWith("vault:")) api.watchDir(loc).catch(() => {});
    let timer: number | undefined;
    const unlisten = listen<string>("fs-change", (e) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const s = useExplorer.getState();
        if (pathKey(s.location) === pathKey(e.payload) && !s.renaming) s.refresh();
      }, 200);
    });
    return () => {
      window.clearTimeout(timer);
      unlisten.then((f) => f());
    };
  }, [enabled]);
}

/** Keeps the background index running while the search module is on. */
function useIndexer() {
  const enabled = useModule("search");
  const loaded = useSettings((s) => s.loaded);
  const roots = useSettings((s) => s.indexRoots);
  const excludes = useSettings((s) => s.indexExcludes);

  useEffect(() => {
    if (!loaded) return;
    const ex = useExplorer.getState();
    if (!enabled) {
      api.indexStop().catch(console.error);
      ex.setIndexStatus(null);
      if (ex.location === SEARCH) ex.navigate(THIS_PC);
      return;
    }
    (async () => {
      const fixed = roots ?? (await api.getDrives()).filter((d) => d.kind === "fixed").map((d) => d.path);
      await api.indexStart(fixed, excludes);
      ex.setIndexStatus(await api.indexStatus());
    })().catch(console.error);
  }, [enabled, loaded, roots, excludes]);

  useEffect(() => {
    // An open search keeps up with what the index finds, at a pace it can be read at.
    let lastRun = 0;
    let wasReady = false;
    let lastRevision = -1;
    let timer: number | undefined;
    const rerun = (revision: number) => {
      window.clearTimeout(timer);
      timer = undefined;
      lastRun = Date.now();
      lastRevision = revision;
      useExplorer.getState().rerunSearch();
    };
    const unlisten = listen<IndexStatus>("index-status", ({ payload }) => {
      useExplorer.getState().setIndexStatus(payload);
      const ready = payload.state !== "loading" && payload.state !== "off";
      const justReady = ready && !wasReady;
      wasReady = ready;
      if (justReady) return rerun(payload.revision);
      if (payload.revision === lastRevision) return;
      // Always catches up afterwards: there may be no further change to trigger it.
      window.clearTimeout(timer);
      timer = window.setTimeout(() => rerun(payload.revision), Math.max(0, lastRun + 2000 - Date.now()));
    });
    return () => {
      window.clearTimeout(timer);
      unlisten.then((f) => f());
    };
  }, []);
}

export default function App() {
  const loaded = useSettings((s) => s.loaded);
  const sidebarOpen = useSettings((s) => s.sidebarOpen);
  const sidebarWidth = useSettings((s) => s.sidebarWidth);
  const panelOpen = useSettings((s) => s.panelOpen);
  const panelWidth = useSettings((s) => s.panelWidth);
  const previewOpen = useSettings((s) => s.previewOpen);
  const previewWidth = useSettings((s) => s.previewWidth);
  const filterBarOpen = useSettings((s) => s.filterBarOpen);
  const update = useSettings((s) => s.update);
  const location = useExplorer((s) => s.location);
  const filtersOn = useModule("filters");
  const metadataOn = useModule("metadata");
  const previewOn = useModule("preview");
  const statusOn = useModule("statusbar");
  const windowWidth = useWindowWidth();

  useAppearance();
  useLiveUpdates();
  useIndexer();
  useShortcuts();

  useEffect(() => {
    useSettings
      .getState()
      .load()
      .catch(console.error)
      .finally(() => useExplorer.getState().init());
  }, []);

  if (!loaded) return <div className="app booting" />;

  const onThisPc = location === THIS_PC;

  // The file list always keeps some room: in a narrow window the preview gives up width first,
  // then the metadata panel steps aside until there is space for both.
  const showPreview = previewOn && previewOpen;
  const room = windowWidth - (sidebarOpen ? sidebarWidth : 0) - MIN_MAIN_WIDTH;
  const showPanel = metadataOn && panelOpen && (!showPreview || room - panelWidth >= MIN_PREVIEW_WIDTH);
  const previewMax = Math.max(MIN_PREVIEW_WIDTH, room - (showPanel ? panelWidth : 0));
  const previewShown = Math.min(previewWidth, previewMax);

  return (
    <div className="app" onContextMenu={(e) => e.preventDefault()}>
      <Toolbar />
      <div className="body">
        {sidebarOpen && (
          <>
            <Sidebar width={sidebarWidth} />
            <Resizer value={sidebarWidth} onChange={(v) => update({ sidebarWidth: v })} side="left" min={160} max={420} />
          </>
        )}
        <main className="main">
          {location === SEARCH && <SearchHeader />}
          {filtersOn && filterBarOpen && !onThisPc && <FilterBar />}
          {onThisPc ? <ThisPc /> : <FileView />}
        </main>
        {showPreview && (
          <>
            <Resizer
              value={previewShown}
              onChange={(v) => update({ previewWidth: v })}
              side="right"
              min={MIN_PREVIEW_WIDTH}
              max={previewMax}
            />
            <PreviewPane width={previewShown} />
          </>
        )}
        {showPanel && (
          <>
            <Resizer value={panelWidth} onChange={(v) => update({ panelWidth: v })} side="right" min={240} max={560} />
            <MetaPanel width={panelWidth} />
          </>
        )}
      </div>
      {statusOn && <StatusBar />}
      <ContextMenu />
      <SettingsDialog />
      <ConfirmDialog />
      <Toasts />
    </div>
  );
}
