import { Calendar, Check, FileType2, Lock, LockOpen, Ruler, Tag, X } from "lucide-react";
import { useMemo, useState } from "react";
import { CATEGORY_LABELS, type Category } from "../lib/fileTypes";
import { activeFilterCount, type DatePreset, type Filters } from "../lib/filters";
import { formatSize, numberFmt, parseSize } from "../lib/format";
import { useExplorer } from "../store/explorer";
import { useModule } from "../store/settings";
import { FileIcon } from "./FileIcon";
import { Popover } from "./Popover";

function CheckRow({ checked, onClick, children }: { checked: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button className={`check-row${checked ? " checked" : ""}`} onClick={onClick}>
      <span className="check-box">{checked && <Check size={11} strokeWidth={3} />}</span>
      {children}
    </button>
  );
}

function TypeFilter({ filters, set }: { filters: Filters; set: (p: Partial<Filters>) => void }) {
  const entries = useExplorer((s) => s.entries);
  const counts = useMemo(() => {
    const c = new Map<Category, number>();
    for (const e of entries) c.set(e.category, (c.get(e.category) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1]);
  }, [entries]);

  const toggle = (cat: Category) =>
    set({ types: filters.types.includes(cat) ? filters.types.filter((t) => t !== cat) : [...filters.types, cat] });

  const label =
    filters.types.length === 0
      ? "Type"
      : filters.types.length === 1
        ? CATEGORY_LABELS[filters.types[0]]
        : `${filters.types.length} types`;

  return (
    <Popover label={<><FileType2 size={13} />{label}</>} active={filters.types.length > 0} width={220}>
      {counts.length === 0 && <div className="pop-empty">Nothing to filter</div>}
      {counts.map(([cat, n]) => (
        <CheckRow key={cat} checked={filters.types.includes(cat)} onClick={() => toggle(cat)}>
          <FileIcon category={cat} size={14} />
          <span className="grow">{CATEGORY_LABELS[cat]}</span>
          <span className="faint">{numberFmt.format(n)}</span>
        </CheckRow>
      ))}
      {filters.types.length > 0 && (
        <button className="pop-link" onClick={() => set({ types: [] })}>Clear</button>
      )}
    </Popover>
  );
}

const DATE_PRESETS: { id: DatePreset; label: string }[] = [
  { id: "any", label: "Any time" },
  { id: "today", label: "Today" },
  { id: "week", label: "Last 7 days" },
  { id: "month", label: "Last 30 days" },
  { id: "year", label: "Last year" },
  { id: "older", label: "Older than a year" },
  { id: "custom", label: "Custom range…" },
];

function DateFilter({ filters, set }: { filters: Filters; set: (p: Partial<Filters>) => void }) {
  const label =
    filters.datePreset === "any"
      ? "Date"
      : filters.datePreset === "custom"
        ? `${filters.dateFrom || "…"} → ${filters.dateTo || "…"}`
        : DATE_PRESETS.find((p) => p.id === filters.datePreset)!.label;
  return (
    <Popover label={<><Calendar size={13} />{label}</>} active={filters.datePreset !== "any"} width={240}>
      <div className="seg-small">
        {(["modified", "created"] as const).map((f) => (
          <button key={f} className={filters.dateField === f ? "active" : ""} onClick={() => set({ dateField: f })}>
            {f === "modified" ? "Modified" : "Created"}
          </button>
        ))}
      </div>
      {DATE_PRESETS.map((p) => (
        <CheckRow key={p.id} checked={filters.datePreset === p.id} onClick={() => set({ datePreset: p.id })}>
          <span className="grow">{p.label}</span>
        </CheckRow>
      ))}
      {filters.datePreset === "custom" && (
        <div className="pop-fields">
          <label>
            From
            <input type="date" value={filters.dateFrom} onChange={(e) => set({ dateFrom: e.target.value })} />
          </label>
          <label>
            To
            <input type="date" value={filters.dateTo} onChange={(e) => set({ dateTo: e.target.value })} />
          </label>
        </div>
      )}
    </Popover>
  );
}

const SIZE_PRESETS: { label: string; min: number | null; max: number | null }[] = [
  { label: "Empty (0 B)", min: null, max: 0 },
  { label: "Tiny (< 16 KB)", min: null, max: 16 * 1024 },
  { label: "Small (16 KB – 1 MB)", min: 16 * 1024, max: 1024 ** 2 },
  { label: "Medium (1 – 128 MB)", min: 1024 ** 2, max: 128 * 1024 ** 2 },
  { label: "Large (128 MB – 1 GB)", min: 128 * 1024 ** 2, max: 1024 ** 3 },
  { label: "Huge (> 1 GB)", min: 1024 ** 3, max: null },
];

function SizeInput({ value, onChange, placeholder }: { value: number | null; onChange: (v: number | null) => void; placeholder: string }) {
  const [text, setText] = useState(value != null ? formatSize(value) : "");
  const [bad, setBad] = useState(false);
  return (
    <input
      className={bad ? "invalid" : ""}
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value);
        if (!e.target.value.trim()) {
          setBad(false);
          onChange(null);
          return;
        }
        const v = parseSize(e.target.value);
        setBad(v == null);
        if (v != null) onChange(v);
      }}
    />
  );
}

function SizeFilter({ filters, set }: { filters: Filters; set: (p: Partial<Filters>) => void }) {
  const active = filters.sizeMin != null || filters.sizeMax != null;
  const preset = SIZE_PRESETS.find((p) => p.min === filters.sizeMin && p.max === filters.sizeMax);
  const label = !active
    ? "Size"
    : preset
      ? preset.label.split(" (")[0]
      : `${filters.sizeMin != null ? formatSize(filters.sizeMin) : "0"} – ${filters.sizeMax != null ? formatSize(filters.sizeMax) : "∞"}`;
  // Key the inputs on the values so presets update them.
  const key = `${filters.sizeMin}-${filters.sizeMax}`;
  return (
    <Popover label={<><Ruler size={13} />{label}</>} active={active} width={250}>
      {SIZE_PRESETS.map((p) => (
        <CheckRow key={p.label} checked={preset === p} onClick={() => set({ sizeMin: p.min, sizeMax: p.max })}>
          <span className="grow">{p.label}</span>
        </CheckRow>
      ))}
      <div className="pop-fields" key={key}>
        <label>
          Min
          <SizeInput value={filters.sizeMin} placeholder="e.g. 10 MB" onChange={(v) => set({ sizeMin: v })} />
        </label>
        <label>
          Max
          <SizeInput value={filters.sizeMax} placeholder="e.g. 2 GB" onChange={(v) => set({ sizeMax: v })} />
        </label>
      </div>
      {active && <button className="pop-link" onClick={() => set({ sizeMin: null, sizeMax: null })}>Clear</button>}
    </Popover>
  );
}

function TagFilter({ filters, set }: { filters: Filters; set: (p: Partial<Filters>) => void }) {
  const tags = useExplorer((s) => s.tags);
  const toggle = (id: number) =>
    set({ tagIds: filters.tagIds.includes(id) ? filters.tagIds.filter((t) => t !== id) : [...filters.tagIds, id] });
  const label =
    filters.tagIds.length === 0
      ? "Tags"
      : filters.tagIds.length === 1
        ? (tags.find((t) => t.id === filters.tagIds[0])?.name ?? "1 tag")
        : `${filters.tagIds.length} tags`;
  return (
    <Popover label={<><Tag size={13} />{label}</>} active={filters.tagIds.length > 0} width={220}>
      <div className="seg-small">
        {(["any", "all"] as const).map((m) => (
          <button key={m} className={filters.tagMode === m ? "active" : ""} onClick={() => set({ tagMode: m })}>
            {m === "any" ? "Any of" : "All of"}
          </button>
        ))}
      </div>
      {tags.length === 0 && <div className="pop-empty">No tags yet</div>}
      {tags.map((t) => (
        <CheckRow key={t.id} checked={filters.tagIds.includes(t.id)} onClick={() => toggle(t.id)}>
          <span className="tag-dot" style={{ background: t.color }} />
          <span className="grow">{t.name}</span>
        </CheckRow>
      ))}
    </Popover>
  );
}

export function FilterBar() {
  const filters = useExplorer((s) => s.filters);
  const set = useExplorer((s) => s.setFilters);
  const clear = useExplorer((s) => s.clearFilters);
  const keep = useExplorer((s) => s.keepFilters);
  const setKeep = useExplorer((s) => s.setKeepFilters);
  const patternError = useExplorer((s) => s.patternError);
  const total = useExplorer((s) => s.entries.length);
  const shown = useExplorer((s) => s.visible.length);
  const tagLibraryOn = useModule("tags");
  const metadataOn = useModule("metadata");
  const tagsOn = tagLibraryOn || metadataOn;
  const count = activeFilterCount(filters);

  return (
    <div className="filterbar">
      <div className={`pattern-field${patternError ? " invalid" : ""}`} title={patternError ?? undefined}>
        <input
          value={filters.pattern}
          spellCheck={false}
          placeholder={filters.patternMode === "glob" ? "Pattern: *.png; IMG_????*; !*.tmp" : "Regex: ^report-\\d+"}
          onChange={(e) => set({ pattern: e.target.value })}
          onKeyDown={(e) => e.key === "Escape" && set({ pattern: "" })}
        />
        <div className="seg-tiny">
          {(["glob", "regex"] as const).map((m) => (
            <button key={m} className={filters.patternMode === m ? "active" : ""} onClick={() => set({ patternMode: m })}>
              {m === "glob" ? "Glob" : ".*"}
            </button>
          ))}
        </div>
      </div>
      <TypeFilter filters={filters} set={set} />
      <DateFilter filters={filters} set={set} />
      <SizeFilter filters={filters} set={set} />
      {tagsOn && <TagFilter filters={filters} set={set} />}

      <div className="filterbar-spacer" />
      {count > 0 && (
        <span className="filter-count">
          {numberFmt.format(shown)} of {numberFmt.format(total)}
        </span>
      )}
      <button
        className={`icon-btn small${keep ? " active" : ""}`}
        title={keep ? "Filters stay on when changing folders" : "Filters reset when changing folders"}
        onClick={() => setKeep(!keep)}
      >
        {keep ? <Lock size={13} /> : <LockOpen size={13} />}
      </button>
      {count > 0 && (
        <button className="chip-btn" onClick={clear}>
          <X size={13} /> Clear
        </button>
      )}
    </div>
  );
}
