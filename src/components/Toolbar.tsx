import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronRight,
  FolderPlus,
  LayoutGrid,
  List,
  PanelLeft,
  PanelRight,
  RotateCw,
  Rows3,
  Search,
  Settings,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { activeFilterCount } from "../lib/filters";
import { THIS_PC, crumbs, isVirtual, tagIdOf, type Crumb } from "../lib/path";
import type { ViewMode } from "../lib/types";
import { useExplorer } from "../store/explorer";
import { useModule, useSettings } from "../store/settings";
import { useUi } from "../store/ui";

function IconButton({
  title,
  onClick,
  disabled,
  active,
  children,
  badge,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
  badge?: number;
}) {
  return (
    <button className={`icon-btn${active ? " active" : ""}`} title={title} onClick={onClick} disabled={disabled}>
      {children}
      {!!badge && <span className="badge">{badge}</span>}
    </button>
  );
}

const ELLIPSIS = "vault:ellipsis";

function PathInput({ location }: { location: string }) {
  const goToInput = useExplorer((s) => s.goToInput);
  const setEditing = useUi((s) => s.setEditingPath);
  const inputRef = useRef<HTMLInputElement>(null);
  // Initialised synchronously so keystrokes typed right after Ctrl+L aren't lost.
  const [draft, setDraft] = useState(() => (isVirtual(location) ? "" : location));

  useEffect(() => inputRef.current?.select(), []);

  return (
    <div className="pathbar editing">
      <input
        ref={inputRef}
        autoFocus
        className="path-input"
        value={draft}
        spellCheck={false}
        placeholder="Type a path, e.g. C:\Users or %APPDATA%"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => setEditing(false)}
        onKeyDown={async (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (await goToInput(draft)) setEditing(false);
          } else if (e.key === "Escape") {
            setEditing(false);
          }
        }}
      />
    </div>
  );
}

function PathBar() {
  const location = useExplorer((s) => s.location);
  const tags = useExplorer((s) => s.tags);
  const navigate = useExplorer((s) => s.navigate);
  const editing = useUi((s) => s.editingPath);
  const setEditing = useUi((s) => s.setEditingPath);

  if (editing) return <PathInput location={location} />;

  const tagId = tagIdOf(location);
  let parts: (Crumb & { title?: string })[] =
    tagId != null
      ? [
          { label: "Tags", path: "" },
          { label: tags.find((t) => t.id === tagId)?.name ?? "Tag", path: location },
        ]
      : crumbs(location);
  // Deep paths: keep the root, drive and last three folders; "…" opens the full path for editing.
  if (parts.length > 6) {
    const hidden = parts.slice(2, -3);
    parts = [...parts.slice(0, 2), { label: "…", path: ELLIPSIS, title: hidden.map((p) => p.label).join("\\") }, ...parts.slice(-3)];
  }

  return (
    <div className="pathbar" onClick={(e) => e.target === e.currentTarget && setEditing(true)} title="Click to type a path (Ctrl+L)">
      {parts.map((c, i) => (
        <span key={c.path + i} className="crumb-wrap">
          {i > 0 && <ChevronRight size={13} className="crumb-sep" />}
          <button
            className={`crumb${i === parts.length - 1 ? " current" : ""}`}
            onClick={() => (c.path === ELLIPSIS ? setEditing(true) : c.path && navigate(c.path))}
            disabled={!c.path}
            title={c.title}
          >
            {c.label}
          </button>
        </span>
      ))}
    </div>
  );
}

function SearchBox() {
  const query = useExplorer((s) => s.filters.query);
  const setFilters = useExplorer((s) => s.setFilters);
  const token = useUi((s) => s.focusSearchToken);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (token) ref.current?.select();
  }, [token]);

  return (
    <div className="searchbox">
      <Search size={14} className="searchbox-icon" />
      <input
        ref={ref}
        value={query}
        placeholder="Filter this folder"
        spellCheck={false}
        onChange={(e) => setFilters({ query: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setFilters({ query: "" });
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === "ArrowDown" || e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
      {query && (
        <button className="searchbox-clear" onClick={() => setFilters({ query: "" })} title="Clear">
          <X size={13} />
        </button>
      )}
    </div>
  );
}

const VIEW_MODES: { mode: ViewMode; title: string; icon: React.ReactNode }[] = [
  { mode: "details", title: "Details (Ctrl+1)", icon: <Rows3 size={16} /> },
  { mode: "list", title: "List (Ctrl+2)", icon: <List size={16} /> },
  { mode: "grid", title: "Grid (Ctrl+3)", icon: <LayoutGrid size={16} /> },
];

export function Toolbar() {
  const s = useExplorer();
  const filtersOn = useModule("filters");
  const metaOn = useModule("metadata");
  const filterBarOpen = useSettings((x) => x.filterBarOpen);
  const sidebarOpen = useSettings((x) => x.sidebarOpen);
  const panelOpen = useSettings((x) => x.panelOpen);
  const update = useSettings((x) => x.update);
  const openSettings = useUi((x) => x.openSettings);
  const virtual = isVirtual(s.location);
  const advancedCount = activeFilterCount({ ...s.filters, query: "" });

  return (
    <header className="toolbar">
      <div className="toolbar-group">
        <IconButton title="Toggle sidebar (Ctrl+B)" onClick={() => update({ sidebarOpen: !sidebarOpen })}>
          <PanelLeft size={16} />
        </IconButton>
        <IconButton title="Back (Alt+Left)" onClick={s.back} disabled={s.historyIndex <= 0}>
          <ArrowLeft size={16} />
        </IconButton>
        <IconButton title="Forward (Alt+Right)" onClick={s.forward} disabled={s.historyIndex >= s.history.length - 1}>
          <ArrowRight size={16} />
        </IconButton>
        <IconButton title="Up (Alt+Up)" onClick={s.up} disabled={s.location === THIS_PC}>
          <ArrowUp size={16} />
        </IconButton>
        <IconButton title="Refresh (F5)" onClick={s.refresh}>
          <RotateCw size={15} className={s.loading ? "spin" : undefined} />
        </IconButton>
      </div>

      <PathBar />

      {filtersOn && !(s.location === THIS_PC) && (
        <>
          <SearchBox />
          <IconButton
            title="Filters (Ctrl+Shift+F)"
            onClick={() => update({ filterBarOpen: !filterBarOpen })}
            active={filterBarOpen}
            badge={advancedCount}
          >
            <SlidersHorizontal size={16} />
          </IconButton>
        </>
      )}

      <div className="toolbar-group">
        <IconButton title="New folder (Ctrl+Shift+N)" onClick={s.newFolder} disabled={virtual}>
          <FolderPlus size={16} />
        </IconButton>
        <div className="segmented">
          {VIEW_MODES.map((v) => (
            <button
              key={v.mode}
              className={s.view.mode === v.mode ? "active" : ""}
              title={v.title}
              disabled={s.location === THIS_PC}
              onClick={() => s.setView({ mode: v.mode })}
            >
              {v.icon}
            </button>
          ))}
        </div>
        {metaOn && (
          <IconButton title="Details panel (Ctrl+I)" onClick={() => update({ panelOpen: !panelOpen })} active={panelOpen}>
            <PanelRight size={16} />
          </IconButton>
        )}
        <IconButton title="Settings (Ctrl+,)" onClick={() => openSettings()}>
          <Settings size={16} />
        </IconButton>
      </div>
    </header>
  );
}
