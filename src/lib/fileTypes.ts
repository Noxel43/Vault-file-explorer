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
const add = (cat: Category, exts: string) => exts.split(" ").forEach((e) => (EXT[e] = cat));

add("image", "png jpg jpeg jfif gif bmp webp svg ico tif tiff heic heif avif raw cr2 nef arw dng psd xcf");
add("video", "mp4 mkv mov avi wmv webm flv m4v mpg mpeg 3gp ts mts");
add("audio", "mp3 wav flac aac ogg opus m4a wma aiff alac mid midi");
add("document", "doc docx odt rtf pages epub mobi one");
add("spreadsheet", "xls xlsx xlsm ods csv tsv numbers");
add("presentation", "ppt pptx odp key");
add("pdf", "pdf");
add("text", "txt md markdown log ini cfg conf nfo");
add(
  "code",
  "js mjs cjs jsx ts tsx json jsonc html htm css scss sass less py rb rs go java kt kts c h cpp cc hpp cs fs vb php swift lua sh bash zsh ps1 psm1 bat cmd sql yaml yml toml xml vue svelte dart r jl zig gd glsl hlsl wgsl",
);
add("archive", "zip 7z rar tar gz tgz bz2 xz zst lz4 cab iso dmg");
add("executable", "exe msi msix appx bat lnk dll sys com scr");
add("font", "ttf otf woff woff2 fon");
add("model3d", "obj fbx stl gltf glb blend 3ds dae ply usd usdz f3d step stp iges igs 3mf");

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
