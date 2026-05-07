import { normalizePath } from "./path.js";
import {
  LlmFuseError,
  type LlmFuseCapability,
  type LlmFuseDirEntry,
  type LlmFuseInvokeResult,
  type LlmFuseNode,
  type LlmFuseProvider,
  type LlmFuseReadResult,
} from "./types.js";

export type Json = unknown;

export type IdSelector = string | ((item: Json) => string);

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ListRoute {
  path: string;
  list: string;
  id: IdSelector;
  childKind?: "dir" | "file";
}

export interface ReadRoute {
  path: string;
  read: string;
  contentType?: string;
}

export interface InvokeRoute {
  path: string;
  invoke: { method: HttpMethod; endpoint: string };
}

export type RestRoute = ListRoute | ReadRoute | InvokeRoute;

export interface RestProviderConfig {
  name: string;
  mountPoint: string;
  baseUrl: string;
  routes: RestRoute[];
  fetchImpl?: typeof fetch;
  cacheTtlMs?: number;
  defaultHeaders?: Record<string, string>;
}

interface CompiledRoute {
  raw: RestRoute;
  template: string;
  segments: string[];
  paramNames: string[];
}

interface PathMatch {
  compiled: CompiledRoute;
  params: Record<string, string>;
}

function compileRoutes(routes: RestRoute[]): CompiledRoute[] {
  return routes.map((r) => {
    const tmpl = normalizePath(r.path);
    const segs = tmpl === "/" ? [] : tmpl.slice(1).split("/");
    const params = segs.filter((s) => s.startsWith(":")).map((s) => s.slice(1));
    return { raw: r, template: tmpl, segments: segs, paramNames: params };
  });
}

function tryMatchExact(
  compiled: CompiledRoute,
  path: string,
): Record<string, string> | null {
  const norm = normalizePath(path);
  const segs = norm === "/" ? [] : norm.slice(1).split("/");
  if (segs.length !== compiled.segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < segs.length; i++) {
    const t = compiled.segments[i];
    const s = segs[i];
    if (t === undefined || s === undefined) return null;
    if (t.startsWith(":")) {
      params[t.slice(1)] = s;
    } else if (t !== s) {
      return null;
    }
  }
  return params;
}

function tryMatchPrefix(
  compiled: CompiledRoute,
  path: string,
): Record<string, string> | null {
  const norm = normalizePath(path);
  const segs = norm === "/" ? [] : norm.slice(1).split("/");
  if (segs.length >= compiled.segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < segs.length; i++) {
    const t = compiled.segments[i];
    const s = segs[i];
    if (t === undefined || s === undefined) return null;
    if (t.startsWith(":")) {
      params[t.slice(1)] = s;
    } else if (t !== s) {
      return null;
    }
  }
  return params;
}

function expand(
  template: string,
  params: Record<string, string>,
): string {
  return template.replace(/:([A-Za-z0-9_]+)/g, (_m, k: string) => {
    const v = params[k];
    if (v === undefined) {
      throw new LlmFuseError(`missing parameter ${k} for ${template}`, "EINVAL");
    }
    return encodeURIComponent(v);
  });
}

function deriveCapabilities(route: RestRoute): LlmFuseCapability[] {
  if ("list" in route) return ["list"];
  if ("read" in route) return ["read"];
  if ("invoke" in route) return ["invoke"];
  return [];
}

function selectId(selector: IdSelector, item: Json): string {
  if (typeof selector === "function") return String(selector(item));
  if (item && typeof item === "object" && selector in (item as object)) {
    return String((item as Record<string, unknown>)[selector]);
  }
  throw new LlmFuseError(`could not extract id "${String(selector)}" from item`, "EIO");
}

export class CachedFetcher {
  private cache = new Map<string, { at: number; value: unknown }>();
  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly ttlMs: number,
    private readonly defaultHeaders: Record<string, string>,
  ) {}

  async getJson(url: string): Promise<unknown> {
    const cached = this.cache.get(url);
    const now = Date.now();
    if (cached && now - cached.at < this.ttlMs) return cached.value;
    const res = await this.fetchImpl(url, { headers: this.defaultHeaders });
    if (!res.ok) {
      throw new LlmFuseError(`upstream ${res.status} for ${url}`, "EIO");
    }
    const value = (await res.json()) as unknown;
    this.cache.set(url, { at: now, value });
    return value;
  }

  async send(
    url: string,
    method: HttpMethod,
    body: unknown,
  ): Promise<unknown> {
    const res = await this.fetchImpl(url, {
      method,
      headers: { "content-type": "application/json", ...this.defaultHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      throw new LlmFuseError(`upstream ${res.status} ${method} ${url}`, "EIO");
    }
    const text = await res.text();
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return text;
    }
  }
}

export class RestProvider implements LlmFuseProvider {
  readonly name: string;
  readonly mountPoint: string;
  private readonly baseUrl: string;
  private readonly compiled: CompiledRoute[];
  private readonly fetcher: CachedFetcher;

  constructor(config: RestProviderConfig) {
    this.name = config.name;
    this.mountPoint = normalizePath(config.mountPoint);
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.compiled = compileRoutes(config.routes);
    this.fetcher = new CachedFetcher(
      config.fetchImpl ?? fetch,
      config.cacheTtlMs ?? 60_000,
      config.defaultHeaders ?? {},
    );
  }

  private matchExact(path: string): PathMatch | null {
    for (const c of this.compiled) {
      const params = tryMatchExact(c, path);
      if (params) return { compiled: c, params };
    }
    return null;
  }

  private isVirtualDir(path: string): boolean {
    const norm = normalizePath(path);
    if (norm === "/") return true;
    for (const c of this.compiled) {
      if (tryMatchPrefix(c, norm) !== null) return true;
    }
    return false;
  }

  private staticChildren(parentPath: string): LlmFuseDirEntry[] {
    const norm = normalizePath(parentPath);
    const parentSegs = norm === "/" ? [] : norm.slice(1).split("/");
    const seen = new Map<string, { kind: "dir" | "file" | "action"; caps: LlmFuseCapability[] }>();

    for (const c of this.compiled) {
      if (c.segments.length <= parentSegs.length) continue;
      let prefixOk = true;
      for (let i = 0; i < parentSegs.length; i++) {
        const t = c.segments[i];
        const s = parentSegs[i];
        if (t === undefined || s === undefined) { prefixOk = false; break; }
        if (!t.startsWith(":") && t !== s) { prefixOk = false; break; }
      }
      if (!prefixOk) continue;

      const nextSeg = c.segments[parentSegs.length];
      if (nextSeg === undefined) continue;
      if (nextSeg.startsWith(":")) continue; // dynamic - exposed via list
      const isLeaf = c.segments.length === parentSegs.length + 1;
      const caps = deriveCapabilities(c.raw);
      const kind: "dir" | "file" | "action" = isLeaf
        ? "list" in c.raw
          ? "dir"
          : "read" in c.raw
            ? "file"
            : "action"
        : "dir";

      const existing = seen.get(nextSeg);
      if (!existing) {
        seen.set(nextSeg, { kind, caps });
      } else if (!isLeaf && existing.kind !== "dir") {
        existing.kind = "dir";
        existing.caps = ["list"];
      }
    }
    return Array.from(seen.entries()).map(([name, info]) => ({
      name,
      kind: info.kind === "action" ? "action" : info.kind,
      capabilities: info.caps,
    }));
  }

  async stat(path: string): Promise<LlmFuseNode> {
    const norm = normalizePath(path);
    const exact = this.matchExact(norm);
    if (exact) {
      if ("list" in exact.compiled.raw) {
        return { path: norm, kind: "dir", capabilities: ["list"] };
      }
      if ("read" in exact.compiled.raw) {
        return {
          path: norm,
          kind: "file",
          capabilities: ["read"],
          contentType: exact.compiled.raw.contentType ?? "application/json",
        };
      }
      return { path: norm, kind: "action", capabilities: ["invoke"] };
    }
    if (this.isVirtualDir(norm)) {
      return { path: norm, kind: "dir", capabilities: ["list"] };
    }
    throw new LlmFuseError(`no such path ${norm}`, "ENOENT");
  }

  async list(path: string): Promise<LlmFuseDirEntry[]> {
    const norm = normalizePath(path);
    const exact = this.matchExact(norm);
    if (exact && "list" in exact.compiled.raw) {
      const route = exact.compiled.raw;
      const url = this.baseUrl + expand(route.list, exact.params);
      const data = await this.fetcher.getJson(url);
      if (!Array.isArray(data)) {
        throw new LlmFuseError(`expected array from ${url}`, "EIO");
      }
      const childKind = route.childKind
        ?? (this.staticChildren(norm + "/:any").length > 0 ? "dir" : this.hasDeeperRoutes(norm) ? "dir" : "file");
      return data.map((item) => ({
        name: selectId(route.id, item),
        kind: childKind,
        capabilities:
          childKind === "dir" ? ["list", "read"] : ["read"],
      }));
    }
    if (this.isVirtualDir(norm) || (exact && !("read" in exact.compiled.raw) && !("invoke" in exact.compiled.raw))) {
      return this.staticChildren(norm);
    }
    throw new LlmFuseError(`not a directory: ${norm}`, "EINVAL");
  }

  private hasDeeperRoutes(parentPath: string): boolean {
    const norm = normalizePath(parentPath);
    const parentSegs = norm === "/" ? [] : norm.slice(1).split("/");
    for (const c of this.compiled) {
      if (c.segments.length <= parentSegs.length + 1) continue;
      let ok = true;
      for (let i = 0; i < parentSegs.length; i++) {
        const t = c.segments[i];
        const s = parentSegs[i];
        if (t === undefined || s === undefined) { ok = false; break; }
        if (!t.startsWith(":") && t !== s) { ok = false; break; }
      }
      if (ok) return true;
    }
    return false;
  }

  async read(path: string): Promise<LlmFuseReadResult> {
    const norm = normalizePath(path);
    const exact = this.matchExact(norm);
    if (!exact || !("read" in exact.compiled.raw)) {
      throw new LlmFuseError(`not a readable file: ${norm}`, "EINVAL");
    }
    const url = this.baseUrl + expand(exact.compiled.raw.read, exact.params);
    const data = await this.fetcher.getJson(url);
    return {
      contentType: exact.compiled.raw.contentType ?? "application/json",
      body: JSON.stringify(data, null, 2),
    };
  }

  async invoke(path: string, input: unknown): Promise<LlmFuseInvokeResult> {
    const norm = normalizePath(path);
    const exact = this.matchExact(norm);
    if (!exact || !("invoke" in exact.compiled.raw)) {
      throw new LlmFuseError(`not an invokable action: ${norm}`, "EINVAL");
    }
    const def = exact.compiled.raw.invoke;
    const url = this.baseUrl + expand(def.endpoint, exact.params);
    const output = await this.fetcher.send(url, def.method, input);
    return { ok: true, output, contentType: "application/json" };
  }
}

export function defineRestProvider(config: RestProviderConfig): LlmFuseProvider {
  return new RestProvider(config);
}
