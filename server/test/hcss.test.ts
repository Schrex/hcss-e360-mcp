import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { HcssClient, resetHcssCaches } from "../src/hcss.ts";
import type { Config } from "../src/config.ts";

const cfg: Config = {
  clientId: "cid",
  clientSecret: "secret",
  scope: "e360:read e360:timecards:read",
  tokenUrl: "https://api.hcssapps.com/identity/connect/token",
  apiBase: "https://api.hcssapps.com/e360",
  pageSize: 2,
  maxSubrequests: 45,
  allowedCidrs: [],
  exportTtlSeconds: 900,
};

type Call = { url: string; method: string };
let calls: Call[];
let route: (url: URL, init: RequestInit) => Response;
const realFetch = globalThis.fetch;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const okToken = () => json({ access_token: "tok", expires_in: 3600, scope: "e360:read e360:timecards:read" });

beforeEach(() => {
  resetHcssCaches();
  calls = [];
  route = (url) => (url.pathname.endsWith("/token") ? okToken() : json([]));
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), method: init.method ?? "GET" });
    return route(url, init);
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

test("refuses any non-GET request before sending anything", async () => {
  const hcss = new HcssClient(cfg);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    await assert.rejects(hcss.request(method, "/api/v1/equipment"), /GET/);
  }
  assert.equal(calls.length, 0);
});

test("GET reaches E360 with a bearer token", async () => {
  let auth = "";
  route = (url, init) => {
    if (url.pathname.endsWith("/token")) return okToken();
    auth = new Headers(init.headers).get("Authorization") ?? "";
    return json([{ id: "b31f57c2-9861-4acf-816e-7faab246cfd5", code: "Houston Central" }]);
  };
  const rows = await new HcssClient(cfg).get<unknown[]>("/api/v1/businessUnits");
  assert.equal(rows.length, 1);
  assert.equal(auth, "Bearer tok");
  assert.equal(calls.at(-1)!.url, "https://api.hcssapps.com/e360/api/v1/businessUnits");
});

test("token refused for scope -> fixed error naming the E360 scopes", async () => {
  route = (url) => (url.pathname.endsWith("/token") ? json({ error: "invalid_scope" }, 400) : json([]));
  await assert.rejects(new HcssClient(cfg).get("/api/v1/businessUnits"),
    (e: Error) => e.message === "The HCSS Client ID needs the e360:read and e360:timecards:read scopes enabled in HCSS Credentials.");
});

test("403 on time cards -> fixed error naming e360:timecards:read", async () => {
  route = (url) => (url.pathname.endsWith("/token") ? okToken() : json({}, 403));
  await assert.rejects(new HcssClient(cfg).get("/api/v1/timeCards"),
    (e: Error) => e.message === "The HCSS Client ID needs the e360:timecards:read scope enabled in HCSS Credentials.");
});

test("403 on equipment -> fixed error naming e360:read", async () => {
  route = (url) => (url.pathname.endsWith("/token") ? okToken() : json({}, 403));
  await assert.rejects(new HcssClient(cfg).get("/api/v1/equipment"),
    (e: Error) => e.message === "The HCSS Client ID needs the e360:read scope enabled in HCSS Credentials.");
});

test("token granted without e360:timecards:read -> time card call refused, nothing sent to E360", async () => {
  route = (url) => (url.pathname.endsWith("/token") ? json({ access_token: "tok", expires_in: 3600, scope: "e360:read" }) : json({ data: [] }));
  await assert.rejects(new HcssClient(cfg).get("/api/v1/timeCards"),
    (e: Error) => e.message === "The HCSS Client ID needs the e360:timecards:read scope enabled in HCSS Credentials.");
  assert.ok(calls.every((c) => c.url.endsWith("/token")));
});

// E360 paged envelope: { count, prev, next, timestamp, data } with `count` + integer `cursor` query params.
const pages: Record<string, unknown> = {
  "": { count: 2, prev: null, next: 15, timestamp: 1594300743, data: [{ code: "DZ-101" }, { code: "DZ-102" }] },
  "15": { count: 2, prev: 11, next: 17, timestamp: 1594300743, data: [{ code: "DZ-103" }, { code: "DZ-104" }] },
  "17": { count: 1, prev: 15, next: null, timestamp: 1594300743, data: [{ code: "DZ-105" }] },
};
const pagedRoute = (url: URL) => (url.pathname.endsWith("/token") ? okToken() : json(pages[url.searchParams.get("cursor") ?? ""]));

test("pageAll follows `next` until null, asking for `count` rows per page", async () => {
  route = pagedRoute;
  const got = await new HcssClient(cfg).pageAll<{ code: string }>("/api/v1/equipment", {}, 100);
  assert.deepEqual(got.records.map((r) => r.code), ["DZ-101", "DZ-102", "DZ-103", "DZ-104", "DZ-105"]);
  assert.equal(got.partial, false);
  const api = calls.filter((c) => !c.url.endsWith("/token")).map((c) => new URL(c.url));
  assert.deepEqual(api.map((u) => u.searchParams.get("cursor")), [null, "15", "17"]);
  assert.ok(api.every((u) => u.searchParams.get("count") === "2"));
});

test("pageAll stops and marks partial at the row cap", async () => {
  route = pagedRoute;
  const got = await new HcssClient(cfg).pageAll("/api/v1/equipment", {}, 3);
  assert.equal(got.records.length, 3);
  assert.equal(got.partial, true);
});

test("pageAll stops on a repeated cursor", async () => {
  route = (url) => (url.pathname.endsWith("/token") ? okToken() : json({ count: 1, prev: null, next: 5, timestamp: 0, data: [{ code: "X" }] }));
  const got = await new HcssClient(cfg).pageAll("/api/v1/equipment", {}, 100);
  assert.equal(got.records.length, 2);
});

test("pageAll returns what it has as partial when the subrequest budget runs out", async () => {
  route = pagedRoute;
  const got = await new HcssClient({ ...cfg, maxSubrequests: 3 }).pageAll<{ code: string }>("/api/v1/equipment", {}, 100);
  assert.deepEqual(got.records.map((r) => r.code), ["DZ-101", "DZ-102", "DZ-103", "DZ-104"]);
  assert.equal(got.partial, true);
});
