import { LoaderCircle } from "lucide-react";
import { numberFmt } from "../lib/format";
import { baseName } from "../lib/path";
import { useExplorer } from "../store/explorer";
import { useModule } from "../store/settings";

/** The strip above search results: where it's looking, how much it found, in what order. */
export function SearchHeader() {
  const search = useExplorer((s) => s.search);
  const shown = useExplorer((s) => s.visible.length);
  const scope = useExplorer((s) => s.searchScope);
  const origin = useExplorer((s) => s.searchOrigin);
  const setScope = useExplorer((s) => s.setSearchScope);
  const sortKey = useExplorer((s) => s.view.sortKey);
  const setView = useExplorer((s) => s.setView);
  const status = useExplorer((s) => s.indexStatus);
  const statusBarOn = useModule("statusbar");
  // The status bar already says this when it's there.
  const showIndexing = status?.state === "scanning" && !statusBarOn;

  if (!origin && !search?.ready && !showIndexing && sortKey === "relevance") return null;

  return (
    <div className="search-header">
      {origin && (
        <div className="seg-small inline">
          <button className={scope === null ? "active" : ""} onClick={() => setScope(null)}>
            Everywhere
          </button>
          <button className={scope === origin ? "active" : ""} title={origin} onClick={() => setScope(origin)}>
            In {baseName(origin) || origin}
          </button>
        </div>
      )}
      {search?.ready && (
        <span className="search-count">
          <b>{numberFmt.format(search.total)}</b> result{search.total === 1 ? "" : "s"}
          {search.total > shown && ` · best ${numberFmt.format(shown)} shown`} · {search.tookMs} ms
        </span>
      )}
      {showIndexing && (
        <span className="index-note faint">
          <LoaderCircle size={11} className="spin" /> Still indexing
        </span>
      )}
      <span className="grow" />
      {sortKey !== "relevance" && (
        <button className="chip-btn" onClick={() => setView({ sortKey: "relevance", sortDir: "asc" })}>
          Sort by best match
        </button>
      )}
    </div>
  );
}
