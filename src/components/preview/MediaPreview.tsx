import { numberFmt } from "../../lib/format";
import type { PreviewProps } from "../../lib/preview";
import { FileIcon } from "../FileIcon";
import { useShellThumbnail } from "./FallbackPreview";

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "";
  const s = Math.round(seconds);
  const parts = [Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, "0"));
  return s >= 3600 ? `${Math.floor(s / 3600)}:${parts.join(":")}` : `${Math.floor(s / 60)}:${parts[1]}`;
}

export function VideoPreview({ src, onInfo, onFail }: PreviewProps) {
  return (
    <video
      className="preview-video"
      src={src}
      controls
      preload="metadata"
      onLoadedMetadata={(e) => {
        const v = e.currentTarget;
        // A file with a playable audio track but an unsupported video track "loads" with no picture.
        if (!v.videoWidth) return onFail("This video's codec can't be played here.");
        onInfo(`${numberFmt.format(v.videoWidth)} × ${numberFmt.format(v.videoHeight)} · ${formatDuration(v.duration)}`);
      }}
      onError={() => onFail("This video format can't be played here.")}
    />
  );
}

export function AudioPreview({ entry, src, onInfo, onFail }: PreviewProps) {
  // Windows extracts embedded album art as the file's thumbnail.
  const art = useShellThumbnail(entry.path, 512);
  return (
    <div className="preview-center preview-audio">
      <div className="preview-art">
        {art.url ? <img src={art.url} draggable={false} alt="" /> : art.done && <FileIcon category="audio" size={88} />}
      </div>
      <audio
        src={src}
        controls
        preload="metadata"
        onLoadedMetadata={(e) => onInfo(formatDuration(e.currentTarget.duration))}
        onError={() => onFail("This audio format can't be played here.")}
      />
    </div>
  );
}
