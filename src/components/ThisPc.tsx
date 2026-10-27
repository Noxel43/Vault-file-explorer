import { House } from "lucide-react";
import { formatSize } from "../lib/format";
import { useExplorer } from "../store/explorer";
import { PLACE_ICONS, UsageBar, driveIcon, driveName } from "./Sidebar";

/** Landing page: well-known folders and drives with usage. */
export function ThisPc() {
  const places = useExplorer((s) => s.places);
  const drives = useExplorer((s) => s.drives);
  const navigate = useExplorer((s) => s.navigate);

  return (
    <div className="thispc">
      <h2 className="thispc-heading">Places</h2>
      <div className="place-grid">
        {places.map((p) => {
          const Icon = PLACE_ICONS[p.id] ?? House;
          return (
            <button key={p.id} className="place-card" onClick={() => navigate(p.path)} title={p.path}>
              <Icon size={22} className="place-icon" />
              <span>{p.name}</span>
            </button>
          );
        })}
      </div>

      <h2 className="thispc-heading">Drives</h2>
      <div className="drive-grid">
        {drives.map((d) => {
          const Icon = driveIcon(d.kind);
          return (
            <button key={d.path} className="drive-card" onClick={() => navigate(d.path)}>
              <Icon size={30} strokeWidth={1.4} className="drive-icon" />
              <div className="drive-info">
                <div className="drive-name">{driveName(d)}</div>
                <UsageBar drive={d} />
                {d.total > 0 && (
                  <div className="drive-free">
                    {formatSize(d.free)} free of {formatSize(d.total)}
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
