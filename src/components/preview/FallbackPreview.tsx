import { Loader } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { Entry } from "../../lib/types";
import { FileIcon } from "../FileIcon";

export function PreviewLoading() {
  return (
    <div className="preview-center">
      <Loader size={20} className="spin faint" />
    </div>
  );
}

/** The Windows shell thumbnail for a file, as an object URL. `done` turns true even if there is none. */
export function useShellThumbnail(path: string, size: number) {
  const [state, setState] = useState<{ url: string | null; done: boolean }>({ url: null, done: false });
  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    api
      .fileThumbnail(path, size)
      .then((png) => {
        if (cancelled) return;
        url = URL.createObjectURL(new Blob([png], { type: "image/png" }));
        setState({ url, done: true });
      })
      .catch(() => !cancelled && setState({ url: null, done: true }));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path, size]);
  return state;
}

/** For anything without an inline renderer: the shell thumbnail if Windows has one, else the file icon. */
export function FallbackPreview({ entry, reason }: { entry: Entry; reason?: string }) {
  const { url, done } = useShellThumbnail(entry.path, 768);
  return (
    <div className="preview-center preview-fallback">
      {url ? (
        <img className="preview-thumb" src={url} draggable={false} alt="" />
      ) : (
        // Hold the icon back until the lookup finishes so a thumbnail doesn't replace it a moment later.
        done && <FileIcon category={entry.category} size={88} />
      )}
      {done && (reason || !url) && <div className="faint">{reason ?? "No preview available for this file type."}</div>}
    </div>
  );
}
