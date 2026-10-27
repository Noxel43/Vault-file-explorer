Build "Vault", a modern, clean and fast file explorer to replace windows File Explorer. Minimal and easy to use on the surface, loads of functionality that can be acessed but not shoved in your face.

## Stack
Tauri 2 + React + TypeScript. Rust backend, react frontend. Choose whatever libraries you need.

## What it is
A modular file explorer where all features can be enabled or disabled (with presets). There are three installation tiers/levels (lite, standard, full), which controls INSTALLED modules/functionality, however they can be enabled/disabled in settings. All metadata (such as tags, desc, keywords, custom thumbnails) is in a local SQLite db, rather than the filesystem. All the functionality of windows explorer, plus more. It is intended to be a file explorer and other tools in one.

## Phase 1 - working file browser
- Navigate the real filesystem
- Fast file listing, large folders without lagging or stuttering
- Select a file and see its metadata in a panel (editable inline)
- Tags, descriptions and keywords stored and retreived for SQLite
- Folder-level filtering bar, filter visible files/results by type, name, name pattern, date, size, without leaving the folder
- Clean dark UI built on css variable token system so themes are only variable swaps.
- Persistent view settings per folder

## How it is different from explorer
- No sluggishness, instant search
- Metadata systems built in on any file
- Filters that work instantly
- Clean and customisable UI, with proper theme support

Scaffold the full project and get it running. Tell me what you installed and what the immediate next steps are.

## Git & github
create a new repo, and commit REGULARLY, push to "https://github.com/Noxel43/Vault-file-explorer", with MIT license. Add a detailed README, but do that on completion, not to start.


## Further development (Phase 2)
*Do not do this yet, wait for instruction*
# 1. Preview pane
Add a preview pane. Common files can preview inline - images, audio, PDF, code files with syntax highlights, 3d files, etc. Unsupported files show the thumbnail or fallback file icon. Pane should be collapsible and resible, and can navigate files from it with arrow keys.

# 2. Indexed Search
Add background file indexing and search. Index the filesystem into SQLite, expose a search command that supports filters (type, size, date, name pattern), and build a search results view in React. Indexing should be non-blocking.

# 3. Batch rename
Add a batch rename dialog. Select multiple files, open the dialog, define a pattern or regex, see a live preview of old → new names, then apply. Handle conflicts before anything gets renamed. For example, renaming random file names to {name}{index}, like file1, file2, etc.

# 4. Archive tools
Add archive support. Create .zip and .7z files via right-click. Extract with a file picker so the user chooses what to extract rather than dumping everything. Preview archive contents in the preview pane without extracting. Also, give it support for multi file rars, and other functionality usually only in third party apps.

# 5. Encryption
Add file encryption. Right-click any file or folder to encrypt it (choose what type, default AES-256), set a password, and store it as a .vault file. Right-click to decrypt.

# 6. File conversion
Add functionality to convert files from almost anything to almost anything, such as easy things like ffmpeg (allow for a gui, single button, or actually running written commands), or more complex things like 3d model conversion or things like propretary formats like .one or .f3d, etc.

# 7. Themes + modding
Add a theme and addon system to VAULT. Themes are JSON + asset bundles (.vtheme files) that override CSS variables. Addons are sandboxed JS modules (.vaddon) with access to a defined API — they can add context menu items, toolbar buttons, and preview handlers. Build a mod manager UI for installing, enabling, and disabling both. For mods, add functionality for mods that could do loads of things, for example give preview support to a niche file or things like that.

## Final steps
Do these when finished totally
- Create and publish the installer
- Create a detailed README with screenshots and install instructions
- Create docs, either with gh pages or something else, detailing things like mod support and how to make them.