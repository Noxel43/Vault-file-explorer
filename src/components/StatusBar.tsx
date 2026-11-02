import { LoaderCircle } from "lucide-react";
import { useMemo } from "react";
import { formatSize, numberFmt } from "../lib/format";
import { SEARCH, THIS_PC } from "../lib/path";
import { useExplorer } from "../store/explorer";
import { useSettings } from "../store/settings";
import { useUi } from "../store/ui";

const compactFmt = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

export function StatusBar() {
  const location = useExplorer((s) => s.location);
  const entries = useExplorer((s) => s.entries);
  const visible = useExplorer((s) => s.visible);
  const selected = useExplorer((s) => s.selected);
  const loading = useExplorer((s) => s.loading);
  const drives = useExplorer((s) => s.drives);
  const viewIsCustom = useExplorer((s) => s.viewIsCustom);
  const resetView = useExplorer((s) => s.resetView);
  const tier = useSettings((s) => s.info?.tier);
  const search = useExplorer((s) => s.search);
  const indexStatus = useExplorer((s) => s.indexStatus);
  const openSettings = useUi((s) => s.openSettings);

  const selSize = useMemo(() => {
    let n = 0;
    for (const e of entries) if (selected.has(e.path) && !e.isDir) n += e.size;
    return n;
  }, [entries, selected]);

  const parts: string[] = [];
  if (location === THIS_PC) {
    parts.push(`${drives.length} drive${drives.length === 1 ? "" : "s"}`);
  } else if (location === SEARCH) {
    if (search) {
      parts.push(`${numberFmt.format(search.total)} result${search.total === 1 ? "" : "s"}`);
      if (search.total > entries.length) parts.push(`best ${numberFmt.format(entries.length)} shown`);
    }
    if (selected.size) parts.push(`${numberFmt.format(selected.size)} selected${selSize ? ` (${formatSize(selSize)})` : ""}`);
  } else {
    parts.push(`${numberFmt.format(entries.length)} item${entries.length === 1 ? "" : "s"}`);
    if (visible.length !== entries.length) parts.push(`${numberFmt.format(visible.length)} shown`);
    if (selected.size) parts.push(`${numberFmt.format(selected.size)} selected${selSize ? ` (${formatSize(selSize)})` : ""}`);
  }

  return (
    <footer className="statusbar">
      <span>{parts.join("  ·  ")}</span>
      {loading && <LoaderCircle size={12} className="spin" />}
      <span className="grow" />
      {(indexStatus?.state === "scanning" || indexStatus?.state === "loading") && (
        <button className="link-btn index-note" onClick={() => openSettings("search")} title="Search index settings">
          <LoaderCircle size={11} className="spin" />
          {indexStatus.state === "loading" ? "Loading index" : `Indexing · ${compactFmt.format(indexStatus.files)} items`}
        </button>
      )}
      {viewIsCustom && location !== THIS_PC && (
        <button className="link-btn" onClick={resetView} title="This folder remembers its own view settings">
          Custom view · reset
        </button>
      )}
      {tier && <span className="tier-badge">{tier}</span>}
    </footer>
  );
}
