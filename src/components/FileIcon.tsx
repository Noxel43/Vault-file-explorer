import {
  AppWindow,
  Box,
  File,
  FileArchive,
  FileCode,
  FileImage,
  FileMusic,
  FilePlay,
  FileSpreadsheet,
  FileText,
  FileType,
  Folder,
  Presentation,
  Type,
  type LucideIcon,
} from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { memo, useState } from "react";
import type { Category } from "../lib/fileTypes";
import { WEB_IMAGE } from "../lib/fileTypes";
import type { Entry } from "../lib/types";

const ICONS: Record<Category, LucideIcon> = {
  folder: Folder,
  image: FileImage,
  video: FilePlay,
  audio: FileMusic,
  document: FileText,
  spreadsheet: FileSpreadsheet,
  presentation: Presentation,
  pdf: FileType,
  text: FileText,
  code: FileCode,
  archive: FileArchive,
  executable: AppWindow,
  font: Type,
  model3d: Box,
  other: File,
};

export function FileIcon({ category, size = 16 }: { category: Category; size?: number }) {
  const Icon = ICONS[category];
  return (
    <Icon
      size={size}
      strokeWidth={category === "folder" ? 1.6 : 1.5}
      className="file-icon"
      style={{ color: `var(--ft-${category})` }}
      fill={category === "folder" ? "color-mix(in srgb, var(--ft-folder) 22%, transparent)" : "none"}
      aria-hidden
    />
  );
}

const MAX_THUMB_BYTES = 40 * 1024 * 1024;

/** Image thumbnail with icon fallback. Only used where thumbnails are enabled. */
export const Thumbnail = memo(function Thumbnail({ entry, size }: { entry: Entry; size: number }) {
  const [failed, setFailed] = useState(false);
  const canShow = !failed && WEB_IMAGE.has(entry.ext) && entry.size > 0 && entry.size < MAX_THUMB_BYTES;
  if (!canShow) return <FileIcon category={entry.category} size={Math.round(size * 0.55)} />;
  return (
    <img
      className="thumb"
      src={convertFileSrc(entry.path)}
      loading="lazy"
      decoding="async"
      draggable={false}
      alt=""
      onError={() => setFailed(true)}
    />
  );
});
