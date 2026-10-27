import { invoke } from "@tauri-apps/api/core";
import type {
  AppInfo,
  DirListing,
  Drive,
  FileMeta,
  MetaSummary,
  Place,
  RawEntry,
  Tag,
  TagWithCount,
  TransferResult,
} from "./types";

/** Thin typed wrappers over the Rust commands in src-tauri/src/lib.rs. */
export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),

  listDir: (path: string) => invoke<DirListing>("list_dir", { path }),
  statPaths: (paths: string[]) => invoke<RawEntry[]>("stat_paths", { paths }),
  resolvePath: (input: string) => invoke<string>("resolve_path", { input }),
  getDrives: () => invoke<Drive[]>("get_drives"),
  getPlaces: () => invoke<Place[]>("get_places"),
  openPath: (path: string) => invoke<void>("open_path", { path }),
  revealPath: (path: string) => invoke<void>("reveal_path", { path }),
  createFolder: (dir: string, name: string) => invoke<string>("create_folder", { dir, name }),
  createFile: (dir: string, name: string) => invoke<string>("create_file", { dir, name }),
  renamePath: (path: string, newName: string) => invoke<string>("rename_path", { path, newName }),
  deletePaths: (paths: string[], permanent: boolean) =>
    invoke<void>("delete_paths", { paths, permanent }),
  transferPaths: (paths: string[], destDir: string, mode: "copy" | "move") =>
    invoke<TransferResult>("transfer_paths", { paths, destDir, mode }),
  watchDir: (path: string) => invoke<void>("watch_dir", { path }),
  unwatchDir: () => invoke<void>("unwatch_dir"),

  getMeta: (path: string) => invoke<FileMeta>("get_meta", { path }),
  setMeta: (path: string, description: string, keywords: string[], rating: number) =>
    invoke<FileMeta>("set_meta", { path, description, keywords, rating }),
  getFolderMeta: (dir: string) => invoke<MetaSummary[]>("get_folder_meta", { dir }),
  listTags: () => invoke<TagWithCount[]>("list_tags"),
  updateTag: (id: number, name: string, color: string) =>
    invoke<void>("update_tag", { id, name, color }),
  deleteTag: (id: number) => invoke<void>("delete_tag", { id }),
  addTag: (paths: string[], name: string) => invoke<Tag>("add_tag", { paths, name }),
  removeTag: (paths: string[], tagId: number) => invoke<void>("remove_tag", { paths, tagId }),
  pathsWithTag: (tagId: number) => invoke<string[]>("paths_with_tag", { tagId }),

  getFolderView: (path: string) => invoke<string | null>("get_folder_view", { path }),
  setFolderView: (path: string, settings: string) =>
    invoke<void>("set_folder_view", { path, settings }),
  clearFolderView: (path: string) => invoke<void>("clear_folder_view", { path }),
  getSettings: (keys: string[]) => invoke<Record<string, string>>("get_settings", { keys }),
  setSetting: (key: string, value: string) => invoke<void>("set_setting", { key, value }),
};
