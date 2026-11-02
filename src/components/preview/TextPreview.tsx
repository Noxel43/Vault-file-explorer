import { WrapText } from "lucide-react";
import { Suspense, lazy, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { formatSize, numberFmt } from "../../lib/format";
import type { PreviewProps } from "../../lib/preview";
import { useSettings } from "../../store/settings";
import { PreviewLoading } from "./FallbackPreview";

const CodeEditor = lazy(() => import("./CodeEditor"));

/** Enough for any file someone reads by eye. Past this the preview shows the start. */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

function countLines(text: string): number {
  let lines = 1;
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) lines++;
  return lines;
}

export function TextPreview({ entry, onInfo, onFail }: PreviewProps) {
  const wrap = useSettings((s) => s.previewWrap);
  const update = useSettings((s) => s.update);
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .readTextPreview(entry.path, MAX_TEXT_BYTES)
      .then((r) => {
        if (cancelled) return;
        // Only reached for "other" files or a misnamed extension, so no complaint: the fallback is the answer.
        if (r.binary) return onFail();
        setText(r.text);
        if (!r.text) return;
        const lines = countLines(r.text);
        onInfo(
          [
            `${numberFmt.format(lines)} line${lines === 1 ? "" : "s"}`,
            r.encoding,
            r.truncated && `showing first ${formatSize(MAX_TEXT_BYTES)}`,
          ]
            .filter(Boolean)
            .join(" · "),
        );
      })
      .catch((e) => !cancelled && onFail(String(e)));
    return () => {
      cancelled = true;
    };
  }, [entry.path]);

  if (text === null) return <PreviewLoading />;
  if (!text) return <div className="preview-center faint">This file is empty.</div>;
  return (
    <>
      <Suspense fallback={<PreviewLoading />}>
        <CodeEditor text={text} fileName={entry.name} wrap={wrap} />
      </Suspense>
      <div className="preview-tools">
        <button
          className={`icon-btn small${wrap ? " active" : ""}`}
          title="Wrap lines"
          onClick={() => update({ previewWrap: !wrap })}
        >
          <WrapText size={14} />
        </button>
      </div>
    </>
  );
}
