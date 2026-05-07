export function normalizePath(input: string): string {
  if (!input || input === "/" || input === ".") return "/";
  let p = input.trim().replace(/\\/g, "/");
  if (!p.startsWith("/")) p = "/" + p;
  p = p.replace(/\/+/g, "/");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

export function splitPath(p: string): string[] {
  const n = normalizePath(p);
  return n === "/" ? [] : n.slice(1).split("/");
}

export function joinPath(...parts: string[]): string {
  return normalizePath("/" + parts.filter(Boolean).join("/"));
}

export function parentOf(p: string): string {
  const segs = splitPath(p);
  if (segs.length <= 1) return "/";
  return "/" + segs.slice(0, -1).join("/");
}

export function basename(p: string): string {
  const segs = splitPath(p);
  return segs.length === 0 ? "" : (segs[segs.length - 1] ?? "");
}

export function matchGlob(glob: string, path: string): boolean {
  const g = normalizePath(glob);
  const p = normalizePath(path);
  if (g === p) return true;

  const re = new RegExp(
    "^" +
      g
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "::DOUBLESTAR::")
        .replace(/\*/g, "[^/]*")
        .replace(/::DOUBLESTAR::/g, ".*") +
      "$",
  );
  return re.test(p);
}
