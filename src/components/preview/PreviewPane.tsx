import { ChevronLeft, ChevronRight, ExternalLink, PanelRightClose } from "lucide-react";
import { Component, Suspense, lazy, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { typeLabel } from "../../lib/fileTypes";
import { formatSize, numberFmt } from "../../lib/format";
import { previewKind, previewSrc, type PreviewKind, type PreviewProps } from "../../lib/preview";
import type { Entry } from "../../lib/types";
import { useExplorer } from "../../store/explorer";
import { useSettings } from "../../store/settings";
import { useUi } from "../../store/ui";
import { FileIcon } from "../FileIcon";
import { FallbackPreview, PreviewLoading } from "./FallbackPreview";
import { FolderPreview } from "./FolderPreview";
import { FontPreview } from "./FontPreview";
import { ImagePreview } from "./ImagePreview";
import { AudioPreview, VideoPreview } from "./MediaPreview";
import { TextPreview } from "./TextPreview";

// The PDF and 3D engines are heavy, so they only load the first time they're needed.
const PdfPreview = lazy(() => import("./PdfPreview"));
const ModelPreview = lazy(() => import("./ModelPreview"));

const RENDERERS: Record<PreviewKind, ComponentType<PreviewProps> | null> = {
  folder: FolderPreview,
  image: ImagePreview,
  video: VideoPreview,
  audio: AudioPreview,
  pdf: PdfPreview,
  text: TextPreview,
  font: FontPreview,
  model: ModelPreview,
  none: null,
};

/** A renderer that throws, or a chunk that fails to load, must not take the window with it. */
class PreviewBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error(error);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function PreviewBody({ entry }: { entry: Entry }) {
  const [failure, setFailure] = useState<{ reason?: string } | null>(null);
  const [info, setInfo] = useState("");
  const Renderer = RENDERERS[previewKind(entry)];
  const fallback = <FallbackPreview entry={entry} reason={failure?.reason} />;

  return (
    <>
      <div className="preview-body">
        {Renderer && !failure ? (
          <PreviewBoundary fallback={fallback}>
            <Suspense fallback={<PreviewLoading />}>
              <Renderer
                entry={entry}
                src={previewSrc(entry)}
                onInfo={setInfo}
                onFail={(reason) => setFailure({ reason })}
              />
            </Suspense>
          </PreviewBoundary>
        ) : (
          fallback
        )}
      </div>
      <div className="preview-foot" title={entry.path}>
        {[typeLabel(entry.ext, entry.isDir), !entry.isDir && formatSize(entry.size), info].filter(Boolean).join(" · ")}
      </div>
    </>
  );
}

/**
 * Follows the selection instantly for a single move, but while an arrow key is held only the
 * last file is worth decoding.
 */
function useSettledEntry(entry: Entry | null) {
  const [shown, setShown] = useState(entry);
  const lastChange = useRef(0);
  const path = entry?.path;
  useEffect(() => {
    const now = performance.now();
    const burst = now - lastChange.current < 200;
    lastChange.current = now;
    if (!burst) return setShown(entry);
    const timer = window.setTimeout(() => setShown(entry), 120);
    return () => window.clearTimeout(timer);
  }, [path]);
  // Same file, new stat (the watcher refreshed the folder).
  return shown && entry && shown.path === entry.path ? entry : shown;
}

export function PreviewPane({ width }: { width: number }) {
  const entry = useExplorer((s) => {
    const path = s.focus && s.selected.has(s.focus) ? s.focus : s.selected.values().next().value;
    return path ? (s.entries.find((e) => e.path === path) ?? null) : null;
  });
  const visible = useExplorer((s) => s.visible);
  const selectedCount = useExplorer((s) => s.selected.size);
  const moveFocus = useExplorer((s) => s.moveFocus);
  const update = useSettings((s) => s.update);
  const active = useUi((s) => s.previewActive);
  const setActive = useUi((s) => s.setPreviewActive);
  const ref = useRef<HTMLElement>(null);
  const shown = useSettledEntry(entry);

  const index = useMemo(() => (entry ? visible.findIndex((e) => e.path === entry.path) : -1), [visible, entry]);

  // Clicking into the pane points the arrow keys at it, clicking elsewhere gives them back.
  useEffect(() => {
    const onDown = (e: PointerEvent) => setActive(!!ref.current?.contains(e.target as Node));
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      setActive(false);
    };
  }, [setActive]);

  return (
    <aside
      ref={ref}
      className={`preview-pane${active ? " active" : ""}`}
      style={{ width }}
      // Buttons here shouldn't steal keyboard focus from the media element or the shortcuts.
      onMouseDown={(e) => (e.target as Element).closest("button") && e.preventDefault()}
    >
      <div className="preview-head">
        {entry && <FileIcon category={entry.category} size={15} />}
        <div className="preview-name" title={entry?.name}>
          {entry?.name ?? "Preview"}
        </div>
        {index >= 0 && (
          <span className="preview-count" title={selectedCount > 1 ? `${numberFmt.format(selectedCount)} selected` : undefined}>
            {numberFmt.format(index + 1)} / {numberFmt.format(visible.length)}
          </span>
        )}
        <button className="icon-btn small" title="Previous (Left)" disabled={index <= 0} onClick={() => moveFocus(-1, false)}>
          <ChevronLeft size={15} />
        </button>
        <button
          className="icon-btn small"
          title="Next (Right)"
          disabled={index < 0 || index >= visible.length - 1}
          onClick={() => moveFocus(1, false)}
        >
          <ChevronRight size={15} />
        </button>
        <button
          className="icon-btn small"
          title="Open"
          disabled={!entry}
          onClick={() => entry && useExplorer.getState().open(entry)}
        >
          <ExternalLink size={14} />
        </button>
        <button className="icon-btn small" title="Close preview (Alt+P)" onClick={() => update({ previewOpen: false })}>
          <PanelRightClose size={15} />
        </button>
      </div>
      {shown ? (
        // Remounting per file (and per version of it) drops zoom, playback and any stale load.
        <PreviewBody key={`${shown.path}|${shown.modified}|${shown.size}`} entry={shown} />
      ) : (
        <div className="preview-body">
          <div className="preview-center faint">{entry ? null : "Select a file to preview it."}</div>
        </div>
      )}
    </aside>
  );
}
