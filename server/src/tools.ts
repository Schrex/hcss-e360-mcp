import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config, Env } from "./config.js";
import type { HcssClient } from "./hcss.js";
import { buildLaborReport, centralDate, resolveRange } from "./labor_report.js";

type Rec = Record<string, unknown>;
const MAX_ROWS = 20_000; // per pull; beyond this the report is marked partial

export function buildServer(_cfg: Config, hcss: HcssClient, _env: Env, _origin: string): McpServer {
  const server = new McpServer({ name: "schrex-hcss-e360", version: "0.1.0" });
  const reply = (payload: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(payload) }] });
  const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: (e as Error).message }] });

  const date = z.string().describe("YYYY-MM-DD").optional();
  server.tool(
    "get_equipment_labor_hours",
    "Mechanic Time per Unit from E360 time cards for a date range: each Unit's regular, overtime, double-time and total hours (most hours first), " +
      "with Shop Time and Job Time as separate lines and grand totals. Excludes rejected cards and voided entries; approved_only keeps approved + exported cards. " +
      "No dates = last full Mon-Sun week; only start = through today; only end = the 7 days ending on end. Max 92 days. scope 'partial' means a limit was hit and totals are incomplete. " +
      "Each Unit is broken down by mechanic code and by work order. equipment = one Unit's equipment code (e.g. \"305\"): returns only that Unit plus its daily entries (Shop/Job Time left out); " +
      "an unknown code returns close matches. mechanic = one mechanic code, applied to every line.",
    {
      start: date,
      end: date,
      equipment: z.string().describe("Equipment code of one Unit, e.g. 305").optional(),
      mechanic: z.string().describe("Mechanic code as shown in the report").optional(),
      approved_only: z.boolean().optional(),
    },
    async ({ start, end, equipment: unitCode, mechanic, approved_only }) => {
      try {
        const today = centralDate(new Date()); // Schreiber is in US Central
        const range = resolveRange({ start, end, today }); // validate before spending any HCSS calls
        const cards = await hcss.pageAll<Rec>("/api/v1/timeCards", { beginDate: range.start, endDate: `${range.end}T23:59:59` }, MAX_ROWS);
        // No business unit filter: v1 time cards are company-wide, so the lookup needs every Unit (deleted ones too) for the join.
        const equipment = await hcss.pageAll<Rec>("/api/v1/equipment", { includeDeleted: true }, MAX_ROWS);
        return reply(buildLaborReport(cards.records, equipment.records, {
          ...range, today, approved_only, equipment: unitCode, mechanic, partial: cards.partial || equipment.partial,
        }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}
