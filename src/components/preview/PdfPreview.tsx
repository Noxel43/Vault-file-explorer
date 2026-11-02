import { useVirtualizer } from "@tanstack/react-virtual";
import { Maximize, Minus, Plus } from "lucide-react";
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useEffect, useRef, useState } from "react";
import { numberFmt } from "../../lib/format";
import type { PreviewProps } from "../../lib/preview";
import { PreviewLoading } from "./FallbackPreview";

GlobalWorkerOptions.workerSrc = workerUrl;

// Copied next to the app by vite.config.ts.
const assets = (dir: string) => new URL(`pdfjs/${dir}/`, document.baseURI).href;

const PAGE_GAP = 8;
const SIDE_PADDING = 24;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;

function PdfPage({ pdf, number, width, ratio }: { pdf: PDFDocumentProxy; number: number; width: number; ratio: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Starts from the first page's shape, corrected once this page is known (mixed sizes are common).
  const [pageRatio, setPageRatio] = useState(ratio);

  useEffect(() => {
    let cancelled = false;
    let task: RenderTask | null = null;
    pdf
      .getPage(number)
      .then((page) => {
        if (cancelled) return;
        const unit = page.getViewport({ scale: 1 });
        setPageRatio(unit.height / unit.width);
        const scale = (width / unit.width) * window.devicePixelRatio;
        const viewport = page.getViewport({ scale });
        const canvas = canvasRef.current!;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        task = page.render({ canvas, viewport });
        return task.promise;
      })
      .catch((e) => {
        if (e?.name !== "RenderingCancelledException") console.error(e);
      });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, number, width]);

  return <canvas ref={canvasRef} className="preview-pdf-page" style={{ width, height: width * pageRatio }} />;
}

export default function PdfPreview({ src, onInfo, onFail }: PreviewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<{ pdf: PDFDocumentProxy; ratio: number } | null>(null);
  const [paneWidth, setPaneWidth] = useState(0);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    let cancelled = false;
    const task = getDocument({
      url: src,
      cMapUrl: assets("cmaps"),
      cMapPacked: true,
      standardFontDataUrl: assets("standard_fonts"),
      wasmUrl: assets("wasm"),
      iccUrl: assets("iccs"),
      useSystemFonts: true,
    });
    task.promise
      .then(async (pdf) => {
        const first = await pdf.getPage(1);
        if (cancelled) return;
        const unit = first.getViewport({ scale: 1 });
        setDoc({ pdf, ratio: unit.height / unit.width });
        onInfo(`${numberFmt.format(pdf.numPages)} page${pdf.numPages === 1 ? "" : "s"}`);
      })
      .catch((e) => {
        if (cancelled) return;
        onFail(e?.name === "PasswordException" ? "This PDF is password protected." : "This PDF couldn't be opened.");
      });
    return () => {
      cancelled = true;
      task.destroy();
    };
  }, [src]);

  // Debounced so dragging the pane edge doesn't re-rasterise every visible page per pixel.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setPaneWidth(el.clientWidth);
    let timer: number | undefined;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setPaneWidth(el.clientWidth), 120);
    });
    observer.observe(el);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [!!doc]);

  const pageWidth = Math.max(120, (paneWidth - SIDE_PADDING) * zoom);
  const virtualizer = useVirtualizer({
    count: doc?.pdf.numPages ?? 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => pageWidth * (doc?.ratio ?? 1.4) + PAGE_GAP,
    overscan: 1,
    gap: 0,
  });

  // Page heights all change together with the width.
  useEffect(() => virtualizer.measure(), [pageWidth, virtualizer]);

  if (!doc) return <PreviewLoading />;

  const current = virtualizer.getVirtualItemForOffset(
    (virtualizer.scrollOffset ?? 0) + (scrollRef.current?.clientHeight ?? 0) / 2,
  );

  return (
    <>
      <div ref={scrollRef} className="preview-scroll preview-pdf">
        <div
          className="preview-pdf-body"
          style={{ height: virtualizer.getTotalSize(), minWidth: pageWidth + SIDE_PADDING }}
        >
          {virtualizer.getVirtualItems().map((item) => (
            <div
              key={item.key}
              ref={virtualizer.measureElement}
              data-index={item.index}
              className="preview-pdf-row"
              style={{ transform: `translateY(${item.start}px)`, paddingBottom: PAGE_GAP }}
            >
              <PdfPage pdf={doc.pdf} number={item.index + 1} width={pageWidth} ratio={doc.ratio} />
            </div>
          ))}
        </div>
      </div>
      <div className="preview-tools">
        <button className="icon-btn small" title="Zoom out" onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z / 1.25))}>
          <Minus size={14} />
        </button>
        <span className="preview-tools-label">
          {numberFmt.format((current?.index ?? 0) + 1)} / {numberFmt.format(doc.pdf.numPages)}
        </span>
        <button className="icon-btn small" title="Zoom in" onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * 1.25))}>
          <Plus size={14} />
        </button>
        <button className="icon-btn small" title="Fit width" onClick={() => setZoom(1)}>
          <Maximize size={13} />
        </button>
      </div>
    </>
  );
}
