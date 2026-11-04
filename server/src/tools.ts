import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config, Env } from "./config.js";
import type { HcssClient } from "./hcss.js";
import { defaultBusinessUnit, realUnits } from "./business_units.js";

type Rec = Record<string, unknown>;
let autoBu: string | undefined; // isolate-scoped; only set when exactly one real unit exists

export function buildServer(cfg: Config, hcss: HcssClient, _env: Env, _origin: string): McpServer {
  const server = new McpServer({ name: "schrex-hcss-e360", version: "0.1.0" });

  const reply = (payload: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] });
  const pick = (r: Rec, keys: string[]) => { const o: Rec = {}; for (const k of keys) if (r[k] !== undefined && r[k] !== null && r[k] !== "") o[k] = r[k]; return o; };

  // GET /api/v1/businessUnits: plain array (not paged), cached 5 min by the client.
  const listUnits = async () => (await hcss.get<Rec[]>("/api/v1/businessUnits")) ?? [];
  /** Business unit for equipment lookups: argument, then HCSS_BUSINESS_UNIT_ID, then the only real unit. */
  const bu = async (id?: string): Promise<string> => {
    const v = id ?? cfg.businessUnitId ?? autoBu;
    if (v) return v;
    return (autoBu = defaultBusinessUnit(await listUnits()));
  };

  // TEMPORARY: verifies the full path (Claude sign-in -> HCSS token -> E360). Remove once the labor tools land.
  server.tool("list_business_units", "List E360 business units. default_candidate marks real units (placeholder all-zero ids are ignored; duplicates by code collapsed). selected is the unit used by default, if any.", {}, async () => {
    const rows = await listUnits();
    const real = new Set(realUnits(rows));
    let selected: string | undefined, selection_error: string | undefined;
    try { selected = await bu(); } catch (e) { selection_error = (e as Error).message; }
    return reply({ count: rows.length, distinct_real_units: real.size, selected, selection_error,
      data: rows.map((u) => ({ ...pick(u, ["id", "code", "description"]), default_candidate: real.has(u) })) });
  });

  return server;
}
