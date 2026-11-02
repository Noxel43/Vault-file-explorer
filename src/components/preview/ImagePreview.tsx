import { Maximize, Minus, Plus, RotateCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { numberFmt } from "../../lib/format";
import type { PreviewProps } from "../../lib/preview";

const MIN_SCALE = 0.02;
const MAX_SCALE = 32;

interface Viewport {
  scale: number;
  /** Where the image's centre sits inside the pane. */
  cx: number;
  cy: number;
  /** Quarter turns, view only. */
  turns: number;
  /** Follow the pane size until the user zooms or pans. */
  fit: boolean;
}

export function ImagePreview({ entry, src, onInfo, onFail }: PreviewProps) {
  const paneRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [view, setView] = useState<Viewport>({ scale: 1, cx: 0, cy: 0, turns: 0, fit: true });

  const fitted = useCallback(
    (turns: number): Viewport | null => {
      const el = paneRef.current;
      if (!el || !natural) return null;
      const { clientWidth: pw, clientHeight: ph } = el;
      const [w, h] = turns % 2 ? [natural.h, natural.w] : [natural.w, natural.h];
      // Never blow up a small bitmap just to fill the pane; vectors have no such problem.
      const limit = entry.ext === "svg" ? MAX_SCALE : 1;
      const scale = Math.min((pw - 16) / w, (ph - 16) / h, limit);
      return { scale: Math.max(scale, MIN_SCALE), cx: pw / 2, cy: ph / 2, turns, fit: true };
    },
    [natural, entry.ext],
  );

  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const refit = () => setView((v) => (v.fit ? (fitted(v.turns) ?? v) : v));
    refit();
    const observer = new ResizeObserver(refit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [fitted]);

  /** Zoom keeping the point under (x, y) still. */
  const zoomAt = (factor: number, x: number, y: number) =>
    setView((v) => {
      const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.scale * factor));
      const k = scale / v.scale;
      return { ...v, scale, cx: x - (x - v.cx) * k, cy: y - (y - v.cy) * k, fit: false };
    });

  const zoomCentre = (factor: number) => {
    const el = paneRef.current;
    if (el) zoomAt(factor, el.clientWidth / 2, el.clientHeight / 2);
  };

  const local = (e: { clientX: number; clientY: number }) => {
    const r = paneRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as Element).closest("button")) return;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    let lastX = e.clientX;
    let lastY = e.clientY;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - lastX;
      const dy = ev.clientY - lastY;
      lastX = ev.clientX;
      lastY = ev.clientY;
      setView((v) => ({ ...v, cx: v.cx + dx, cy: v.cy + dy, fit: false }));
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const refit = (turns = view.turns) => {
    const next = fitted(turns);
    if (next) setView(next);
  };

  return (
    <div
      ref={paneRef}
      className="preview-image-view"
      onWheel={(e) => {
        const { x, y } = local(e);
        zoomAt(Math.exp(-e.deltaY * 0.0015), x, y);
      }}
      onPointerDown={onPointerDown}
      onDoubleClick={(e) => {
        if ((e.target as Element).closest("button")) return;
        if (view.fit && view.scale !== 1) {
          const { x, y } = local(e);
          zoomAt(1 / view.scale, x, y);
        } else refit();
      }}
    >
      <img
        className={`preview-image${view.scale >= 3 && entry.ext !== "svg" ? " pixelated" : ""}`}
        src={src}
        alt=""
        draggable={false}
        decoding="async"
        style={
          natural
            ? {
                width: natural.w,
                height: natural.h,
                transform: `translate(${view.cx - natural.w / 2}px, ${view.cy - natural.h / 2}px) rotate(${view.turns * 90}deg) scale(${view.scale})`,
              }
            : { visibility: "hidden" }
        }
        onLoad={(e) => {
          const { naturalWidth, naturalHeight } = e.currentTarget;
          // SVGs without a size report 0.
          setNatural({ w: naturalWidth || 512, h: naturalHeight || 512 });
          if (naturalWidth) onInfo(`${numberFmt.format(naturalWidth)} × ${numberFmt.format(naturalHeight)}`);
        }}
        onError={() => onFail("This image couldn't be decoded.")}
      />
      {natural && (
        <div className="preview-tools">
          <button className="icon-btn small" title="Zoom out" onClick={() => zoomCentre(1 / 1.25)}>
            <Minus size={14} />
          </button>
          <span className="preview-tools-label">{Math.round(view.scale * 100)}%</span>
          <button className="icon-btn small" title="Zoom in" onClick={() => zoomCentre(1.25)}>
            <Plus size={14} />
          </button>
          <button className="icon-btn small" title="Fit to pane" onClick={() => refit()}>
            <Maximize size={13} />
          </button>
          <button className="icon-btn small" title="Rotate view" onClick={() => refit((view.turns + 1) % 4)}>
            <RotateCw size={13} />
          </button>
        </div>
      )}
    </div>
  );
}
