import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultBusinessUnit, realUnits } from "../src/business_units.ts";

// Shape from the E360 OpenAPI example for GET /api/v1/businessUnits.
const houston = { id: "b31f57c2-9861-4acf-816e-7faab246cfd5", code: "Houston Central", description: "There's no place like home." };
const pasadena = { id: "5b36ddb7-e570-45eb-aad4-aa4ad21ddbc4", code: "Pasadena Shop", description: "Repairs, rentals, and sublets." };
const placeholder = { id: "00000000-0000-0000-0000-000000000000", code: "", description: null };

test("single real business unit is auto-selected, ignoring placeholders and duplicates", () => {
  const dup = { ...houston, id: "11111111-2222-3333-4444-555555555555", code: " houston central " };
  assert.equal(defaultBusinessUnit([placeholder, houston, dup]), houston.id);
});

test("several real business units -> error listing their codes", () => {
  assert.throws(() => defaultBusinessUnit([houston, pasadena]), /2 real units exist \(Houston Central, Pasadena Shop\)/);
});

test("no real business units -> error", () => {
  assert.throws(() => defaultBusinessUnit([placeholder]), /0 real units exist/);
});

test("realUnits drops all-zero ids and units with no code", () => {
  assert.deepEqual(realUnits([placeholder, { id: "abc", code: "" }, pasadena]), [pasadena]);
});
