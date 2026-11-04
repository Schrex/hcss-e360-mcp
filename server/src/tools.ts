import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config, Env } from "./config.js";
import type { HcssClient } from "./hcss.js";
import { buildLaborReport, centralDate, MAX_CHAT_DAYS, resolveRange, type EquipmentRecord, type LaborReport, type TimeCardRow } from "./labor_report.js";
import { laborExport, PARTIAL } from "./labor_export.js";
import { toXlsx, XLSX_MIME } from "./xlsx.js";

const MAX_ROWS = 20_000; // per pull; beyond this the report is marked partial
const MAX_EXPORT_BYTES = 24 * 1024 * 1024; // under the 25 MiB KV value limit

export type MechanicTimeArgs = { start?: string; end?: string; equipment?: string; mechanic?: string; approved_only?: boolean };

/**
 * Pulls time cards + equipment and builds the report; shared by the chat tool and the export.
 * Dates are validated (and the range checked against maxDays) before any HCSS call is spent.
 */
export async function fetchMechanicTime(hcss: HcssClient, args: MechanicTimeArgs, options: { maxDays: number; detail?: boolean; today?: string }): Promise<LaborReport> {
  const today = options.today ?? centralDate(new Date()); // Schreiber is in US Central
  const range = resolveRange({ start: args.start, end: args.end, today, maxDays: options.maxDays });
  // Equipment first (small, usually cached): if the time card pull then exhausts the subrequest budget,
  // the report is still built from what was fetched and marked partial instead of failing.
  // No business unit filter: v1 time cards are company-wide, so the lookup needs every Unit (deleted ones too) for the join.
  const equipment = await hcss.pageAll<EquipmentRecord>("/api/v1/equipment", { includeDeleted: true }, MAX_ROWS);
  const cards = await hcss.pageAll<TimeCardRow>("/api/v1/timeCards", { beginDate: range.start, endDate: `${range.end}T23:59:59` }, MAX_ROWS);
  return buildLaborReport(cards.records, equipment.records, {
    range, detail: options.detail, approved_only: args.approved_only, equipment: args.equipment, mechanic: args.mechanic,
    partial: cards.partial || equipment.partial, equipment_incomplete: equipment.partial,
  });
}

/** Stores an xlsx in KV under a fresh unguessable id; returns the id. */
async function storeExport(env: Env, cfg: Config, file: Uint8Array, filename: string): Promise<string> {
  if (file.byteLength > MAX_EXPORT_BYTES) throw new Error("Export exceeds the 25 MiB KV value limit. Use a shorter range.");
  const id = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  await env.EXPORTS.put(`export:${id}`, file, { expirationTtl: cfg.exportTtlSeconds, metadata: { name: filename, mime: XLSX_MIME } });
  return id;
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
      "with Shop Time and Job Time as separate lines, an Other Time line for any other work type (listing them), and grand totals. Excludes rejected cards and voided entries; approved_only keeps approved + exported cards. " +
      `No dates = last full Mon-Sun week; only start = through today; only end = the 7 days ending on end. Max ${MAX_CHAT_DAYS} days. scope 'partial' means a limit was hit and totals are incomplete. ` +
      "Each Unit is broken down by mechanic code and by work order. equipment = one Unit's equipment code (e.g. \"305\"): returns only that Unit plus its daily entries (Shop/Job/Other Time left out); " +
      "an unknown code returns close matches. mechanic = one mechanic code, applied to every line.",
    args,
    async (a) => {
      try {
        return reply(await fetchMechanicTime(hcss, a, { maxDays: MAX_CHAT_DAYS }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "export_equipment_labor_hours",
    "Same Mechanic Time per Unit report and inputs as get_equipment_labor_hours, as an Excel (.xlsx) file: a Summary sheet (per-Unit regular/overtime/double-time/total, Shop Time, Job Time, Other Time, grand total) " +
      `and a Detail sheet (one row per Counted Time entry: date, Unit, mechanic code, work order, work type, hours, status). Ranges over ${MAX_CHAT_DAYS} days are allowed; ` +
      "if an HCSS limit is hit the file and this response are marked partial. Returns a single-use download link that expires in 15 minutes.",
    args,
    async (a) => {
      try {
        const report = await fetchMechanicTime(hcss, a, { maxDays: Infinity, detail: true });
        const exported = laborExport(report);
        const id = await storeExport(env, cfg, toXlsx(exported.sheets), exported.filename);
        return reply({
          file: exported.filename, start: report.start, end: report.end, scope: report.scope,
          ...(exported.partial && { warning: PARTIAL }),
          units: report.units.length, detail_rows: report.detail?.length ?? 0,
          shop_time: report.shop_time, job_time: report.job_time, other_time: report.other_time, grand_total: report.grand_total,
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
