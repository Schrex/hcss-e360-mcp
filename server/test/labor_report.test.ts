import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLaborReport } from "../src/labor_report.ts";

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
const opts = { start: "2026-10-26", end: "2026-11-01", today: "2026-11-04" };

test("Unit Time is totalled per Unit with regular, overtime, double-time and total", () => {
  const r = buildLaborReport([
    row({ hours: 6.5, overtime: 1, doubleTime: 0 }),
    row({ hours: 2, overtime: 0.5, doubleTime: 0.25, mechanicCode: "LUPIN,R" }),
  ], equipment, opts);
  assert.deepEqual(r.units, [{ code: "DZ-101", description: "The big yellow one.", regular: 8.5, overtime: 1.5, double_time: 0.25, total: 10.25 }]);
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
  assert.deepEqual(r.units[0], { code: "DZ-101", description: "The big yellow one.", regular: 0.3, overtime: 0.33, double_time: 0, total: 0.63 });
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
