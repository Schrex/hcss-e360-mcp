import type { Config } from "./config.js";
import { grantedIncludes, scopeError, scopeForPath } from "./scopes.js";

type Query = Record<string, string | number | boolean | undefined>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Isolate-scoped caches (best effort; isolates are reused but can be evicted any time).
type TokenEntry = { token: string; exp: number; granted?: string };
const tokenCache = new Map<string, TokenEntry>();
const cache = new Map<string, { at: number; value: unknown }>();
const CACHE_TTL_MS = 5 * 60_000;

/** Clears the isolate caches (tests only). */
export function resetHcssCaches() { tokenCache.clear(); cache.clear(); }

export class InvalidHcssScopeError extends Error {
  requestedScope: string;
  status: number;
  constructor(requestedScope: string, status: number) {
    super("invalid_scope");
    this.name = "InvalidHcssScopeError";
    this.requestedScope = requestedScope;
    this.status = status;
  }
}

export class BudgetError extends Error {}

type CallOpts = { forbiddenError?: string };

// HCSS sits behind an Azure firewall that blocks some default user agents.
export const HCSS_HEADERS = { "User-Agent": "Mozilla/5.0 SchreiberMCP/0.1", Accept: "application/json" } as const;

async function readJson<T>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  const ct = res.headers.get("Content-Type") ?? "";
  const head = text.trimStart().slice(0, 15).toLowerCase();
  if (ct.includes("text/html") || head.startsWith("<!doctype") || head.startsWith("<html") || /request is blocked/i.test(text.slice(0, 2000))) {
    throw new Error(`HCSS firewall blocked request (${what}: HTTP ${res.status}, HTML response instead of JSON)`);
  }
  if (!text) return undefined as T;
  try { return JSON.parse(text) as T; } catch { throw new Error(`HCSS returned non-JSON for ${what} (HTTP ${res.status})`); }
}

/**
 * Read-only E360 client, one per Worker invocation so it can count subrequests
 * (free plan: 50/invocation; token + every HCSS page count).
 * GET only: E360 documents no read-only POST endpoints, so any other method is refused before sending.
 */
export class HcssClient {
  used = 0;
  private cfg: Config;
  constructor(cfg: Config) { this.cfg = cfg; }

  private spend() {
    if (++this.used > this.cfg.maxSubrequests) {
      throw new BudgetError(`Request too large for the Workers free plan (${this.cfg.maxSubrequests} HCSS calls per request). Narrow it: a shorter date range, one unit, or one mechanic.`);
    }
  }

  /** One client-credentials token for the configured scope (cached per isolate until 60 s before expiry). */
  private async requestToken(scope: string): Promise<{ token: string; cacheKey: string; granted?: string }> {
    const cacheKey = this.cfg.clientId + "|" + scope;
    const hit = tokenCache.get(cacheKey);
    if (hit && Date.now() < hit.exp - 60_000) return { token: hit.token, cacheKey, granted: hit.granted };
    const form = (withClientInBody: boolean) => {
      const f = new URLSearchParams({ grant_type: "client_credentials", scope });
      if (withClientInBody) { f.set("client_id", this.cfg.clientId); f.set("client_secret", this.cfg.clientSecret); }
      return f;
    };
    const post = (body: URLSearchParams, basic: boolean) => {
      this.spend();
      const headers: Record<string, string> = { ...HCSS_HEADERS, "Content-Type": "application/x-www-form-urlencoded" };
      if (basic) headers.Authorization = "Basic " + btoa(`${encodeURIComponent(this.cfg.clientId)}:${encodeURIComponent(this.cfg.clientSecret)}`);
      return fetch(this.cfg.tokenUrl, { method: "POST", headers, body });
    };
    let res = await post(form(true), false);
    if (res.status === 400 || res.status === 401) {
      const err = await readJson<{ error?: string }>(res, "token").catch(() => ({} as { error?: string }));
      if (err?.error === "invalid_scope") throw new InvalidHcssScopeError(scope, res.status);
      if (err?.error && err.error !== "invalid_client") throw new Error(`HCSS token request failed: HTTP ${res.status} ${err.error}`);
      res = await post(form(false), true); // fall back once to HTTP Basic client auth
    }
    if (!res.ok) {
      if ((res.headers.get("Content-Type") ?? "").includes("text/html")) await readJson(res, "token");
      if (res.status === 400 || res.status === 401) {
        try {
          const err = await readJson<{ error?: string }>(res, "token");
          if (err?.error === "invalid_scope") throw new InvalidHcssScopeError(scope, res.status);
        } catch (e) {
          if (e instanceof InvalidHcssScopeError) throw e;
          if (e instanceof Error && /firewall blocked/.test(e.message)) throw e;
        }
      }
      throw new Error(`HCSS token request failed: HTTP ${res.status}`); // never echo secrets
    }
    const j = await readJson<{ access_token: string; expires_in?: number; scope?: string }>(res, "token");
    const granted = typeof j.scope === "string" ? j.scope : undefined;
    const entry: TokenEntry = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000, granted };
    tokenCache.set(cacheKey, entry);
    return { token: entry.token, cacheKey, granted };
  }

  /** Token for the configured scope. A refused scope, or a grant missing the scope `path` needs, becomes a fixed error. */
  private async access(path: string): Promise<{ token: string; cacheKey: string }> {
    const scope = this.cfg.scope.trim();
    let got;
    try {
      got = await this.requestToken(scope);
    } catch (e) {
      if (e instanceof InvalidHcssScopeError) throw new Error(scopeError(...scope.split(/\s+/).filter(Boolean)));
      throw e;
    }
    const needed = scopeForPath(path);
    if (!grantedIncludes(got.granted, needed)) throw new Error(scopeError(needed));
    return { token: got.token, cacheKey: got.cacheKey };
  }

  /** Any HTTP method may be asked for; only GET is ever sent. */
  async request<T>(method: string, path: string, query: Query = {}, opts?: CallOpts): Promise<T> {
    if (method.toUpperCase() !== "GET") throw new Error(`Refusing ${method} ${path}: this connector only makes GET requests to E360.`);
    const url = new URL(this.cfg.apiBase + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    const key = `GET ${url}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;

    for (let attempt = 0; attempt < 4; attempt++) {
      const auth = await this.access(path);
      this.spend();
      const res = await fetch(url.toString(), { method: "GET", headers: { ...HCSS_HEADERS, Authorization: `Bearer ${auth.token}` } });
      if (res.status === 401 && attempt === 0) { tokenCache.delete(auth.cacheKey); continue; }
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get("Retry-After"));
        await sleep(Math.min(20_000, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt) + Math.random() * 250);
        continue;
      }
      if ((res.headers.get("Content-Type") ?? "").includes("text/html")) await readJson(res, `GET ${url.pathname}`);
      if (res.status === 403) throw new Error(opts?.forbiddenError ?? scopeError(scopeForPath(path)));
      if (!res.ok) {
        // Pass HCSS's own explanation through, truncated. Bodies never contain our secrets.
        const text = (await res.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 500);
        throw new Error(`HCSS GET ${url.pathname} failed: HTTP ${res.status}${text ? ` - ${text}` : ""}`);
      }
      const value = await readJson<T>(res, `GET ${url.pathname}`);
      cache.set(key, { at: Date.now(), value });
      if (cache.size > 50) cache.delete(cache.keys().next().value as string);
      return value;
    }
    throw new Error(`HCSS GET ${url.pathname}: gave up after repeated 429/5xx (HCSS limit is 100/min per company, shared with the nightly sync and other connectors).`);
  }

  get<T>(path: string, query: Query = {}, opts?: CallOpts) { return this.request<T>("GET", path, query, opts); }

  /**
   * E360 paging: `count` (rows per page, max 1000) + integer `cursor` query params;
   * response `{ count, prev, next, timestamp, data }`, `next` null at the end.
   * Pages sequentially (shared 100 req/min company limit) until `next` is null, a page is empty, the cursor repeats,
   * maxRecords is reached, or the subrequest budget runs out. The last two return what was fetched with partial: true.
   */
  async pageAll<T>(path: string, query: Query, maxRecords: number, opts?: CallOpts): Promise<{ records: T[]; partial: boolean }> {
    const out: T[] = [];
    const seen = new Set<number>();
    let cursor: number | undefined;
    try {
      for (;;) {
        const count = Math.min(this.cfg.pageSize, maxRecords - out.length);
        const page = await this.get<E360Page<T>>(path, { ...query, count, cursor }, opts);
        const rows = page?.data ?? [];
        out.push(...rows.slice(0, maxRecords - out.length));
        const next = typeof page?.next === "number" ? page.next : undefined;
        if (next === undefined || rows.length === 0 || seen.has(next) || next === cursor) return { records: out, partial: false };
        if (out.length >= maxRecords) return { records: out, partial: true };
        if (cursor !== undefined) seen.add(cursor);
        cursor = next;
      }
    } catch (e) {
      if (e instanceof BudgetError && out.length > 0) return { records: out, partial: true };
      throw e;
    }
  }
}

/** E360 paged response envelope (ApiXxxApiPagedResponse). */
export type E360Page<T> = { count?: number; prev?: number | null; next?: number | null; timestamp?: number; data?: T[] | null };

/** Trim + natural compare for HCSS codes. */
export const normCode = (v: unknown) => String(v ?? "").trim();
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
export const codeCompare = (a: unknown, b: unknown) => collator.compare(normCode(a), normCode(b));
export const codeEq = (a: unknown, b: unknown) => normCode(a).toLowerCase() === normCode(b).toLowerCase();
