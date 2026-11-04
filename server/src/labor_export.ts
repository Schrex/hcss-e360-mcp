import type { Hours, LaborReport } from "./labor_report.js";
import type { Sheet } from "./xlsx.js";

/** Sheet layout for the Mechanic Time per Unit xlsx. Pure: the caller zips (toXlsx) and stores it. */
export type LaborExport = { filename: string; partial: boolean; sheets: Sheet[] };

const PARTIAL = "PARTIAL: an HCSS limit was hit (row cap or request budget); totals are incomplete. Export a shorter range for complete figures.";
const h = (x: Hours) => [x.regular, x.overtime, x.double_time, x.total];

/** `report` must be built with `detail: true`. */
export function laborExport(report: LaborReport, generatedAt = new Date()): LaborExport {
  const partial = report.scope === "partial";
  const tail = partial ? [[PARTIAL]] : [];
  const summary = [
    ["Unit", "Description", "Regular", "Overtime", "Double time", "Total"],
    ...report.units.map((u) => [u.code, u.description, ...h(u)]),
    ...(report.equipment ? [] : [["Shop Time", "", ...h(report.shop_time)], ["Job Time", "", ...h(report.job_time)]]),
    ["Grand total", "", ...h(report.grand_total)],
    ...tail,
  ];
  const detail = [
    ["Date", "Unit", "Mechanic code", "Work order", "Work type", "Regular", "Overtime", "Double time", "Total", "Status"],
    ...(report.detail ?? []).map((d) => [d.date, d.unit, d.mechanic_code, d.work_order, d.work_type, ...h(d), d.status]),
    ...tail,
  ];
  const notes = [
    ["Report", "Mechanic Time per Unit (E360 time cards)"],
    ["Range", `${report.start} to ${report.end}`],
    ["Statuses", report.approved_only ? "Approved and exported only" : "All except rejected cards and voided entries"],
    ...(report.equipment ? [["Unit", report.equipment]] : []),
    ...(report.mechanic ? [["Mechanic", report.mechanic]] : []),
    ["Scope", partial ? `partial - ${PARTIAL}` : "full"],
    ["Generated (UTC)", generatedAt.toISOString()],
  ];
  const safe = (s: string) => s.replace(/[^\w.-]+/g, "_");
  const filename = ["mechanic-time-per-unit", report.start, report.end,
    ...(report.equipment ? [safe(report.equipment)] : []), ...(report.mechanic ? [safe(report.mechanic)] : []), ...(partial ? ["PARTIAL"] : [])].join("_") + ".xlsx";
  return {
    filename, partial,
    sheets: [{ name: "Summary", rows: summary, freezeHeader: true }, { name: "Detail", rows: detail, freezeHeader: true }, { name: "Notes", rows: notes }],
  };
}
