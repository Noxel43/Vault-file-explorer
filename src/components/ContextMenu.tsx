import {
  Check,
  ChevronRight,
  ClipboardPaste,
  Copy,
  ExternalLink,
  Eye,
  FilePlus,
  FolderOpen,
  FolderPlus,
  Info,
  Link,
  Pencil,
  RotateCw,
  Scissors,
  Tag,
  Trash,
  Undo2,
} from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { isVirtual } from "../lib/path";
import type { SortKey, ViewMode } from "../lib/types";
import { useExplorer } from "../store/explorer";
import { useModule, useSettings } from "../store/settings";
import { useUi } from "../store/ui";
import { requestDelete } from "./actions";

interface Item {
  label: string;
  icon?: React.ReactNode;
  shortcut?: string;
  onClick?: () => void;
  disabled?: boolean;
  checked?: boolean;
  danger?: boolean;
  children?: Item[];
}
type MenuEntry = Item | "sep";

function Menu({ items, x, y, onClose, flipX }: { items: MenuEntry[]; x: number; y: number; onClose: () => void; flipX?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [openSub, setOpenSub] = useState<number | null>(null);
  const [subPos, setSubPos] = useState({ x: 0, y: 0, flipX: 0 });

  // Keep the menu on screen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let nx = x;
    let ny = y;
    if (nx + r.width > window.innerWidth - 4) nx = flipX != null ? flipX - r.width + 2 : window.innerWidth - r.width - 4;
    if (ny + r.height > window.innerHeight - 4) ny = Math.max(4, window.innerHeight - r.height - 4);
    setPos({ x: Math.max(4, nx), y: ny });
  }, [x, y, flipX]);

  return (
    <div ref={ref} className="menu" style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) =>
        it === "sep" ? (
          <div key={i} className="menu-sep" />
        ) : (
          <button
            key={i}
            className={`menu-item${it.danger ? " danger" : ""}${openSub === i ? " open" : ""}`}
            disabled={it.disabled}
            onMouseEnter={(e) => {
              if (it.children) {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setSubPos({ x: r.right - 2, y: r.top - 5, flipX: r.left });
                setOpenSub(i);
              } else setOpenSub(null);
            }}
            onClick={() => {
              if (it.children) return;
              onClose();
              it.onClick?.();
            }}
          >
            <span className="menu-icon">{it.checked ? <Check size={14} /> : it.icon}</span>
            <span className="menu-label">{it.label}</span>
            {it.shortcut && <span className="menu-shortcut">{it.shortcut}</span>}
            {it.children && <ChevronRight size={13} className="menu-arrow" />}
          </button>
        ),
      )}
      {openSub != null && typeof items[openSub] === "object" && (
        <Menu items={(items[openSub] as Item).children!} x={subPos.x} y={subPos.y} flipX={subPos.flipX} onClose={onClose} />
      )}
    </div>
  );
}

const VIEW_ITEMS: { mode: ViewMode; label: string }[] = [
  { mode: "details", label: "Details" },
  { mode: "list", label: "List" },
  { mode: "grid", label: "Grid" },
];
const SORT_ITEMS: { key: SortKey; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "modified", label: "Date modified" },
  { key: "created", label: "Date created" },
  { key: "size", label: "Size" },
  { key: "type", label: "Type" },
];

export function ContextMenu() {
  const menu = useUi((s) => s.contextMenu);
  const close = useUi((s) => s.closeContextMenu);
  const s = useExplorer();
  const metaOn = useModule("metadata");
  const update = useSettings((x) => x.update);

  if (!menu) return null;
  const virtual = isVirtual(s.location);
  const sel = s.selectedEntries();
  const single = sel.length === 1 ? sel[0] : null;

  let items: MenuEntry[];
  if (menu.kind === "item" && sel.length) {
    items = [
      {
        label: single?.isDir ? "Open" : sel.length > 1 ? `Open ${sel.length} items` : "Open",
        icon: <FolderOpen size={14} />,
        shortcut: "Enter",
        onClick: () => sel.forEach((e, i) => (e.isDir ? i === 0 && s.open(e) : s.open(e))),
      },
      {
        label: "Show in Windows Explorer",
        icon: <ExternalLink size={14} />,
        onClick: () => api.revealPath(sel[0].path),
      },
      "sep",
      { label: "Cut", icon: <Scissors size={14} />, shortcut: "Ctrl+X", onClick: () => s.copySelected("cut") },
      { label: "Copy", icon: <Copy size={14} />, shortcut: "Ctrl+C", onClick: () => s.copySelected("copy") },
      {
        label: "Copy path",
        icon: <Link size={14} />,
        shortcut: "Ctrl+Shift+C",
        onClick: () => navigator.clipboard.writeText(sel.map((e) => e.path).join("\n")),
      },
      "sep",
      { label: "Rename", icon: <Pencil size={14} />, shortcut: "F2", onClick: () => s.startRename(single?.path), disabled: !single },
      { label: "Delete", icon: <Trash size={14} />, shortcut: "Del", onClick: () => requestDelete(false), danger: true },
      { label: "Delete permanently", icon: <Trash size={14} />, shortcut: "Shift+Del", onClick: () => requestDelete(true), danger: true },
    ];
    if (metaOn) {
      items.push("sep", {
        label: "Add tag…",
        icon: <Tag size={14} />,
        onClick: () => {
          update({ panelOpen: true });
          setTimeout(() => useUi.getState().focusTagInput(), 50);
        },
      }, {
        label: "Properties",
        icon: <Info size={14} />,
        shortcut: "Ctrl+I",
        onClick: () => update({ panelOpen: true }),
      });
    }
  } else {
    items = [
      {
        label: "View",
        icon: <Eye size={14} />,
        children: VIEW_ITEMS.map((v) => ({ label: v.label, checked: s.view.mode === v.mode, onClick: () => s.setView({ mode: v.mode }) })),
      },
      {
        label: "Sort by",
        icon: <ChevronRight size={14} style={{ opacity: 0 }} />,
        children: [
          ...SORT_ITEMS.map((it) => ({
            label: it.label,
            checked: s.view.sortKey === it.key,
            onClick: () => s.setView({ sortKey: it.key }),
          })),
          { label: "Ascending", checked: s.view.sortDir === "asc", onClick: () => s.setView({ sortDir: "asc" }) },
          { label: "Descending", checked: s.view.sortDir === "desc", onClick: () => s.setView({ sortDir: "desc" }) },
          { label: "Folders first", checked: s.view.foldersFirst, onClick: () => s.setView({ foldersFirst: !s.view.foldersFirst }) },
        ],
      },
      {
        label: "Show hidden files",
        checked: s.view.showHidden,
        shortcut: "Ctrl+H",
        onClick: () => s.setView({ showHidden: !s.view.showHidden }),
      },
      { label: "Refresh", icon: <RotateCw size={14} />, shortcut: "F5", onClick: s.refresh },
      "sep",
      { label: "Paste", icon: <ClipboardPaste size={14} />, shortcut: "Ctrl+V", onClick: s.paste, disabled: !s.clipboard || virtual },
      { label: "New folder", icon: <FolderPlus size={14} />, shortcut: "Ctrl+Shift+N", onClick: s.newFolder, disabled: virtual },
      { label: "New text file", icon: <FilePlus size={14} />, onClick: s.newFile, disabled: virtual },
      "sep",
      {
        label: "Copy folder path",
        icon: <Link size={14} />,
        onClick: () => navigator.clipboard.writeText(s.location),
        disabled: virtual,
      },
      {
        label: "Open in Windows Explorer",
        icon: <ExternalLink size={14} />,
        onClick: () => api.openPath(s.location),
        disabled: virtual,
      },
      {
        label: "Reset view for this folder",
        icon: <Undo2 size={14} />,
        onClick: s.resetView,
        disabled: !s.viewIsCustom || virtual,
      },
    ];
  }

  return (
    <div className="menu-backdrop" onMouseDown={close} onContextMenu={(e) => { e.preventDefault(); close(); }}>
      <div onMouseDown={(e) => e.stopPropagation()}>
        <Menu items={items} x={menu.x} y={menu.y} onClose={close} />
      </div>
    </div>
  );
}
