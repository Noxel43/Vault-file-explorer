// Times the frontend filter + sort on 100k synthetic entries.
// Run with: pnpm bench:filter
import { applyFilters, EMPTY_FILTERS, sortEntries, type Filters } from "../src/lib/filters";
import { categoryOf, extOf } from "../src/lib/fileTypes";
import type { Entry, FolderView } from "../src/lib/types";

const view: FolderView = {
  mode: "details",
  sortKey: "name",
  sortDir: "asc",
  foldersFirst: true,
  showHidden: false,
  iconSize: 96,
  columns: { name: 260, modified: 160, type: 100, size: 84, tags: 140 },
};

const exts = ["txt", "png", "jpg", "mp4", "rs", "pdf", "zip", "docx"];
const entries: Entry[] = Array.from({ length: 100_000 }, (_, i) => {
  const name = `file_${i}.${exts[i % 8]}`;
  const ext = extOf(name, false);
  return {
    name,
    path: `C:\\big\\${name}`,
    isDir: false,
    size: i % 5000,
    modified: Date.now() - i * 60_000,
    created: 0,
    hidden: false,
    system: false,
    readonly: false,
    symlink: false,
    lower: name.toLowerCase(),
    ext,
    category: categoryOf(ext, false),
  };
});

function time<T>(label: string, fn: () => T, count: (r: T) => number) {
  const t = performance.now();
  const r = fn();
  console.log(`${label.padEnd(28)} ${(performance.now() - t).toFixed(1).padStart(7)} ms  -> ${count(r)}`);
  return r;
}

time("warmup (name sort)", () => sortEntries(entries, view), (r) => r.length);
const sorted = time("sort: name", () => sortEntries(entries, view), (r) => r.length);
time("sort: size", () => sortEntries(entries, { ...view, sortKey: "size" }), (r) => r.length);
time("sort: modified", () => sortEntries(entries, { ...view, sortKey: "modified" }), (r) => r.length);

function run(label: string, f: Partial<Filters>) {
  time(`filter: ${label}`, () => applyFilters(sorted, { ...EMPTY_FILTERS, ...f }, view, new Map()), (r) => r.visible.length);
}

run("none", {});
run("query '99'", { query: "99" });
run("glob *.png;*.jpg", { pattern: "*.png;*.jpg" });
run("regex ^file_1\\d{3}\\.", { pattern: "^file_1\\d{3}\\.", patternMode: "regex" });
run("type image + size >1KB", { types: ["image"], sizeMin: 1024 });
run("date last 7 days", { datePreset: "week" });
