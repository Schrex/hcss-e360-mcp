import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLaborReport, centralDate } from "../src/labor_report.ts";

// Equipment shaped like the E360 OpenAPI example for GET /api/v1/equipment.
const dz101 = { id: "712b78b5-b10e-4df9-a6ee-1747754abb7b", equipmentId: 13, code: "DZ-101", description: "The big yellow one.", accountingCode: "HOLYMOLY", status: "Available", enabled: "Y" };
const dz102 = { id: "e71683d7-44e7-41ec-9876-faff956c1ebc", equipmentId: 14, code: "DZ-102 ", description: "The small yellow one" };
const equipment = [dz101, dz102];

// Time card rows shaped like GET /api/v1/timeCards ApiTimeCardRead (one row per card detail line).
let n = 0;
const row = (o: Record<string, unknown>) => ({
  id: `6f0c5b1e-1111-4a3c-9a8e-${String(++n).padStart(12, "0")}`,
  timeCardDate: "2026-10-27T00:00:00", status: "Approved", mechanicCode: "SMITH,J", workOrderNumber: 1042,
  workType: "Equipment", equipmentId: dz101.id, equipmentAccountingCode: "HOLYMOLY",
  damage: false, onSite: false, hours: 0, overtime: 0, doubleTime: 0, ...o,
});
/** A Unit line without its breakdowns. */
const totals = ({ mechanics: _m, work_orders: _w, entries: _e, ...rest }: Record<string, unknown>) => rest;
const opts = { start: "2026-10-26", end: "2026-11-01", today: "2026-11-04" };

test("Unit Time is totalled per Unit with regular, overtime, double-time and total", () => {
  const r = buildLaborReport([
    row({ hours: 6.5, overtime: 1, doubleTime: 0 }),
    row({ hours: 2, overtime: 0.5, doubleTime: 0.25, mechanicCode: "LUPIN,R" }),
  ], equipment, opts);
  assert.deepEqual(r.units.map(totals), [{ code: "DZ-101", description: "The big yellow one.", regular: 8.5, overtime: 1.5, double_time: 0.25, total: 10.25 }]);
});

test("Units sort by total desc, then natural code order; codes are trimmed", () => {
  const e = (id: string, code: string) => ({ id, equipmentId: 1, code, description: "" });
  const eq = [dz101, dz102, e("a0000000-0000-0000-0000-000000000010", "UNIT-10"), e("a0000000-0000-0000-0000-000000000009", "UNIT-9")];
  const r = buildLaborReport([
    row({ equipmentId: dz101.id, hours: 1 }),
    row({ equipmentId: dz102.id, hours: 5 }),
    row({ equipmentId: "a0000000-0000-0000-0000-000000000010", hours: 2 }),
    row({ equipmentId: "a0000000-0000-0000-0000-000000000009", hours: 2 }),
  ], eq, opts);
  assert.deepEqual(r.units.map((u) => [u.code, u.total]), [["DZ-102", 5], ["UNIT-9", 2], ["UNIT-10", 2], ["DZ-101", 1]]);
});

test("hours are rounded to 2 dp after summing", () => {
  const r = buildLaborReport([row({ hours: 0.1 }), row({ hours: 0.2 }), row({ overtime: 1 / 3 })], equipment, opts);
  assert.deepEqual(totals(r.units[0]), { code: "DZ-101", description: "The big yellow one.", regular: 0.3, overtime: 0.33, double_time: 0, total: 0.63 });
});

test("Shop Time and Job Time are separate lines; grand total matches all Counted Time", () => {
  const r = buildLaborReport([
    row({ hours: 4 }),
    row({ workType: "Shop", equipmentId: null, workOrderNumber: 0, hours: 1.5 }),
    row({ workType: "JOB", equipmentId: null, workOrderJobId: "c0000000-0000-0000-0000-000000000001", hours: 2, overtime: 1 }),
  ], equipment, opts);
  assert.deepEqual(r.units.map((u) => u.code), ["DZ-101"]);
  assert.deepEqual(r.shop_time, { regular: 1.5, overtime: 0, double_time: 0, total: 1.5 });
  assert.deepEqual(r.job_time, { regular: 2, overtime: 1, double_time: 0, total: 3 });
  assert.deepEqual(r.grand_total, { regular: 7.5, overtime: 1, double_time: 0, total: 8.5 });
});

test("Unit Time for an equipment id missing from the equipment list still counts, labelled as not found", () => {
  const r = buildLaborReport([row({ equipmentId: "deadbeef-0000-0000-0000-000000000000", equipmentAccountingCode: null, hours: 3 })], equipment, opts);
  assert.equal(r.units[0].code, "(unknown deadbeef-0000-0000-0000-000000000000)");
  assert.equal(r.grand_total.total, 3);
});

test("Counted Time excludes rejected cards (any casing) and voided entries", () => {
  const r = buildLaborReport([
    row({ hours: 1, status: "Entered" }),
    row({ hours: 2, status: "review" }),
    row({ hours: 4, status: "Rejected" }),
    row({ hours: 8, status: "REJECTED" }),
    row({ hours: 16, voided: true }),
    row({ hours: 32, status: "Exported", voided: false }),
  ], equipment, opts);
  assert.equal(r.grand_total.total, 35);
  assert.equal(r.approved_only, false);
});

test("approved_only keeps only approved and exported cards", () => {
  const r = buildLaborReport([
    row({ hours: 1, status: "Approved" }),
    row({ hours: 2, status: "exported" }),
    row({ hours: 4, status: "Entered" }),
    row({ hours: 8, status: "Review" }),
    row({ hours: 16, status: "None" }),
  ], equipment, { ...opts, approved_only: true });
  assert.equal(r.grand_total.total, 3);
  assert.equal(r.approved_only, true);
});

test("rows dated outside the range are ignored", () => {
  const r = buildLaborReport([
    row({ timeCardDate: "2026-10-25T00:00:00", hours: 1 }),
    row({ timeCardDate: "2026-10-26T00:00:00", hours: 2 }),
    row({ timeCardDate: "2026-11-01T23:00:00", hours: 4 }),
    row({ timeCardDate: "2026-11-02T00:00:00", hours: 8 }),
  ], equipment, opts);
  assert.equal(r.grand_total.total, 6);
});

test("no dates -> last full Mon-Sun week before today", () => {
  const week = (today: string) => { const r = buildLaborReport([], [], { today }); return [r.start, r.end]; };
  assert.deepEqual(week("2026-11-04"), ["2026-10-26", "2026-11-01"]); // Wednesday
  assert.deepEqual(week("2026-11-02"), ["2026-10-26", "2026-11-01"]); // Monday
  assert.deepEqual(week("2026-11-01"), ["2026-10-19", "2026-10-25"]); // Sunday: current week not finished
});

test("only start -> through today; only end -> the 7 days ending on end", () => {
  const r1 = buildLaborReport([], [], { start: "2026-10-01", today: "2026-11-04" });
  assert.deepEqual([r1.start, r1.end], ["2026-10-01", "2026-11-04"]);
  const r2 = buildLaborReport([], [], { end: "2026-10-31", today: "2026-11-04" });
  assert.deepEqual([r2.start, r2.end], ["2026-10-25", "2026-10-31"]);
});

test("dates must be strict, real YYYY-MM-DD; the error names the field", () => {
  assert.throws(() => buildLaborReport([], [], { start: "2026-1-5", end: "2026-01-10", today: "2026-11-04" }), /Invalid start "2026-1-5"/);
  assert.throws(() => buildLaborReport([], [], { start: "2026-01-01", end: "2026-02-30", today: "2026-11-04" }), /Invalid end "2026-02-30"/);
  assert.throws(() => buildLaborReport([], [], { start: "10/27/2026", end: "2026-11-01", today: "2026-11-04" }), /Invalid start/);
});

test("start after end is refused", () => {
  assert.throws(() => buildLaborReport([], [], { start: "2026-11-02", end: "2026-11-01", today: "2026-11-04" }), /start \(2026-11-02\) is after end \(2026-11-01\)/);
});

test("ranges over 92 days are refused with a pointer to the export; 92 days is allowed", () => {
  const ok = buildLaborReport([], [], { start: "2026-08-01", end: "2026-10-31", today: "2026-11-04" });
  assert.equal(ok.end, "2026-10-31");
  assert.throws(() => buildLaborReport([], [], { start: "2026-07-31", end: "2026-10-31", today: "2026-11-04" }), /93 days.*export_equipment_labor_hours/);
});

test("scope is partial when the pull was capped", () => {
  assert.equal(buildLaborReport([], [], opts).scope, "full");
  assert.equal(buildLaborReport([], [], { ...opts, partial: true }).scope, "partial");
});

test("each Unit is broken down by mechanic code and by work order, most hours first", () => {
  const r = buildLaborReport([
    row({ hours: 2, mechanicCode: "SMITH,J", workOrderNumber: 1042 }),
    row({ hours: 1, overtime: 1, mechanicCode: "LUPIN,R", workOrderNumber: 1043 }),
    row({ hours: 3, mechanicCode: " lupin,r ", workOrderNumber: 1043 }),
    row({ hours: 0.5, mechanicCode: "SMITH,J", workOrderNumber: null }),
  ], equipment, opts);
  assert.deepEqual(r.units[0].mechanics, [
    { mechanic_code: "LUPIN,R", regular: 4, overtime: 1, double_time: 0, total: 5 },
    { mechanic_code: "SMITH,J", regular: 2.5, overtime: 0, double_time: 0, total: 2.5 },
  ]);
  assert.deepEqual(r.units[0].work_orders, [
    { work_order: "1043", regular: 4, overtime: 1, double_time: 0, total: 5 },
    { work_order: "1042", regular: 2, overtime: 0, double_time: 0, total: 2 },
    { work_order: "(none)", regular: 0.5, overtime: 0, double_time: 0, total: 0.5 },
  ]);
  assert.equal(r.units[0].entries, undefined);
});

test("mechanic filter (trimmed, case-insensitive) limits every line to that mechanic code", () => {
  const r = buildLaborReport([
    row({ hours: 2, mechanicCode: "SMITH,J" }),
    row({ hours: 3, mechanicCode: "LUPIN,R" }),
    row({ equipmentId: dz102.id, hours: 4, mechanicCode: "LUPIN,R" }),
    row({ workType: "Shop", equipmentId: null, hours: 1, mechanicCode: "SMITH,J" }),
    row({ workType: "Shop", equipmentId: null, hours: 8, mechanicCode: "LUPIN,R" }),
  ], equipment, { ...opts, mechanic: " smith,j " });
  assert.deepEqual(r.units.map((u) => [u.code, u.total]), [["DZ-101", 2]]);
  assert.deepEqual(r.units[0].mechanics.map((m) => m.mechanic_code), ["SMITH,J"]);
  assert.equal(r.shop_time.total, 1);
  assert.equal(r.grand_total.total, 3);
  assert.equal(r.mechanic, "smith,j");
});

test("equipment filter (trimmed, case-insensitive) returns only that Unit, with its daily entries in date order", () => {
  const r = buildLaborReport([
    row({ equipmentId: dz102.id, timeCardDate: "2026-10-28T00:00:00", hours: 3, mechanicCode: "LUPIN,R", workOrderNumber: 1043, status: "Entered" }),
    row({ equipmentId: dz102.id, timeCardDate: "2026-10-27T00:00:00", hours: 1, overtime: 0.5, mechanicCode: "SMITH,J", workOrderNumber: 0 }),
    row({ equipmentId: dz102.id, timeCardDate: "2026-10-27T00:00:00", hours: 9, status: "Rejected" }),
    row({ equipmentId: dz101.id, hours: 5 }),
    row({ workType: "Shop", equipmentId: null, hours: 2 }),
  ], equipment, { ...opts, equipment: " dz-102" });
  assert.equal(r.equipment, "DZ-102");
  assert.deepEqual(r.units.map((u) => [u.code, u.total]), [["DZ-102", 4.5]]);
  assert.deepEqual(r.units[0].entries, [
    { date: "2026-10-27", mechanic_code: "SMITH,J", work_order: "(none)", status: "Approved", regular: 1, overtime: 0.5, double_time: 0, total: 1.5 },
    { date: "2026-10-28", mechanic_code: "LUPIN,R", work_order: "1043", status: "Entered", regular: 3, overtime: 0, double_time: 0, total: 3 },
  ]);
  // Shop/Job Time is not Unit Time, so a one-Unit report leaves them out of every total.
  assert.equal(r.shop_time.total, 0);
  assert.equal(r.grand_total.total, 4.5);
});

test("unknown equipment code is an error listing close matches (within 2 edits ignoring case/punctuation, or containing it), closest first", () => {
  const e = (id: string, code: string) => ({ id, equipmentId: 1, code, description: "" });
  const eq = [dz101, dz102, e("a0000000-0000-0000-0000-000000000305", "305"), e("a0000000-0000-0000-0000-000000003051", "305-OLD-TRUCK"), e("a0000000-0000-0000-0000-000000000999", "LOADER-9")];
  const msg = (code: string) => { try { buildLaborReport([], eq, { ...opts, equipment: code }); return "no error"; } catch (err) { return (err as Error).message; } };
  assert.equal(msg("XZ-102"), 'No equipment with code "XZ-102". Close matches: DZ-102, DZ-101.');
  assert.equal(msg("dz101"), 'No equipment with code "dz101". Close matches: DZ-101, DZ-102.');
  assert.equal(msg(" 305a "), 'No equipment with code "305a". Close matches: 305.');
  assert.equal(msg("old truck"), 'No equipment with code "old truck". Close matches: 305-OLD-TRUCK.');
  assert.equal(msg("EXCAVATOR"), 'No equipment with code "EXCAVATOR". No close matches.');
});

test("today is the US Central date, so Sunday evening still reports the week before", () => {
  assert.equal(centralDate(new Date("2026-11-02T03:30:00Z")), "2026-11-01"); // Sun 9:30pm CST
  assert.equal(centralDate(new Date("2026-07-06T04:59:00Z")), "2026-07-05"); // Sun 11:59pm CDT
  assert.equal(centralDate(new Date("2026-07-06T05:00:00Z")), "2026-07-06"); // Mon 00:00 CDT
});

test("detail lists one row per Counted Time entry across all Units, Shop and Job, in date then Unit order", () => {
  const r = buildLaborReport([
    row({ equipmentId: dz102.id, timeCardDate: "2026-10-28T00:00:00", hours: 3, mechanicCode: "LUPIN,R", workOrderNumber: 1043, status: "Entered" }),
    row({ equipmentId: dz101.id, timeCardDate: "2026-10-28T00:00:00", hours: 1, overtime: 0.5 }),
    row({ workType: "Shop", equipmentId: null, timeCardDate: "2026-10-27T00:00:00", workOrderNumber: 0, hours: 2 }),
    row({ equipmentId: dz101.id, hours: 9, status: "Rejected" }),
    row({ equipmentId: dz101.id, timeCardDate: "2026-11-02T00:00:00", hours: 9 }),
  ], equipment, { ...opts, detail: true });
  assert.deepEqual(r.detail, [
    { date: "2026-10-27", unit: "", mechanic_code: "SMITH,J", work_order: "(none)", work_type: "Shop", status: "Approved", regular: 2, overtime: 0, double_time: 0, total: 2 },
    { date: "2026-10-28", unit: "DZ-101", mechanic_code: "SMITH,J", work_order: "1042", work_type: "Equipment", status: "Approved", regular: 1, overtime: 0.5, double_time: 0, total: 1.5 },
    { date: "2026-10-28", unit: "DZ-102", mechanic_code: "LUPIN,R", work_order: "1043", work_type: "Equipment", status: "Entered", regular: 3, overtime: 0, double_time: 0, total: 3 },
  ]);
  assert.equal(buildLaborReport([], equipment, opts).detail, undefined);
});

test("unknown equipment code with an incomplete equipment list says the list was incomplete, not that the Unit doesn't exist", () => {
  assert.throws(() => buildLaborReport([], equipment, { ...opts, equipment: "305", equipment_incomplete: true }),
    (err: Error) => /equipment list was incomplete/.test(err.message) && !/No equipment with code/.test(err.message));
  // A code that is in the partial list still works.
  const r = buildLaborReport([row({ hours: 1 })], equipment, { ...opts, equipment: "DZ-101", equipment_incomplete: true });
  assert.equal(r.units[0].total, 1);
});

test("ranges are unlimited when maxDays is Infinity (export), but dates stay strict", () => {
  const r = buildLaborReport([], [], { start: "2025-01-01", end: "2026-10-31", today: "2026-11-04", maxDays: Infinity });
  assert.deepEqual([r.start, r.end], ["2025-01-01", "2026-10-31"]);
  assert.throws(() => buildLaborReport([], [], { start: "2025-1-01", end: "2026-10-31", today: "2026-11-04", maxDays: Infinity }), /Invalid start/);
});

test("work type is matched ignoring case, spaces and punctuation; other work types go on a labelled Other Time line in the grand total", () => {
  const r = buildLaborReport([
    row({ workType: " equipment ", hours: 1 }),
    row({ workType: "SHOP", equipmentId: null, hours: 2 }),
    row({ workType: "Job.", equipmentId: null, hours: 4 }),
    row({ workType: "Travel", equipmentId: dz101.id, hours: 8 }),
    row({ workType: "PM Service", equipmentId: null, hours: 16, overtime: 1 }),
    row({ workType: "travel", equipmentId: null, hours: 0.5 }),
  ], equipment, opts);
  assert.deepEqual(r.units.map((u) => [u.code, u.total]), [["DZ-101", 1]]);
  assert.equal(r.shop_time.total, 2);
  assert.equal(r.job_time.total, 4);
  assert.deepEqual(r.other_time, { work_types: ["PM Service", "Travel"], regular: 24.5, overtime: 1, double_time: 0, total: 25.5 });
  assert.equal(r.grand_total.total, 32.5);
});

test("a one-Unit report leaves Other Time out, like Shop and Job Time", () => {
  const r = buildLaborReport([row({ hours: 1 }), row({ workType: "Travel", hours: 8 })], equipment, { ...opts, equipment: "DZ-101" });
  assert.deepEqual(r.other_time, { work_types: [], regular: 0, overtime: 0, double_time: 0, total: 0 });
  assert.equal(r.grand_total.total, 1);
});
