import CATEGORY_TABLE from "./categories.json";

export type Category =
  | "folder"
  | "image"
  | "video"
  | "audio"
  | "document"
  | "spreadsheet"
  | "presentation"
  | "pdf"
  | "text"
  | "code"
  | "archive"
  | "executable"
  | "font"
  | "model3d"
  | "other";

export const CATEGORY_LABELS: Record<Category, string> = {
  folder: "Folders",
  image: "Images",
  video: "Video",
  audio: "Audio",
  document: "Documents",
  spreadsheet: "Spreadsheets",
  presentation: "Presentations",
  pdf: "PDF",
  text: "Text",
  code: "Code",
  archive: "Archives",
  executable: "Programs",
  font: "Fonts",
  model3d: "3D models",
  other: "Other",
};

const EXT: Record<string, Category> = {};
// Shared with the search index in Rust. Order matters: a later category wins an extension.
for (const [cat, exts] of CATEGORY_TABLE as [Category, string][]) {
  for (const ext of exts.split(" ")) EXT[ext] = cat;
}

export function extOf(name: string, isDir: boolean): string {
  if (isDir) return "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function categoryOf(ext: string, isDir: boolean): Category {
  if (isDir) return "folder";
  return EXT[ext] ?? "other";
}

/** Images the webview can render directly (used for thumbnails). */
export const WEB_IMAGE = new Set(["png", "jpg", "jpeg", "jfif", "gif", "bmp", "webp", "svg", "ico", "avif"]);

export function typeLabel(ext: string, isDir: boolean): string {
  if (isDir) return "Folder";
  if (!ext) return "File";
  return `${ext.toUpperCase()} file`;
}
