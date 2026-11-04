import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLaborReport } from "../src/labor_report.ts";
import { laborExport } from "../src/labor_export.ts";

const dz101 = { id: "712b78b5-b10e-4df9-a6ee-1747754abb7b", code: "DZ-101", description: "The big yellow one." };
const dz102 = { id: "e71683d7-44e7-41ec-9876-faff956c1ebc", code: "DZ-102", description: "The small yellow one" };
const row = (o: Record<string, unknown>) => ({
  timeCardDate: "2026-10-27T00:00:00", status: "Approved", mechanicCode: "SMITH,J", workOrderNumber: 1042,
  workType: "Equipment", equipmentId: dz101.id, hours: 0, overtime: 0, doubleTime: 0, ...o,
});
const rows = [
  row({ hours: 6, overtime: 1 }),
  row({ equipmentId: dz102.id, timeCardDate: "2026-10-28T00:00:00", hours: 2, doubleTime: 0.5, mechanicCode: "LUPIN,R", status: "Entered" }),
  row({ workType: "Shop", equipmentId: null, workOrderNumber: 0, hours: 1.5 }),
  row({ workType: "Job", equipmentId: null, workOrderNumber: 0, hours: 3 }),
];
const opts = { start: "2026-10-26", end: "2026-11-01", today: "2026-11-04", detail: true };
const sheet = (x: ReturnType<typeof laborExport>, name: string) => x.sheets.find((s) => s.name === name)!.rows;

test("Summary sheet: per-Unit regular/OT/DT/total, then Shop, Job and grand total lines", () => {
  const x = laborExport(buildLaborReport(rows, [dz101, dz102], opts));
  assert.deepEqual(x.sheets.map((s) => s.name), ["Summary", "Detail", "Notes"]);
  assert.deepEqual(sheet(x, "Summary"), [
    ["Unit", "Description", "Regular", "Overtime", "Double time", "Total"],
    ["DZ-101", "The big yellow one.", 6, 1, 0, 7],
    ["DZ-102", "The small yellow one", 2, 0, 0.5, 2.5],
    ["Shop Time", "", 1.5, 0, 0, 1.5],
    ["Job Time", "", 3, 0, 0, 3],
    ["Grand total", "", 12.5, 1, 0.5, 14],
  ]);
  assert.equal(x.filename, "mechanic-time-per-unit_2026-10-26_2026-11-01.xlsx");
  assert.equal(x.partial, false);
});

test("Detail sheet: one row per Counted Time entry with date, Unit, mechanic, work order, work type, hours, status", () => {
  const x = laborExport(buildLaborReport(rows, [dz101, dz102], opts));
  assert.deepEqual(sheet(x, "Detail"), [
    ["Date", "Unit", "Mechanic code", "Work order", "Work type", "Regular", "Overtime", "Double time", "Total", "Status"],
    ["2026-10-27", "", "SMITH,J", "(none)", "Job", 3, 0, 0, 3, "Approved"],
    ["2026-10-27", "", "SMITH,J", "(none)", "Shop", 1.5, 0, 0, 1.5, "Approved"],
    ["2026-10-27", "DZ-101", "SMITH,J", "1042", "Equipment", 6, 1, 0, 7, "Approved"],
    ["2026-10-28", "DZ-102", "LUPIN,R", "1042", "Equipment", 2, 0, 0.5, 2.5, "Entered"],
  ]);
});

test("a partial report is labelled in both data sheets, the Notes sheet and the file name", () => {
  const x = laborExport(buildLaborReport(rows, [dz101, dz102], { ...opts, partial: true }));
  assert.equal(x.partial, true);
  assert.match(x.filename, /PARTIAL\.xlsx$/);
  for (const name of ["Summary", "Detail"]) assert.match(String(sheet(x, name).at(-1)![0]), /^PARTIAL/);
  assert.ok(sheet(x, "Notes").some((r) => r[0] === "Scope" && /partial/.test(String(r[1]))));
});

test("Notes sheet records range and filters", () => {
  const x = laborExport(buildLaborReport(rows, [dz101, dz102], { ...opts, mechanic: "smith,j", approved_only: true }));
  const notes = Object.fromEntries(sheet(x, "Notes").map((r) => [r[0], r[1]]));
  assert.equal(notes["Range"], "2026-10-26 to 2026-11-01");
  assert.equal(notes["Mechanic"], "smith,j");
  assert.equal(notes["Statuses"], "Approved and exported only");
  assert.equal(notes["Scope"], "full");
});
