import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config, Env } from "./config.js";
import type { HcssClient } from "./hcss.js";
import { buildLaborReport, centralDate, MAX_CHAT_DAYS, resolveRange, type LaborReport } from "./labor_report.js";
import { laborExport } from "./labor_export.js";
import { toXlsx, XLSX_MIME } from "./xlsx.js";

type Rec = Record<string, unknown>;
const MAX_ROWS = 20_000; // per pull; beyond this the report is marked partial

type LaborArgs = { start?: string; end?: string; equipment?: string; mechanic?: string; approved_only?: boolean };

/**
 * Pulls time cards + equipment and builds the report; shared by the chat tool and the export.
 * Dates are validated (and the range checked against maxDays) before any HCSS call is spent.
 */
async function laborReport(hcss: HcssClient, a: LaborArgs, o: { maxDays: number; detail?: boolean }): Promise<LaborReport> {
  const today = centralDate(new Date()); // Schreiber is in US Central
  const range = resolveRange({ start: a.start, end: a.end, today, maxDays: o.maxDays });
  const cards = await hcss.pageAll<Rec>("/api/v1/timeCards", { beginDate: range.start, endDate: `${range.end}T23:59:59` }, MAX_ROWS);
  // No business unit filter: v1 time cards are company-wide, so the lookup needs every Unit (deleted ones too) for the join.
  const equipment = await hcss.pageAll<Rec>("/api/v1/equipment", { includeDeleted: true }, MAX_ROWS);
  return buildLaborReport(cards.records, equipment.records, {
    ...range, today, maxDays: o.maxDays, detail: o.detail, approved_only: a.approved_only, equipment: a.equipment, mechanic: a.mechanic,
    partial: cards.partial || equipment.partial, equipment_incomplete: equipment.partial,
  });
}

export function buildServer(cfg: Config, hcss: HcssClient, env: Env, origin: string): McpServer {
  const server = new McpServer({ name: "schrex-hcss-e360", version: "0.1.0" });
  const reply = (payload: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(payload) }] });
  const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: (e as Error).message }] });

  const date = z.string().describe("YYYY-MM-DD").optional();
  const args = {
    start: date,
    end: date,
    equipment: z.string().describe("Equipment code of one Unit, e.g. 305").optional(),
    mechanic: z.string().describe("Mechanic code as shown in the report").optional(),
    approved_only: z.boolean().optional(),
  };
  server.tool(
    "get_equipment_labor_hours",
    "Mechanic Time per Unit from E360 time cards for a date range: each Unit's regular, overtime, double-time and total hours (most hours first), " +
      "with Shop Time and Job Time as separate lines and grand totals. Excludes rejected cards and voided entries; approved_only keeps approved + exported cards. " +
      "No dates = last full Mon-Sun week; only start = through today; only end = the 7 days ending on end. Max 92 days. scope 'partial' means a limit was hit and totals are incomplete. " +
      "Each Unit is broken down by mechanic code and by work order. equipment = one Unit's equipment code (e.g. \"305\"): returns only that Unit plus its daily entries (Shop/Job Time left out); " +
      "an unknown code returns close matches. mechanic = one mechanic code, applied to every line.",
    args,
    async (a) => {
      try {
        return reply(await laborReport(hcss, a, { maxDays: MAX_CHAT_DAYS }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "export_equipment_labor_hours",
    "Same Mechanic Time per Unit report and inputs as get_equipment_labor_hours, as an Excel (.xlsx) file: a Summary sheet (per-Unit regular/overtime/double-time/total, Shop Time, Job Time, grand total) " +
      "and a Detail sheet (one row per Counted Time entry: date, Unit, mechanic code, work order, work type, hours, status). Ranges over 92 days are allowed; " +
      "if an HCSS limit is hit the file and this response are marked partial. Returns a single-use download link that expires in 15 minutes.",
    args,
    async (a) => {
      try {
        const report = await laborReport(hcss, a, { maxDays: Infinity, detail: true });
        const x = laborExport(report);
        const buf = toXlsx(x.sheets);
        if (buf.byteLength > 24 * 1024 * 1024) throw new Error("Export exceeds the 25 MiB KV value limit. Use a shorter range.");
        const id = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
        await env.EXPORTS.put(`export:${id}`, buf, { expirationTtl: cfg.exportTtlSeconds, metadata: { name: x.filename, mime: XLSX_MIME } });
        return reply({
          file: x.filename, start: report.start, end: report.end, scope: report.scope,
          ...(x.partial && { warning: "PARTIAL: an HCSS limit was hit (row cap or request budget); totals in this file are incomplete. Export a shorter range for complete figures." }),
          units: report.units.length, detail_rows: report.detail?.length ?? 0,
          shop_time: report.shop_time, job_time: report.job_time, grand_total: report.grand_total,
          download_url: `${origin}/exports/${id}`,
          note: `Single-use link, expires in ${Math.round(cfg.exportTtlSeconds / 60)} minutes. Don't share it.`,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}
