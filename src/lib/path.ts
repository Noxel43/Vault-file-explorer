/** Virtual locations that aren't real folders. */
export const THIS_PC = "vault:this-pc";
export const TAG_PREFIX = "vault:tag/";

export const isVirtual = (p: string) => p.startsWith("vault:");
export const tagLocation = (id: number) => `${TAG_PREFIX}${id}`;
export const tagIdOf = (p: string) =>
  p.startsWith(TAG_PREFIX) ? Number(p.slice(TAG_PREFIX.length)) : null;

const SEP = "\\";

export function join(dir: string, name: string): string {
  return dir.endsWith(SEP) || dir.endsWith("/") ? dir + name : dir + SEP + name;
}

export function parentOf(path: string): string | null {
  if (isVirtual(path)) return null;
  const trimmed = path.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (i < 0) return THIS_PC;
  const parent = trimmed.slice(0, i);
  // "C:" -> "C:\"
  if (/^[a-zA-Z]:$/.test(parent)) return parent + SEP;
  if (parent === "") return "/";
  return parent;
}

export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return i < 0 ? trimmed : trimmed.slice(i + 1);
}

export interface Crumb {
  label: string;
  path: string;
}

export function crumbs(path: string): Crumb[] {
  const out: Crumb[] = [{ label: "This PC", path: THIS_PC }];
  if (isVirtual(path)) return out;
  const parts = path.split(/[\\/]/).filter(Boolean);
  let acc = "";
  parts.forEach((part, i) => {
    acc = i === 0 ? (/^[a-zA-Z]:$/.test(part) ? part + SEP : SEP + part) : join(acc, part);
    out.push({ label: part, path: acc });
  });
  return out;
}

/** Case-insensitive key for lookups (Windows paths are case-insensitive). */
export const pathKey = (p: string) => p.toLowerCase();
