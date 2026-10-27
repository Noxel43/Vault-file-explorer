import { Disc3, Download, FileMusic, FilePlay, FileText, HardDrive, House, Image, Monitor, Network, Tag, Usb } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { formatSize } from "../lib/format";
import { THIS_PC, pathKey, tagLocation } from "../lib/path";
import type { Drive } from "../lib/types";
import { useExplorer } from "../store/explorer";
import { useModule } from "../store/settings";

export const PLACE_ICONS: Record<string, LucideIcon> = {
  home: House,
  desktop: Monitor,
  documents: FileText,
  downloads: Download,
  pictures: Image,
  music: FileMusic,
  videos: FilePlay,
};

export function driveIcon(kind: string): LucideIcon {
  if (kind === "removable") return Usb;
  if (kind === "network") return Network;
  if (kind === "cdrom") return Disc3;
  return HardDrive;
}

export function driveName(d: Drive) {
  return `${d.label} (${d.path.replace(/\\$/, "")})`;
}

export function UsageBar({ drive }: { drive: Drive }) {
  if (!drive.total) return null;
  const used = 1 - drive.free / drive.total;
  return (
    <div className="usage" title={`${formatSize(drive.free)} free of ${formatSize(drive.total)}`}>
      <div className={`usage-fill${used > 0.9 ? " full" : ""}`} style={{ width: `${used * 100}%` }} />
    </div>
  );
}

export function Sidebar({ width }: { width: number }) {
  const location = useExplorer((s) => s.location);
  const places = useExplorer((s) => s.places);
  const drives = useExplorer((s) => s.drives);
  const tags = useExplorer((s) => s.tags);
  const navigate = useExplorer((s) => s.navigate);
  const tagsOn = useModule("tags");
  const here = pathKey(location);

  return (
    <nav className="sidebar" style={{ width }}>
      <div className="side-section">
        <button className={`side-item${location === THIS_PC ? " active" : ""}`} onClick={() => navigate(THIS_PC)}>
          <Monitor size={16} className="side-icon" />
          <span className="side-label">This PC</span>
        </button>
      </div>

      <div className="side-section">
        <div className="side-heading">Places</div>
        {places.map((p) => {
          const Icon = PLACE_ICONS[p.id] ?? House;
          return (
            <button
              key={p.id}
              className={`side-item${pathKey(p.path) === here ? " active" : ""}`}
              onClick={() => navigate(p.path)}
              title={p.path}
            >
              <Icon size={16} className="side-icon" />
              <span className="side-label">{p.name}</span>
            </button>
          );
        })}
      </div>

      <div className="side-section">
        <div className="side-heading">Drives</div>
        {drives.map((d) => {
          const Icon = driveIcon(d.kind);
          return (
            <button
              key={d.path}
              className={`side-item drive${pathKey(d.path) === here ? " active" : ""}`}
              onClick={() => navigate(d.path)}
            >
              <Icon size={16} className="side-icon" />
              <span className="side-label">
                {driveName(d)}
                <UsageBar drive={d} />
              </span>
            </button>
          );
        })}
      </div>

      {tagsOn && (
        <div className="side-section">
          <div className="side-heading">Tags</div>
          {tags.length === 0 && <div className="side-empty">Tag files from the details panel.</div>}
          {tags.map((t) => (
            <button
              key={t.id}
              className={`side-item${location === tagLocation(t.id) ? " active" : ""}`}
              onClick={() => navigate(tagLocation(t.id))}
            >
              <Tag size={14} className="side-icon" style={{ color: t.color }} />
              <span className="side-label">{t.name}</span>
              <span className="side-count">{t.count}</span>
            </button>
          ))}
        </div>
      )}
    </nav>
  );
}
