const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

export function formatSize(bytes: number): string {
  if (!bytes) return "0 B";
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1);
  const v = bytes / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${UNITS[i]}`;
}

const dateFmt = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

export function formatDate(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return `Today, ${timeFmt.format(d)}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday, ${timeFmt.format(d)}`;
  return dateFmt.format(d);
}

export function formatDateFull(ms: number): string {
  if (!ms) return "Unknown";
  return new Date(ms).toLocaleString();
}

export const numberFmt = new Intl.NumberFormat();

/** Parse "1.5 GB", "200k", "10mb", "512" into bytes. Returns null if invalid. */
export function parseSize(input: string): number | null {
  const m = input.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([kmgtp]?)(i?b?)?$/);
  if (!m) return null;
  const mult = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4, p: 1024 ** 5 }[m[2]] ?? 1;
  return Math.round(parseFloat(m[1]) * mult);
}
