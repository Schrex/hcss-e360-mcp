import { test } from "node:test";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";
import { toXlsx } from "../src/xlsx.ts";

test("toXlsx writes every sheet, in order, with numbers as numbers and text escaped", () => {
  const buf = toXlsx([
    { name: "Summary", rows: [["Unit", "Total"], ["DZ-101", 10.25]], freezeHeader: true },
    { name: "Detail", rows: [["Mechanic"], ["SMITH,J <&>"]] },
    { name: "Notes", rows: [["Scope", "partial"]] },
  ]);
  const files = unzipSync(buf);
  const wb = strFromU8(files["xl/workbook.xml"]);
  assert.deepEqual([...wb.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]), ["Summary", "Detail", "Notes"]);
  const ct = strFromU8(files["[Content_Types].xml"]);
  for (const i of [1, 2, 3]) {
    assert.ok(files[`xl/worksheets/sheet${i}.xml`], `sheet${i}.xml`);
    assert.match(ct, new RegExp(`/xl/worksheets/sheet${i}.xml`));
  }
  assert.match(strFromU8(files["xl/worksheets/sheet1.xml"]), /<c r="B2"><v>10.25<\/v><\/c>/);
  assert.match(strFromU8(files["xl/worksheets/sheet1.xml"]), /state="frozen"/);
  assert.match(strFromU8(files["xl/worksheets/sheet2.xml"]), /SMITH,J &lt;&amp;&gt;/);
});
