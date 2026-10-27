import { ExternalLink, Pencil, Plus, Star, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { CATEGORY_LABELS, typeLabel } from "../lib/fileTypes";
import { formatDateFull, formatSize, numberFmt } from "../lib/format";
import { THIS_PC, baseName, isVirtual, pathKey } from "../lib/path";
import type { Entry, FileMeta, Tag } from "../lib/types";
import { useExplorer } from "../store/explorer";
import { useModule } from "../store/settings";
import { useUi } from "../store/ui";
import { FileIcon, Thumbnail } from "./FileIcon";

// ------------------------------------------------------------------ tag editor

function TagEditor({
  tags,
  onAdd,
  onRemove,
}: {
  tags: Tag[];
  onAdd: (name: string) => void;
  onRemove: (tag: Tag) => void;
}) {
  const allTags = useExplorer((s) => s.tags);
  const token = useUi((s) => s.focusTagInputToken);
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [navigated, setNavigated] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (token) inputRef.current?.focus();
  }, [token]);

  const suggestions = useMemo(() => {
    const q = draft.trim().toLowerCase();
    const have = new Set(tags.map((t) => t.id));
    return allTags.filter((t) => !have.has(t.id) && (!q || t.name.toLowerCase().includes(q))).slice(0, 8);
  }, [draft, allTags, tags]);

  const exact = suggestions.some((t) => t.name.toLowerCase() === draft.trim().toLowerCase());

  const add = (name: string) => {
    if (!name.trim()) return;
    onAdd(name.trim());
    setDraft("");
    setHi(0);
    setNavigated(false);
  };

  return (
    <div className="tag-editor">
      <div className="tag-list">
        {tags.map((t) => (
          <span key={t.id} className="tag-chip" style={{ "--tag": t.color } as React.CSSProperties}>
            {t.name}
            <button onClick={() => onRemove(t)} title={`Remove ${t.name}`}>
              <X size={11} />
            </button>
          </span>
        ))}
        <div className="tag-input-wrap">
          <input
            ref={inputRef}
            className="tag-input"
            value={draft}
            placeholder={tags.length ? "Add…" : "Add a tag…"}
            onChange={(e) => {
              setDraft(e.target.value);
              setOpen(true);
              setHi(0);
              setNavigated(false);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 120)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setNavigated(true);
                setHi((h) => Math.min(h + 1, suggestions.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setNavigated(true);
                setHi((h) => Math.max(h - 1, 0));
              } else if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                // Typed text wins unless the user picked a suggestion with the arrows
                // or the text is empty (then take the highlighted suggestion).
                const pick = suggestions[hi];
                add(pick && (navigated || !draft.trim()) ? pick.name : draft);
              } else if (e.key === "Backspace" && !draft && tags.length) {
                onRemove(tags[tags.length - 1]);
              } else if (e.key === "Escape") {
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
          {open && (suggestions.length > 0 || (draft.trim() && !exact)) && (
            <div className="suggestions">
              {suggestions.map((t, i) => (
                <button
                  key={t.id}
                  className={i === hi ? "hi" : ""}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    add(t.name);
                  }}
                >
                  <span className="tag-dot" style={{ background: t.color }} />
                  {t.name}
                </button>
              ))}
              {draft.trim() && !exact && (
                <button
                  onMouseDown={(e) => {
                    e.preventDefault();
                    add(draft);
                  }}
                >
                  <Plus size={12} /> Create “{draft.trim()}”
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ keywords

function KeywordEditor({ keywords, onChange }: { keywords: string[]; onChange: (k: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const parts = draft.split(",").map((s) => s.trim()).filter(Boolean);
    const next = [...keywords];
    for (const p of parts) if (!next.some((k) => k.toLowerCase() === p.toLowerCase())) next.push(p);
    if (next.length !== keywords.length) onChange(next);
    setDraft("");
  };
  return (
    <div className="tag-list">
      {keywords.map((k) => (
        <span key={k} className="kw-chip">
          {k}
          <button onClick={() => onChange(keywords.filter((x) => x !== k))} title={`Remove ${k}`}>
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        className="tag-input"
        value={draft}
        placeholder={keywords.length ? "Add…" : "Add keywords…"}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={add}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          } else if (e.key === "Backspace" && !draft && keywords.length) {
            onChange(keywords.slice(0, -1));
          }
        }}
      />
    </div>
  );
}

function Rating({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [hover, setHover] = useState(0);
  const shown = hover || value;
  return (
    <div className="rating" onMouseLeave={() => setHover(0)}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          onMouseEnter={() => setHover(n)}
          onClick={() => onChange(value === n ? 0 : n)}
          title={value === n ? "Clear rating" : `${n} star${n > 1 ? "s" : ""}`}
        >
          <Star size={15} className={n <= shown ? "on" : ""} fill={n <= shown ? "currentColor" : "none"} />
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ single item

function useMetaEditor(path: string) {
  const [meta, setMeta] = useState<FileMeta | null>(null);
  const [description, setDescription] = useState("");
  const pending = useRef<{ path: string; description: string; keywords: string[]; rating: number } | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    const p = pending.current;
    pending.current = null;
    if (!p) return;
    try {
      const saved = await api.setMeta(p.path, p.description, p.keywords, p.rating);
      if (saved.path === path) setMeta(saved);
      useExplorer.getState().refreshMeta();
    } catch (e) {
      useExplorer.getState().toast(String(e), "error");
    }
  }, [path]);

  useEffect(() => {
    let cancelled = false;
    setMeta(null);
    api.getMeta(path).then((m) => {
      if (cancelled) return;
      setMeta(m);
      setDescription(m.description);
    });
    return () => {
      cancelled = true;
      flush(); // save edits for the previous file before switching
    };
  }, [path, flush]);

  // Pick up changes made elsewhere (multi-select tagging, another window, …) without
  // clobbering a description that's being typed.
  const signature = useExplorer((s) => {
    const m = s.meta.get(pathKey(path));
    return m ? `${m.tagIds.join(",")}|${m.rating}|${m.hasNotes}` : "";
  });
  const firstSignature = useRef(true);
  useEffect(() => {
    if (firstSignature.current) {
      firstSignature.current = false;
      return;
    }
    if (pending.current) return;
    let cancelled = false;
    api.getMeta(path).then((m) => {
      if (cancelled || pending.current) return;
      setMeta(m);
      if (!document.activeElement?.classList.contains("desc-input")) setDescription(m.description);
    });
    return () => {
      cancelled = true;
    };
  }, [signature, path]);

  const save = (patch: Partial<{ description: string; keywords: string[]; rating: number }>, delay = 0) => {
    if (!meta) return;
    const base = pending.current ?? { path, description: meta.description, keywords: meta.keywords, rating: meta.rating };
    pending.current = { ...base, ...patch };
    setMeta({ ...meta, ...patch });
    window.clearTimeout(timer.current);
    if (delay) timer.current = window.setTimeout(flush, delay);
    else flush();
  };

  const reloadTags = async () => {
    const m = await api.getMeta(path);
    setMeta((cur) => (cur ? { ...cur, tags: m.tags } : m));
    const s = useExplorer.getState();
    s.refreshTags();
    s.refreshMeta();
  };

  return { meta, description, setDescription, save, reloadTags };
}

function Property({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="prop">
      <div className="prop-label">{label}</div>
      <div className="prop-value">{children}</div>
    </div>
  );
}

function SingleItem({ entry, isCurrentFolder }: { entry: Entry; isCurrentFolder?: boolean }) {
  const { meta, description, setDescription, save, reloadTags } = useMetaEditor(entry.path);
  const thumbs = useModule("thumbnails");
  const startRename = useExplorer((s) => s.startRename);

  return (
    <>
      <div className="panel-hero">
        <div className="panel-visual">
          {thumbs && entry.category === "image" ? (
            <Thumbnail entry={entry} size={180} />
          ) : (
            <FileIcon category={entry.category} size={56} />
          )}
        </div>
        <div className="panel-title-row">
          <div className="panel-title" title={entry.name}>{entry.name}</div>
          {!isCurrentFolder && (
            <button className="icon-btn small" title="Rename (F2)" onClick={() => startRename(entry.path)}>
              <Pencil size={13} />
            </button>
          )}
        </div>
        <div className="panel-sub">
          {isCurrentFolder ? "Current folder" : typeLabel(entry.ext, entry.isDir)}
          {!entry.isDir && ` · ${formatSize(entry.size)}`}
        </div>
      </div>

      <section className="panel-section">
        <div className="section-label">Tags</div>
        <TagEditor
          tags={meta?.tags ?? []}
          onAdd={async (name) => {
            await api.addTag([entry.path], name);
            reloadTags();
          }}
          onRemove={async (t) => {
            await api.removeTag([entry.path], t.id);
            reloadTags();
          }}
        />
      </section>

      <section className="panel-section">
        <div className="section-label">Rating</div>
        <Rating value={meta?.rating ?? 0} onChange={(rating) => save({ rating })} />
      </section>

      <section className="panel-section">
        <div className="section-label">Description</div>
        <textarea
          className="desc-input"
          value={description}
          placeholder="Add a description…"
          rows={3}
          onChange={(e) => {
            setDescription(e.target.value);
            save({ description: e.target.value }, 600);
          }}
          onBlur={() => meta && description !== meta.description && save({ description })}
        />
      </section>

      <section className="panel-section">
        <div className="section-label">Keywords</div>
        <KeywordEditor keywords={meta?.keywords ?? []} onChange={(keywords) => save({ keywords })} />
      </section>

      <section className="panel-section props">
        <Property label="Location">
          <span className="selectable">{entry.path}</span>
        </Property>
        {!entry.isDir && <Property label="Size">{formatSize(entry.size)} ({numberFmt.format(entry.size)} bytes)</Property>}
        <Property label="Modified">{formatDateFull(entry.modified)}</Property>
        <Property label="Created">{formatDateFull(entry.created)}</Property>
        <Property label="Attributes">
          {[entry.readonly && "Read-only", entry.hidden && "Hidden", entry.system && "System", entry.symlink && "Link"]
            .filter(Boolean)
            .join(", ") || "None"}
        </Property>
        <button className="btn ghost small" onClick={() => api.revealPath(entry.path)}>
          <ExternalLink size={13} /> Show in Windows Explorer
        </button>
      </section>
    </>
  );
}

// ------------------------------------------------------------------ multi selection

function MultiItems({ entries }: { entries: Entry[] }) {
  const meta = useExplorer((s) => s.meta);
  const allTags = useExplorer((s) => s.tags);
  const files = entries.filter((e) => !e.isDir);
  const totalSize = files.reduce((n, e) => n + e.size, 0);
  const paths = entries.map((e) => e.path);

  const byCategory = useMemo(() => {
    const c = new Map<string, number>();
    for (const e of entries) c.set(CATEGORY_LABELS[e.category], (c.get(CATEGORY_LABELS[e.category]) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1]);
  }, [entries]);

  // Tags present on every selected item.
  const common = useMemo(() => {
    const lists = entries.map((e) => meta.get(pathKey(e.path))?.tagIds ?? []);
    const shared = lists.reduce<number[]>((acc, ids, i) => (i === 0 ? ids : acc.filter((id) => ids.includes(id))), []);
    return allTags.filter((t) => shared.includes(t.id));
  }, [entries, meta, allTags]);

  const after = () => {
    const s = useExplorer.getState();
    s.refreshTags();
    s.refreshMeta();
  };

  return (
    <>
      <div className="panel-hero">
        <div className="panel-visual stack">
          <FileIcon category={entries[0].category} size={48} />
        </div>
        <div className="panel-title">{numberFmt.format(entries.length)} items selected</div>
        <div className="panel-sub">
          {files.length > 0 && `${formatSize(totalSize)} in ${numberFmt.format(files.length)} files`}
        </div>
      </div>
      <section className="panel-section">
        <div className="section-label">Tags on all selected</div>
        <TagEditor
          tags={common}
          onAdd={async (name) => {
            await api.addTag(paths, name);
            after();
          }}
          onRemove={async (t) => {
            await api.removeTag(paths, t.id);
            after();
          }}
        />
      </section>
      <section className="panel-section props">
        {byCategory.map(([label, n]) => (
          <Property key={label} label={label}>{numberFmt.format(n)}</Property>
        ))}
      </section>
    </>
  );
}

// ------------------------------------------------------------------ panel

export function MetaPanel({ width }: { width: number }) {
  const selected = useExplorer((s) => s.selected);
  const entries = useExplorer((s) => s.entries);
  const location = useExplorer((s) => s.location);
  const total = useExplorer((s) => s.entries.length);

  const selection = useMemo(() => entries.filter((e) => selected.has(e.path)), [entries, selected]);

  // With nothing selected, show the folder itself so it can be tagged/described too.
  const [folderEntry, setFolderEntry] = useState<Entry | null>(null);
  useEffect(() => {
    if (isVirtual(location)) return setFolderEntry(null);
    let cancelled = false;
    const base: Entry = {
      name: baseName(location) || location,
      path: location,
      isDir: true,
      size: 0,
      modified: 0,
      created: 0,
      hidden: false,
      system: false,
      readonly: false,
      symlink: false,
      lower: "",
      ext: "",
      category: "folder",
    };
    setFolderEntry(base);
    api.statPaths([location]).then(([st]) => {
      if (!cancelled && st) setFolderEntry({ ...base, ...st, name: base.name, path: location, isDir: true });
    });
    return () => {
      cancelled = true;
    };
  }, [location]);

  let body: React.ReactNode;
  if (selection.length === 1) body = <SingleItem key={selection[0].path} entry={selection[0]} />;
  else if (selection.length > 1) body = <MultiItems entries={selection} />;
  else if (folderEntry) body = <SingleItem key={folderEntry.path} entry={folderEntry} isCurrentFolder />;
  else
    body = (
      <div className="panel-placeholder">
        {location === THIS_PC ? "Select a drive or folder to get started." : `${numberFmt.format(total)} tagged items`}
      </div>
    );

  return (
    <aside className="metapanel" style={{ width }}>
      {body}
    </aside>
  );
}
