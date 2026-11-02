import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { categoryOf, extOf } from "../../lib/fileTypes";
import { formatSize, numberFmt } from "../../lib/format";
import type { PreviewProps } from "../../lib/preview";
import { unpack, type RawEntry } from "../../lib/types";
import { useExplorer } from "../../store/explorer";
import { FileIcon } from "../FileIcon";
import { PreviewLoading } from "./FallbackPreview";

/** Listing a huge folder is cheap, rendering all of it here is not. */
const MAX_ROWS = 200;

export function FolderPreview({ entry, onInfo, onFail }: PreviewProps) {
  const showHidden = useExplorer((s) => s.view.showHidden);
  const [rows, setRows] = useState<RawEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listDir(entry.path)
      .then((listing) => {
        if (cancelled) return;
        const all = listing.entries.map(unpack).filter((e) => showHidden || !e.hidden);
        const folders = all.filter((e) => e.isDir).length;
        const files = all.length - folders;
        const size = all.reduce((n, e) => n + (e.isDir ? 0 : e.size), 0);
        onInfo(`${numberFmt.format(folders)} folders, ${numberFmt.format(files)} files · ${formatSize(size)}`);
        const sorted = all.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
        setRows(sorted.slice(0, MAX_ROWS));
      })
      .catch((e) => !cancelled && onFail(String(e)));
    return () => {
      cancelled = true;
    };
  }, [entry.path, showHidden]);

  if (!rows) return <PreviewLoading />;
  if (!rows.length) return <div className="preview-center faint">This folder is empty.</div>;
  return (
    <div className="preview-scroll preview-folder">
      {rows.map((r) => (
        <div key={r.name} className="preview-folder-row">
          <FileIcon category={categoryOf(extOf(r.name, r.isDir), r.isDir)} size={15} />
          <span className="name-text">{r.name}</span>
        </div>
      ))}
    </div>
  );
}
