import { codeCompare, normCode } from "./hcss.js";

/**
 * Mechanic Time per Unit report. Pure: no HCSS calls, no clock ("today" is passed in).
 * Input rows are raw GET /api/v1/timeCards rows (one per card detail line) and GET /api/v1/equipment records.
 */

type Rec = Record<string, unknown>;

export const MAX_CHAT_DAYS = 92;

export type Hours = { regular: number; overtime: number; double_time: number; total: number };
/** One Unit's line. #3 adds optional `mechanics`, `work_orders` and `entries` alongside these fields. */
export type UnitRow = { code: string; description: string } & Hours;
export type LaborReport = {
  start: string;
  end: string;
  approved_only: boolean;
  scope: "full" | "partial";
  units: UnitRow[];
  shop_time: Hours;
  job_time: Hours;
  grand_total: Hours;
};

export type ReportOptions = {
  start?: string;
  end?: string;
  /** YYYY-MM-DD, the caller's current date; used for the default week. */
  today: string;
  approved_only?: boolean;
  /** Set when the time card pull was capped (row limit / subrequest budget). */
  partial?: boolean;
  /** Longest allowed range in days; default MAX_CHAT_DAYS. */
  maxDays?: number;
};

const DAY_MS = 86_400_000;
const toMs = (d: string) => Date.parse(d + "T00:00:00Z");
const fromMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function parseDate(field: string, v: string): string {
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(v) ? toMs(v) : NaN;
  if (!Number.isFinite(ms) || fromMs(ms) !== v) {
    throw new Error(`Invalid ${field} "${v}": use a real date in YYYY-MM-DD format.`);
  }
  return v;
}

/**
 * Resolves the reporting range. No dates: the last full Mon–Sun week before `today`.
 * Only `start`: through `today`. Only `end`: the 7 days ending on `end`.
 * Refuses start > end and ranges longer than `maxDays` (pointing to the xlsx export).
 */
export function resolveRange(o: { start?: string; end?: string; today: string; maxDays?: number }): { start: string; end: string } {
  const today = parseDate("today", o.today);
  let start = o.start === undefined ? undefined : parseDate("start", o.start);
  let end = o.end === undefined ? undefined : parseDate("end", o.end);
  if (start === undefined && end === undefined) {
    const t = toMs(today);
    const sinceMonday = (new Date(t).getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
    const thisMonday = t - sinceMonday * DAY_MS;
    start = fromMs(thisMonday - 7 * DAY_MS);
    end = fromMs(thisMonday - DAY_MS);
  } else if (end === undefined) {
    end = today;
  } else if (start === undefined) {
    start = fromMs(toMs(end) - 6 * DAY_MS);
  }
  if (start! > end!) throw new Error(`start (${start}) is after end (${end}).`);
  const days = (toMs(end!) - toMs(start!)) / DAY_MS + 1;
  const max = o.maxDays ?? MAX_CHAT_DAYS;
  if (days > max) {
    throw new Error(`Range ${start} to ${end} is ${days} days; chat reports are limited to ${max} days. Use a shorter range, or export_equipment_labor_hours for an xlsx file.`);
  }
  return { start: start!, end: end! };
}

const lower = (v: unknown) => String(v ?? "").trim().toLowerCase();
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const r2 = (x: number) => Math.round(x * 100) / 100;

type Acc = { regular: number; overtime: number; double_time: number };
const acc = (): Acc => ({ regular: 0, overtime: 0, double_time: 0 });
const add = (a: Acc, row: Rec) => { a.regular += num(row.hours); a.overtime += num(row.overtime); a.double_time += num(row.doubleTime); };
const out = (a: Acc): Hours => ({ regular: r2(a.regular), overtime: r2(a.overtime), double_time: r2(a.double_time), total: r2(a.regular + a.overtime + a.double_time) });

/** Counted Time filter: drops rejected cards and voided entries; approved-only keeps approved + exported. Status casing unverified, so compared case-insensitively. */
function counted(row: Rec, approvedOnly: boolean): boolean {
  // UNVERIFIED (#5): v1 timeCards documents no `voided` field (only v2 details have one).
  // Treat a row as voided only when `voided === true` is present; confirm on the live check whether v1 already omits voided entries.
  if (row.voided === true) return false;
  const status = lower(row.status);
  if (approvedOnly) return status === "approved" || status === "exported";
  return status !== "rejected";
}

export function buildLaborReport(rows: Rec[], equipment: Rec[], o: ReportOptions): LaborReport {
  const { start, end } = resolveRange(o);
  const approvedOnly = o.approved_only ?? false;
  const byId = new Map<string, Rec>();
  for (const e of equipment) if (typeof e.id === "string") byId.set(lower(e.id), e);

  const units = new Map<string, { code: string; description: string; h: Acc }>();
  const shop = acc(), job = acc(), all = acc();
  for (const row of rows) {
    const day = String(row.timeCardDate ?? "").slice(0, 10);
    if (day < start || day > end) continue;
    if (!counted(row, approvedOnly)) continue;
    add(all, row);
    const type = lower(row.workType);
    if (type === "shop") { add(shop, row); continue; }
    if (type === "job") { add(job, row); continue; }
    // Equipment (or an unrecognised work type): Unit Time, joined on time card equipmentId (uuid) = equipment id (uuid).
    const eqId = lower(row.equipmentId);
    const eq = eqId ? byId.get(eqId) : undefined;
    const key = eq ? "eq:" + eqId : eqId ? "unknown:" + eqId : "none";
    let u = units.get(key);
    if (!u) {
      u = eq
        ? { code: normCode(eq.code) || normCode(eq.accountingCode) || eqId, description: normCode(eq.description), h: acc() }
        : eqId
          ? { code: normCode(row.equipmentAccountingCode) || `(unknown ${eqId})`, description: "Equipment record not found in E360", h: acc() }
          : { code: "(no unit)", description: "Unit Time with no equipment on the time card", h: acc() };
      units.set(key, u);
    }
    add(u.h, row);
  }

  const unitRows: UnitRow[] = [...units.values()]
    .map((u) => ({ code: u.code, description: u.description, ...out(u.h) }))
    .sort((a, b) => b.total - a.total || codeCompare(a.code, b.code));

  return {
    start, end, approved_only: approvedOnly, scope: o.partial ? "partial" : "full",
    units: unitRows, shop_time: out(shop), job_time: out(job), grand_total: out(all),
  };
}
