import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, FileText, FolderOpen, SearchX, TriangleAlert } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { typeLabel } from "../lib/fileTypes";
import { activeFilterCount } from "../lib/filters";
import { formatDate, formatSize } from "../lib/format";
import { pathKey } from "../lib/path";
import type { ColumnWidths, Entry, SortKey, Tag } from "../lib/types";
import { useExplorer } from "../store/explorer";
import { useModule, useSettings } from "../store/settings";
import { useUi } from "../store/ui";
import { FileIcon, Thumbnail } from "./FileIcon";

// ------------------------------------------------------------------ shared interaction

function handleItemClick(e: React.MouseEvent, entry: Entry) {
  const s = useExplorer.getState();
  if (s.renaming === entry.path) return;
  if (e.shiftKey) s.select(entry.path, "range");
  else if (e.ctrlKey || e.metaKey) s.select(entry.path, "toggle");
  else s.select(entry.path, "single");
}

function handleItemContextMenu(e: React.MouseEvent, entry: Entry) {
  e.preventDefault();
  e.stopPropagation();
  const s = useExplorer.getState();
  if (!s.selected.has(entry.path)) s.select(entry.path, "single");
  useUi.getState().openContextMenu({ x: e.clientX, y: e.clientY, kind: "item" });
}

function handleBackgroundMouseDown(e: React.MouseEvent) {
  if ((e.target as HTMLElement).closest("[data-item]")) return;
  if (e.button === 0 && !e.ctrlKey && !e.shiftKey) useExplorer.getState().clearSelection();
}

function handleBackgroundContextMenu(e: React.MouseEvent) {
  if ((e.target as HTMLElement).closest("[data-item]")) return;
  e.preventDefault();
  useExplorer.getState().clearSelection();
  useUi.getState().openContextMenu({ x: e.clientX, y: e.clientY, kind: "background" });
}

function RenameInput({ entry, className }: { entry: Entry; className?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const [value, setValue] = useState(entry.name);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const dot = entry.isDir ? -1 : entry.name.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
  }, [entry]);

  const commit = () => {
    if (done.current) return;
    done.current = true;
    useExplorer.getState().commitRename(entry.path, value);
  };

  return (
    <input
      ref={ref}
      className={`rename-input ${className ?? ""}`}
      value={value}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit();
        if (e.key === "Escape") {
          done.current = true;
          useExplorer.getState().cancelRename();
        }
      }}
    />
  );
}

function TagDots({ tags }: { tags: Tag[] }) {
  if (!tags.length) return null;
  return (
    <span className="tag-dots" title={tags.map((t) => t.name).join(", ")}>
      {tags.slice(0, 4).map((t) => (
        <span key={t.id} className="tag-dot" style={{ background: t.color }} />
      ))}
    </span>
  );
}

function useEntryTags() {
  const meta = useExplorer((s) => s.meta);
  const tags = useExplorer((s) => s.tags);
  return useMemo(() => {
    const byId = new Map(tags.map((t) => [t.id, t as Tag]));
    return (entry: Entry): Tag[] => {
      const m = meta.get(pathKey(entry.path));
      if (!m) return [];
      return m.tagIds.map((id) => byId.get(id)).filter((t): t is Tag => !!t);
    };
  }, [meta, tags]);
}

function useScrollToFocus(scrollToIndex: (i: number) => void, perRow = 1) {
  const focus = useExplorer((s) => s.focus);
  const visible = useExplorer((s) => s.visible);
  useEffect(() => {
    if (!focus) return;
    const i = visible.findIndex((e) => e.path === focus);
    if (i >= 0) scrollToIndex(Math.floor(i / perRow));
  }, [focus]); // only when focus moves, not on every re-sort
}

// ------------------------------------------------------------------ details / list

const COLUMNS: { key: keyof ColumnWidths; label: string; sort?: SortKey; align?: "right" }[] = [
  { key: "name", label: "Name", sort: "name" },
  { key: "modified", label: "Date modified", sort: "modified" },
  { key: "type", label: "Type", sort: "type" },
  { key: "size", label: "Size", sort: "size", align: "right" },
  { key: "tags", label: "Tags" },
];

interface RowProps {
  entry: Entry;
  top: number;
  selected: boolean;
  focused: boolean;
  renaming: boolean;
  cut: boolean;
  tags: Tag[];
  compact: boolean;
  showTags: boolean;
}

const Row = memo(function Row({ entry, top, selected, focused, renaming, cut, tags, compact, showTags }: RowProps) {
  return (
    <div
      data-item
      className={`row${selected ? " selected" : ""}${focused ? " focused" : ""}${cut ? " cut" : ""}${entry.hidden ? " hidden-file" : ""}`}
      style={{ transform: `translateY(${top}px)` }}
      onClick={(e) => handleItemClick(e, entry)}
      onDoubleClick={() => useExplorer.getState().open(entry)}
      onContextMenu={(e) => handleItemContextMenu(e, entry)}
    >
      <div className="cell name">
        <FileIcon category={entry.category} />
        {renaming ? (
          <RenameInput entry={entry} />
        ) : (
          <span className="name-text" title={entry.name}>
            {entry.name}
          </span>
        )}
        {compact && <TagDots tags={tags} />}
      </div>
      {!compact && (
        <>
          <div className="cell dim">{formatDate(entry.modified)}</div>
          <div className="cell dim">{typeLabel(entry.ext, entry.isDir)}</div>
          <div className="cell dim right">{entry.isDir ? "" : formatSize(entry.size)}</div>
          {showTags && (
            <div className="cell tags-cell">
              {tags.map((t) => (
                <span key={t.id} className="tag-mini" style={{ "--tag": t.color } as React.CSSProperties}>
                  {t.name}
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
});

function DetailsHeader({ widths, onResize, onResizeEnd, showTags }: {
  widths: ColumnWidths;
  onResize: (key: keyof ColumnWidths, w: number) => void;
  onResizeEnd: () => void;
  showTags: boolean;
}) {
  const view = useExplorer((s) => s.view);
  const setView = useExplorer((s) => s.setView);

  const startResize = (e: React.PointerEvent, key: keyof ColumnWidths) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widths[key];
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => onResize(key, Math.max(60, startW + ev.clientX - startX));
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      onResizeEnd();
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };

  return (
    <div className="row header">
      {COLUMNS.filter((c) => showTags || c.key !== "tags").map((c) => (
        <div
          key={c.key}
          className={`cell header-cell${c.align === "right" ? " right" : ""}${c.sort ? " sortable" : ""}`}
          onClick={() => {
            if (!c.sort) return;
            if (view.sortKey === c.sort) setView({ sortDir: view.sortDir === "asc" ? "desc" : "asc" });
            else setView({ sortKey: c.sort, sortDir: c.sort === "name" || c.sort === "type" ? "asc" : "desc" });
          }}
        >
          <span>{c.label}</span>
          {view.sortKey === c.sort &&
            (view.sortDir === "asc" ? <ArrowUp size={12} className="sort-arrow" /> : <ArrowDown size={12} className="sort-arrow" />)}
          {/* Name fills the remaining width; the other columns are resizable. */}
          {c.key !== "name" && (
            <span className="col-resize" onPointerDown={(e) => startResize(e, c.key)} onClick={(e) => e.stopPropagation()} />
          )}
        </div>
      ))}
    </div>
  );
}

function RowsView({ compact }: { compact: boolean }) {
  const visible = useExplorer((s) => s.visible);
  const selected = useExplorer((s) => s.selected);
  const focus = useExplorer((s) => s.focus);
  const renaming = useExplorer((s) => s.renaming);
  const clipboard = useExplorer((s) => s.clipboard);
  const view = useExplorer((s) => s.view);
  const setView = useExplorer((s) => s.setView);
  const density = useSettings((s) => s.density);
  const metadataOn = useModule("metadata");
  // Only spend width on a Tags column when something in this folder is tagged.
  const anyTagged = useExplorer((s) => {
    for (const m of s.meta.values()) if (m.tagIds.length) return true;
    return false;
  });
  const showTags = metadataOn && !compact && anyTagged;
  const entryTags = useEntryTags();
  const parentRef = useRef<HTMLDivElement>(null);
  const rowH = density === "compact" ? 24 : 30;

  // Column widths are local while dragging so we don't re-sort on every pointer move.
  const [widths, setWidths] = useState(view.columns);
  useEffect(() => setWidths(view.columns), [view.columns]);
  const widthsRef = useRef(widths);
  widthsRef.current = widths;

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowH,
    overscan: 16,
  });
  useEffect(() => virtualizer.measure(), [rowH, virtualizer]);
  useScrollToFocus((i) => virtualizer.scrollToIndex(i, { align: "auto" }));

  const cutSet = useMemo(
    () => (clipboard?.mode === "cut" ? new Set(clipboard.paths) : null),
    [clipboard],
  );

  const template = compact
    ? "minmax(0, 1fr)"
    : [`minmax(140px, 1fr)`, `${widths.modified}px`, `${widths.type}px`, `${widths.size}px`]
        .concat(showTags ? [`${widths.tags}px`] : [])
        .join(" ");
  const minWidth = compact
    ? undefined
    : 140 + widths.modified + widths.type + widths.size + (showTags ? widths.tags : 0) + 36;

  return (
    <div
      ref={parentRef}
      className={`rows-scroll${compact ? " compact" : ""}`}
      style={{ "--cols": template, "--row-h": `${rowH}px` } as React.CSSProperties}
      onMouseDown={handleBackgroundMouseDown}
      onContextMenu={handleBackgroundContextMenu}
      tabIndex={-1}
    >
      <div style={{ minWidth }}>
        {!compact && (
          <DetailsHeader
            widths={widths}
            showTags={showTags}
            onResize={(key, w) => setWidths((cur) => ({ ...cur, [key]: w }))}
            onResizeEnd={() => setView({ columns: widthsRef.current })}
          />
        )}
        <div className="rows-body" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((v) => {
            const entry = visible[v.index];
            return (
              <Row
                key={entry.path}
                entry={entry}
                top={v.start}
                selected={selected.has(entry.path)}
                focused={focus === entry.path}
                renaming={renaming === entry.path}
                cut={!!cutSet?.has(entry.path)}
                tags={entryTags(entry)}
                compact={compact}
                showTags={showTags}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ grid

const Tile = memo(function Tile({ entry, selected, focused, renaming, cut, tags, size, thumbs }: {
  entry: Entry;
  selected: boolean;
  focused: boolean;
  renaming: boolean;
  cut: boolean;
  tags: Tag[];
  size: number;
  thumbs: boolean;
}) {
  return (
    <div
      data-item
      className={`tile${selected ? " selected" : ""}${focused ? " focused" : ""}${cut ? " cut" : ""}${entry.hidden ? " hidden-file" : ""}`}
      style={{ width: size + 24 }}
      onClick={(e) => handleItemClick(e, entry)}
      onDoubleClick={() => useExplorer.getState().open(entry)}
      onContextMenu={(e) => handleItemContextMenu(e, entry)}
      title={entry.name}
    >
      <div className="tile-visual" style={{ width: size, height: size }}>
        {thumbs && entry.category === "image" ? (
          <Thumbnail entry={entry} size={size} />
        ) : (
          <FileIcon category={entry.category} size={Math.round(size * 0.55)} />
        )}
      </div>
      {renaming ? (
        <RenameInput entry={entry} className="tile-rename" />
      ) : (
        <div className="tile-name">
          <TagDots tags={tags} />
          {entry.name}
        </div>
      )}
    </div>
  );
});

function GridView() {
  const visible = useExplorer((s) => s.visible);
  const selected = useExplorer((s) => s.selected);
  const focus = useExplorer((s) => s.focus);
  const renaming = useExplorer((s) => s.renaming);
  const clipboard = useExplorer((s) => s.clipboard);
  const iconSize = useExplorer((s) => s.view.iconSize);
  const setGridColumns = useUi((s) => s.setGridColumns);
  const thumbs = useModule("thumbnails");
  const entryTags = useEntryTags();
  const parentRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);

  useLayoutEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const tileW = iconSize + 24;
  const gap = 6;
  const cols = Math.max(1, Math.floor((width - 16 + gap) / (tileW + gap)));
  const rows = Math.ceil(visible.length / cols);
  const tileH = iconSize + 52;
  useEffect(() => setGridColumns(cols), [cols, setGridColumns]);

  const virtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => parentRef.current,
    estimateSize: () => tileH + gap,
    overscan: 4,
  });
  useEffect(() => virtualizer.measure(), [tileH, virtualizer]);
  useScrollToFocus((i) => virtualizer.scrollToIndex(i, { align: "auto" }), cols);

  const cutSet = useMemo(
    () => (clipboard?.mode === "cut" ? new Set(clipboard.paths) : null),
    [clipboard],
  );

  return (
    <div
      ref={parentRef}
      className="grid-scroll"
      onMouseDown={handleBackgroundMouseDown}
      onContextMenu={handleBackgroundContextMenu}
      onWheel={(e) => {
        if (!e.ctrlKey) return;
        const next = Math.max(48, Math.min(256, iconSize + (e.deltaY < 0 ? 16 : -16)));
        if (next !== iconSize) useExplorer.getState().setView({ iconSize: next });
      }}
      tabIndex={-1}
    >
      <div className="grid-body" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((v) => (
          <div key={v.index} className="grid-row" style={{ transform: `translateY(${v.start}px)`, gap }}>
            {visible.slice(v.index * cols, v.index * cols + cols).map((entry) => (
              <Tile
                key={entry.path}
                entry={entry}
                selected={selected.has(entry.path)}
                focused={focus === entry.path}
                renaming={renaming === entry.path}
                cut={!!cutSet?.has(entry.path)}
                tags={entryTags(entry)}
                size={iconSize}
                thumbs={thumbs}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ container

export function FileView() {
  const mode = useExplorer((s) => s.view.mode);
  const error = useExplorer((s) => s.error);
  const loading = useExplorer((s) => s.loading);
  const total = useExplorer((s) => s.entries.length);
  const shown = useExplorer((s) => s.visible.length);
  const filters = useExplorer((s) => s.filters);
  const refresh = useExplorer((s) => s.refresh);
  const clearFilters = useExplorer((s) => s.clearFilters);
  const showHidden = useExplorer((s) => s.view.showHidden);

  if (error) {
    return (
      <div className="empty-state">
        <TriangleAlert size={32} className="empty-icon danger" />
        <div className="empty-title">Can't open this location</div>
        <div className="empty-text">{error}</div>
        <button className="btn" onClick={refresh}>Try again</button>
      </div>
    );
  }

  let empty: React.ReactNode = null;
  if (!loading && shown === 0) {
    if (total === 0) {
      empty = (
        <div className="empty-state overlay" onContextMenu={handleBackgroundContextMenu}>
          <FolderOpen size={32} className="empty-icon" />
          <div className="empty-title">This folder is empty</div>
        </div>
      );
    } else if (activeFilterCount(filters) > 0) {
      empty = (
        <div className="empty-state overlay">
          <SearchX size={32} className="empty-icon" />
          <div className="empty-title">No items match your filters</div>
          <div className="empty-text">{total} items in this folder are hidden by the current filters.</div>
          <button className="btn" onClick={clearFilters}>Clear filters</button>
        </div>
      );
    } else if (!showHidden) {
      empty = (
        <div className="empty-state overlay">
          <FileText size={32} className="empty-icon" />
          <div className="empty-title">Only hidden items here</div>
          <div className="empty-text">Press Ctrl+H to show hidden files.</div>
        </div>
      );
    }
  }

  return (
    <div className="fileview">
      {mode === "grid" ? <GridView /> : <RowsView compact={mode === "list"} />}
      {empty}
    </div>
  );
}
