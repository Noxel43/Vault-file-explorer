import { useEffect, useState } from "react";
import type { PreviewProps } from "../../lib/preview";
import { PreviewLoading } from "./FallbackPreview";

const SIZES = [14, 18, 24, 36, 54];
let nextFamily = 0;

export function FontPreview({ src, onFail }: PreviewProps) {
  const [family, setFamily] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const name = `vault-preview-${++nextFamily}`;
    const face = new FontFace(name, `url("${src}")`);
    face
      .load()
      .then(() => {
        if (cancelled) return;
        document.fonts.add(face);
        setFamily(name);
      })
      .catch(() => !cancelled && onFail("This font couldn't be loaded."));
    return () => {
      cancelled = true;
      document.fonts.delete(face);
    };
  }, [src]);

  if (!family) return <PreviewLoading />;
  return (
    <div className="preview-scroll preview-font" style={{ fontFamily: `"${family}"` }}>
      <div className="preview-font-glyphs">
        ABCDEFGHIJKLMNOPQRSTUVWXYZ
        <br />
        abcdefghijklmnopqrstuvwxyz
        <br />
        0123456789 &amp;!?@#%()
      </div>
      {SIZES.map((size) => (
        <div key={size} className="preview-font-sample">
          <span className="faint">{size}</span>
          <div style={{ fontSize: size }}>The quick brown fox jumps over the lazy dog</div>
        </div>
      ))}
    </div>
  );
}
