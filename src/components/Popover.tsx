import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/** A button that opens a small floating panel underneath it. */
export function Popover({
  label,
  active,
  children,
  width = 240,
  align = "left",
}: {
  label: React.ReactNode;
  active?: boolean;
  children: React.ReactNode;
  width?: number;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div className="popover-anchor" ref={ref}>
      <button className={`chip-btn${active ? " active" : ""}${open ? " open" : ""}`} onClick={() => setOpen(!open)}>
        {label}
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className={`popover ${align}`} style={{ width }}>
          {children}
        </div>
      )}
    </div>
  );
}
