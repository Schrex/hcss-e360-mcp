import { closeMatches } from "./close_matches.js";
import { codeCompare, codeEq, normCode } from "./hcss.js";

/**
 * Mechanic Time per Unit report. Pure: no HCSS calls, no clock ("today" is passed in).
 * Input rows are raw GET /api/v1/timeCards rows (one per card detail line) and GET /api/v1/equipment records.
 */

/** The fields read from one GET /api/v1/timeCards row (one time card detail line). */
export type TimeCardRow = {
  timeCardDate?: string | null;
  status?: string | null;
  mechanicCode?: string | null;
  workOrderNumber?: number | string | null;
  workType?: string | null;
  equipmentId?: string | null;
  equipmentAccountingCode?: string | null;
  hours?: number | null;
  overtime?: number | null;
  doubleTime?: number | null;
  voided?: boolean | null;
};
/** The fields read from one GET /api/v1/equipment record. */
export type EquipmentRecord = { id?: string | null; code?: string | null; description?: string | null; accountingCode?: string | null };

export const MAX_CHAT_DAYS = 92;

export type Hours = { regular: number; overtime: number; double_time: number; total: number };
export type MechanicRow = { mechanic_code: string } & Hours;
export type WorkOrderRow = { work_order: string } & Hours;
/** One time card detail line on a Unit. */
export type EntryRow = { date: string; mechanic_code: string; work_order: string; status: string } & Hours;
/** One Counted Time entry for the xlsx detail sheet; `unit` is blank for Shop/Job/Other Time. */
export type DetailRow = { date: string; unit: string; mechanic_code: string; work_order: string; work_type: string; status: string } & Hours;
/** One Unit's line, broken down by mechanic code and by work order; `entries` only when one Unit was requested. */
export type UnitRow = { code: string; description: string } & Hours & {
  mechanics: MechanicRow[];
  work_orders: WorkOrderRow[];
  entries?: EntryRow[];
};
/** Time whose work type is none of Equipment, Shop or Job, with the distinct work types seen. */
export type OtherTime = { work_types: string[] } & Hours;
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
  other_time: OtherTime;
  grand_total: Hours;
  /** Every Counted Time entry, when `detail` was asked for. */
  detail?: DetailRow[];
};

export type DateRange = { start: string; end: string };
/** Unresolved range input; see resolveRange. */
export type RangeInput = {
  start?: string;
  end?: string;
  /** YYYY-MM-DD, the caller's current date; used for the default week. */
  today: string;
  /** Longest allowed range in days; default MAX_CHAT_DAYS. */
  maxDays?: number;
};

/** Either raw range input, or a `range` the caller already resolved with resolveRange. */
export type ReportOptions = (RangeInput | { range: DateRange }) & {
  approved_only?: boolean;
  /** Only this Unit, by equipment code (trimmed, case-insensitive); adds its daily entries. Shop/Job/Other Time is left out. */
  equipment?: string;
  /** Only this mechanic code (trimmed, case-insensitive), on every line including Shop/Job/Other Time. */
  mechanic?: string;
  /** Set when the equipment pull was capped: an unknown `equipment` code is then reported as unresolvable, not missing. */
  equipment_incomplete?: boolean;
  /** Set when a pull was capped (row limit / subrequest budget). */
  partial?: boolean;
  /** Also return every Counted Time entry (all Units, Shop, Job and Other) as `detail`. */
  detail?: boolean;
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
export function resolveRange(input: RangeInput): DateRange {
  const today = parseDate("today", input.today);
  let start = input.start === undefined ? undefined : parseDate("start", input.start);
  let end = input.end === undefined ? undefined : parseDate("end", input.end);
  if (start === undefined && end === undefined) {
    const todayMs = toMs(today);
    const sinceMonday = (new Date(todayMs).getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
    const thisMonday = todayMs - sinceMonday * DAY_MS;
    start = fromMs(thisMonday - 7 * DAY_MS);
    end = fromMs(thisMonday - DAY_MS);
  } else if (end === undefined) {
    end = today;
  } else if (start === undefined) {
    start = fromMs(toMs(end) - 6 * DAY_MS);
  }
  if (start! > end!) throw new Error(`start (${start}) is after end (${end}).`);
  const days = (toMs(end!) - toMs(start!)) / DAY_MS + 1;
  const max = input.maxDays ?? MAX_CHAT_DAYS;
  if (days > max) {
    throw new Error(`Range ${start} to ${end} is ${days} days; chat reports are limited to ${max} days. Use a shorter range, or export_equipment_labor_hours for an xlsx file.`);
  }
  return { start: start!, end: end! };
}

const lower = (v: unknown) => String(v ?? "").trim().toLowerCase();
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const round2 = (x: number) => Math.round(x * 100) / 100;

/** Work order number as shown; missing / 0 means time not on a work order. */
const workOrder = (row: TimeCardRow) => { const number = normCode(row.workOrderNumber); return number && number !== "0" ? number : "(none)"; };

/** Running (unrounded) hour sums. */
type Tally = { regular: number; overtime: number; double_time: number };
const newTally = (): Tally => ({ regular: 0, overtime: 0, double_time: 0 });
const addHours = (tally: Tally, row: TimeCardRow) => { tally.regular += num(row.hours); tally.overtime += num(row.overtime); tally.double_time += num(row.doubleTime); };
const toHours = (tally: Tally): Hours => ({
  regular: round2(tally.regular), overtime: round2(tally.overtime), double_time: round2(tally.double_time),
  total: round2(tally.regular + tally.overtime + tally.double_time),
});

/** Which report line a row's work type feeds. */
type Line = "unit" | "shop" | "job" | "other";
/** Normalised work type (lowercase, letters only) to report line; anything else is Other Time. */
const LINE_BY_WORK_TYPE: Record<string, Line> = { equipment: "unit", shop: "shop", job: "job" };
const lineFor = (workType: unknown): Line => LINE_BY_WORK_TYPE[String(workType ?? "").toLowerCase().replace(/[^a-z]/g, "")] ?? "other";

/** Counted Time filter: drops rejected cards and voided entries; approved-only keeps approved + exported. Status casing unverified, so compared case-insensitively. */
function counted(row: TimeCardRow, approvedOnly: boolean): boolean {
  // UNVERIFIED (#5): v1 timeCards documents no `voided` field (only v2 details have one).
  // Treat a row as voided only when `voided === true` is present; confirm on the live check whether v1 already omits voided entries.
  if (row.voided === true) return false;
  const status = lower(row.status);
  if (approvedOnly) return status === "approved" || status === "exported";
  return status !== "rejected";
}

/** Finds the Unit by equipment code (trimmed, case-insensitive). Every record with that code counts (e.g. a deleted duplicate). */
function resolveUnit(code: string, equipment: EquipmentRecord[], incomplete: boolean): { code: string; ids: Set<string> } {
  const ids = new Set<string>();
  let found = "";
  for (const record of equipment) {
    if (typeof record.id === "string" && codeEq(record.code, code)) { ids.add(lower(record.id)); found ||= normCode(record.code); }
  }
  if (!ids.size && incomplete) {
    throw new Error(`Equipment code "${normCode(code)}" was not found, but the equipment list was incomplete (an HCSS limit was hit), so it may still exist. Try again, or narrow the request.`);
  }
  if (!ids.size) {
    const near = closeMatches(code, equipment.map((record) => normCode(record.code)).filter(Boolean));
    throw new Error(`No equipment with code "${normCode(code)}". ${near.length ? `Close matches: ${near.join(", ")}.` : "No close matches."}`);
  }
  return { code: found, ids };
}

type UnitTally = { code: string; description: string; hours: Tally; mechanics: Map<string, { code: string; hours: Tally }>; workOrders: Map<string, Tally>; entries: EntryRow[] };

/** Code and description for a Unit line, from its equipment record or, failing that, the time card. */
function unitLabel(row: TimeCardRow, equipmentId: string, record: EquipmentRecord | undefined): { code: string; description: string } {
  if (record) return { code: normCode(record.code) || normCode(record.accountingCode) || equipmentId, description: normCode(record.description) };
  if (equipmentId) return { code: normCode(row.equipmentAccountingCode) || `(unknown ${equipmentId})`, description: "Equipment record not found in E360" };
  return { code: "(no unit)", description: "Unit Time with no equipment on the time card" };
}

export function buildLaborReport(rows: TimeCardRow[], equipment: EquipmentRecord[], options: ReportOptions): LaborReport {
  const { start, end } = "range" in options ? options.range : resolveRange(options);
  const approvedOnly = options.approved_only ?? false;
  const mechanic = normCode(options.mechanic) || undefined;
  const recordsById = new Map<string, EquipmentRecord>();
  for (const record of equipment) if (typeof record.id === "string") recordsById.set(lower(record.id), record);
  const onlyUnit = normCode(options.equipment) ? resolveUnit(options.equipment!, equipment, options.equipment_incomplete ?? false) : undefined;

  const units = new Map<string, UnitTally>();
  const lineTallies: Record<Exclude<Line, "unit">, Tally> = { shop: newTally(), job: newTally(), other: newTally() };
  const otherWorkTypes = new Map<string, string>(); // lowercased -> first spelling seen
  const grandTotal = newTally();
  const detail: DetailRow[] = [];
  const detailRow = (row: TimeCardRow, date: string, unitCode: string): DetailRow => {
    const tally = newTally();
    addHours(tally, row);
    return { date, unit: unitCode, mechanic_code: normCode(row.mechanicCode), work_order: workOrder(row), work_type: normCode(row.workType), status: normCode(row.status), ...toHours(tally) };
  };

  for (const row of rows) {
    const date = String(row.timeCardDate ?? "").slice(0, 10);
    if (date < start || date > end) continue;
    if (!counted(row, approvedOnly)) continue;
    if (mechanic !== undefined && lower(row.mechanicCode) !== mechanic.toLowerCase()) continue;
    const line = lineFor(row.workType);
    const equipmentId = lower(row.equipmentId);
    if (onlyUnit && (line !== "unit" || !onlyUnit.ids.has(equipmentId))) continue;
    addHours(grandTotal, row);

    if (line !== "unit") {
      addHours(lineTallies[line], row);
      if (line === "other") {
        const workType = normCode(row.workType) || "(blank)";
        if (!otherWorkTypes.has(workType.toLowerCase())) otherWorkTypes.set(workType.toLowerCase(), workType);
      }
      if (options.detail) detail.push(detailRow(row, date, ""));
      continue;
    }

    // Unit Time, joined on time card equipmentId (uuid) = equipment id (uuid).
    const record = equipmentId ? recordsById.get(equipmentId) : undefined;
    const unitKey = record ? "eq:" + equipmentId : equipmentId ? "unknown:" + equipmentId : "none";
    let unit = units.get(unitKey);
    if (!unit) {
      unit = { ...unitLabel(row, equipmentId, record), hours: newTally(), mechanics: new Map(), workOrders: new Map(), entries: [] };
      units.set(unitKey, unit);
    }
    addHours(unit.hours, row);
    const mechanicKey = lower(row.mechanicCode);
    let byMechanic = unit.mechanics.get(mechanicKey);
    if (!byMechanic) unit.mechanics.set(mechanicKey, (byMechanic = { code: normCode(row.mechanicCode) || "(no mechanic)", hours: newTally() }));
    addHours(byMechanic.hours, row);
    const workOrderKey = workOrder(row);
    let byWorkOrder = unit.workOrders.get(workOrderKey);
    if (!byWorkOrder) unit.workOrders.set(workOrderKey, (byWorkOrder = newTally()));
    addHours(byWorkOrder, row);
    if (onlyUnit || options.detail) {
      const entry = detailRow(row, date, unit.code);
      if (options.detail) detail.push(entry);
      if (onlyUnit) {
        const { unit: _unit, work_type: _workType, ...unitEntry } = entry;
        unit.entries.push(unitEntry);
      }
    }
  }

  const unitRows: UnitRow[] = [...units.values()]
    .map((unit) => ({
      code: unit.code, description: unit.description, ...toHours(unit.hours),
      mechanics: [...unit.mechanics.values()].map((m) => ({ mechanic_code: m.code, ...toHours(m.hours) }))
        .sort((a, b) => b.total - a.total || codeCompare(a.mechanic_code, b.mechanic_code)),
      work_orders: [...unit.workOrders].map(([number, tally]) => ({ work_order: number, ...toHours(tally) }))
        .sort((a, b) => b.total - a.total || codeCompare(a.work_order, b.work_order)),
      ...(onlyUnit && {
        entries: unit.entries.sort((a, b) => a.date.localeCompare(b.date) || codeCompare(a.mechanic_code, b.mechanic_code) || codeCompare(a.work_order, b.work_order)),
      }),
    }))
    .sort((a, b) => b.total - a.total || codeCompare(a.code, b.code));

  return {
    start, end, approved_only: approvedOnly, scope: options.partial ? "partial" : "full",
    ...(onlyUnit && { equipment: onlyUnit.code }),
    ...(mechanic !== undefined && { mechanic }),
    units: unitRows,
    shop_time: toHours(lineTallies.shop),
    job_time: toHours(lineTallies.job),
    other_time: { work_types: [...otherWorkTypes.values()].sort(codeCompare), ...toHours(lineTallies.other) },
    grand_total: toHours(grandTotal),
    ...(options.detail && {
      detail: detail.sort((a, b) => a.date.localeCompare(b.date) || codeCompare(a.unit, b.unit) || codeCompare(a.work_type, b.work_type) || codeCompare(a.mechanic_code, b.mechanic_code) || codeCompare(a.work_order, b.work_order)),
    }),
  };
}
