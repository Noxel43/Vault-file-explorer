import { convertFileSrc } from "@tauri-apps/api/core";
import { WEB_IMAGE } from "./fileTypes";
import type { Entry } from "./types";

export type PreviewKind = "folder" | "image" | "video" | "audio" | "pdf" | "text" | "font" | "model" | "none";

/** What every preview renderer receives. */
export interface PreviewProps {
  entry: Entry;
  /** URL the webview can stream the file from. */
  src: string;
  /** Sets the detail line under the preview, e.g. image dimensions. */
  onInfo: (info: string) => void;
  /** Gives up and shows the thumbnail/icon fallback, optionally saying why. */
  onFail: (reason?: string) => void;
}

const FONT = new Set(["ttf", "otf", "woff", "woff2"]);
export const MODEL = new Set(["glb", "gltf", "obj", "stl", "ply", "fbx", "3mf", "dae", "3ds", "usdz", "usd"]);
/** Plain text filed under another category. */
const TEXT_LIKE = new Set(["csv", "tsv", "bat", "cmd"]);

export function previewKind(e: Entry): PreviewKind {
  if (e.isDir) return "folder";
  if (FONT.has(e.ext)) return "font";
  if (MODEL.has(e.ext)) return "model";
  if (TEXT_LIKE.has(e.ext)) return "text";
  switch (e.category) {
    case "image":
      return WEB_IMAGE.has(e.ext) ? "image" : "none";
    case "video":
    case "audio":
    case "pdf":
      return e.category;
    case "text":
    case "code":
    case "other": // Unknown extensions are sniffed: plenty of them are text (.env, .reg, Makefile).
      return "text";
    default:
      return "none";
  }
}

/** The modified time busts the webview's cache when a file changes on disk. */
export function previewSrc(e: Entry): string {
  return `${convertFileSrc(e.path)}?v=${e.modified}`;
}
