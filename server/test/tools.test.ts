import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { HcssClient, resetHcssCaches } from "../src/hcss.ts";
import { fetchMechanicTime } from "../src/tools.ts";
import type { Config } from "../src/config.ts";

const cfg: Config = {
  clientId: "cid", clientSecret: "secret", scope: "e360:read e360:timecards:read",
  tokenUrl: "https://api.hcssapps.com/identity/connect/token", apiBase: "https://api.hcssapps.com/e360",
  pageSize: 1, maxSubrequests: 4, allowedCidrs: [], exportTtlSeconds: 900,
};
const dz101 = { id: "712b78b5-b10e-4df9-a6ee-1747754abb7b", code: "DZ-101", description: "The big yellow one." };
const card = { timeCardDate: "2026-10-27T00:00:00", status: "Approved", mechanicCode: "SMITH,J", workType: "Equipment", equipmentId: dz101.id, hours: 2 };
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
const realFetch = globalThis.fetch;

beforeEach(() => {
  resetHcssCaches();
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/token")) return json({ access_token: "tok", expires_in: 3600, scope: cfg.scope });
    if (url.pathname.endsWith("/equipment")) return json({ next: null, data: [dz101] });
    // Time cards page forever, one card per page, so the pull always runs out of budget.
    const cursor = Number(url.searchParams.get("cursor") ?? 0);
    return json({ next: cursor + 1, data: [card] });
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

test("a time card pull capped by the subrequest budget still yields a partial report with Units resolved", async () => {
  for (const detail of [false, true]) {
    resetHcssCaches();
    const report = await fetchMechanicTime(new HcssClient(cfg), {}, { maxDays: 92, detail, today: "2026-11-04" });
    assert.equal(report.scope, "partial");
    assert.deepEqual(report.units.map((u) => [u.code, u.total]), [["DZ-101", 4]]);
  }
});
