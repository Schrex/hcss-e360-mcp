import { codeCompare, codeEq, normCode } from "./hcss.js";

/**
 * Mechanic Time per Unit report. Pure: no HCSS calls, no clock ("today" is passed in).
 * Input rows are raw GET /api/v1/timeCards rows (one per card detail line) and GET /api/v1/equipment records.
 */

type Rec = Record<string, unknown>;

export const MAX_CHAT_DAYS = 92;

export type Hours = { regular: number; overtime: number; double_time: number; total: number };
export type MechanicRow = { mechanic_code: string } & Hours;
export type WorkOrderRow = { work_order: string } & Hours;
/** One time card detail line on a Unit. */
export type EntryRow = { date: string; mechanic_code: string; work_order: string; status: string } & Hours;
/** One Unit's line, broken down by mechanic code and by work order; `entries` only when one Unit was requested. */
export type UnitRow = { code: string; description: string } & Hours & {
  mechanics: MechanicRow[];
  work_orders: WorkOrderRow[];
  entries?: EntryRow[];
};
export type LaborReport = {
  start: string;
  end: string;
  approved_only: boolean;
  scope: "full" | "partial";
  /** Requested Unit's equipment code, when set. */
  equipment?: string;
  /** Mechanic code filter as given (trimmed), when set. */
  mechanic?: string;
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
  /** Only this Unit, by equipment code (trimmed, case-insensitive); adds its daily entries. Shop/Job Time is left out. */
  equipment?: string;
  /** Only this mechanic code (trimmed, case-insensitive), on every line including Shop/Job Time. */
  mechanic?: string;
  /** Set when the time card pull was capped (row limit / subrequest budget). */
  partial?: boolean;
  /** Longest allowed range in days; default MAX_CHAT_DAYS. */
  maxDays?: number;
};

const DAY_MS = 86_400_000;
const toMs = (d: string) => Date.parse(d + "T00:00:00Z");
const fromMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Schreiber's local (US Central) calendar date for an instant, as YYYY-MM-DD; this is "today" for the default week. */
const centralFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" });
export const centralDate = (now: Date): string => centralFmt.format(now);

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

/** Work order number as shown; missing / 0 means time not on a work order. */
const workOrder = (row: Rec) => { const w = normCode(row.workOrderNumber); return w && w !== "0" ? w : "(none)"; };

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

/** Finds the Unit by equipment code (trimmed, case-insensitive). Every record with that code counts (e.g. a deleted duplicate). */
function resolveUnit(code: string, equipment: Rec[]): { code: string; ids: Set<string> } {
  const ids = new Set<string>();
  let found = "";
  for (const e of equipment) {
    if (typeof e.id === "string" && codeEq(e.code, code)) { ids.add(lower(e.id)); found ||= normCode(e.code); }
  }
  if (!ids.size) {
    const near = closeMatches(code, equipment.map((e) => normCode(e.code)).filter(Boolean));
    throw new Error(`No equipment with code "${normCode(code)}". ${near.length ? `Close matches: ${near.join(", ")}.` : "No close matches."}`);
  }
  return { code: found, ids };
}

const MAX_MATCHES = 5;
/** Lowercase, letters and digits only, so "dz101", "DZ-101" and "dz 101" compare equal. */
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Codes within 2 edits of the query (ignoring case and punctuation), or containing it (3+ chars); closest first, then natural order. */
function closeMatches(query: string, codes: string[]): string[] {
  const q = squash(query);
  const scored = new Map<string, number>();
  for (const c of codes) {
    const s = squash(c);
    const d = editDistance(q, s);
    if ((d <= 2 || (q.length >= 3 && s.includes(q))) && !scored.has(c)) scored.set(c, d);
  }
  return [...scored].sort((a, b) => a[1] - b[1] || codeCompare(a[0], b[0])).slice(0, MAX_MATCHES).map(([c]) => c);
}

/** Levenshtein distance. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

export function buildLaborReport(rows: Rec[], equipment: Rec[], o: ReportOptions): LaborReport {
  const { start, end } = resolveRange(o);
  const approvedOnly = o.approved_only ?? false;
  const mechanic = normCode(o.mechanic) || undefined;
  const byId = new Map<string, Rec>();
  for (const e of equipment) if (typeof e.id === "string") byId.set(lower(e.id), e);
  const unit = normCode(o.equipment) ? resolveUnit(o.equipment!, equipment) : undefined;

  type Unit = { code: string; description: string; h: Acc; mech: Map<string, { code: string; h: Acc }>; wo: Map<string, Acc>; entries: EntryRow[] };
  const units = new Map<string, Unit>();
  const shop = acc(), job = acc(), all = acc();
  for (const row of rows) {
    const day = String(row.timeCardDate ?? "").slice(0, 10);
    if (day < start || day > end) continue;
    if (!counted(row, approvedOnly)) continue;
    if (mechanic !== undefined && lower(row.mechanicCode) !== mechanic.toLowerCase()) continue;
    const type = lower(row.workType);
    const eqId = lower(row.equipmentId);
    if (unit && (type === "shop" || type === "job" || !unit.ids.has(eqId))) continue;
    add(all, row);
    if (type === "shop") { add(shop, row); continue; }
    if (type === "job") { add(job, row); continue; }
    // Equipment (or an unrecognised work type): Unit Time, joined on time card equipmentId (uuid) = equipment id (uuid).
    const eq = eqId ? byId.get(eqId) : undefined;
    const key = eq ? "eq:" + eqId : eqId ? "unknown:" + eqId : "none";
    let u = units.get(key);
    if (!u) {
      const id = eq
        ? { code: normCode(eq.code) || normCode(eq.accountingCode) || eqId, description: normCode(eq.description) }
        : eqId
          ? { code: normCode(row.equipmentAccountingCode) || `(unknown ${eqId})`, description: "Equipment record not found in E360" }
          : { code: "(no unit)", description: "Unit Time with no equipment on the time card" };
      u = { ...id, h: acc(), mech: new Map(), wo: new Map(), entries: [] };
      units.set(key, u);
    }
    add(u.h, row);
    const mk = lower(row.mechanicCode);
    let m = u.mech.get(mk);
    if (!m) u.mech.set(mk, (m = { code: normCode(row.mechanicCode) || "(no mechanic)", h: acc() }));
    add(m.h, row);
    const wk = workOrder(row);
    let w = u.wo.get(wk);
    if (!w) u.wo.set(wk, (w = acc()));
    add(w, row);
    if (unit) {
      const h = acc();
      add(h, row);
      u.entries.push({ date: day, mechanic_code: normCode(row.mechanicCode), work_order: wk, status: normCode(row.status), ...out(h) });
    }
  }

  const unitRows: UnitRow[] = [...units.values()]
    .map((u) => ({
      code: u.code, description: u.description, ...out(u.h),
      mechanics: [...u.mech.values()].map((m) => ({ mechanic_code: m.code, ...out(m.h) }))
        .sort((a, b) => b.total - a.total || codeCompare(a.mechanic_code, b.mechanic_code)),
      work_orders: [...u.wo].map(([k, h]) => ({ work_order: k, ...out(h) }))
        .sort((a, b) => b.total - a.total || codeCompare(a.work_order, b.work_order)),
      ...(unit && {
        entries: u.entries.sort((a, b) => a.date.localeCompare(b.date) || codeCompare(a.mechanic_code, b.mechanic_code) || codeCompare(a.work_order, b.work_order)),
      }),
    }))
    .sort((a, b) => b.total - a.total || codeCompare(a.code, b.code));

  return {
    start, end, approved_only: approvedOnly, scope: o.partial ? "partial" : "full",
    ...(unit && { equipment: unit.code }),
    ...(mechanic !== undefined && { mechanic }),
    units: unitRows, shop_time: out(shop), job_time: out(job), grand_total: out(all),
  };
}
