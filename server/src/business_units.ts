import { normCode } from "./hcss.js";

type Rec = Record<string, unknown>;

/** Drop placeholder units (all-zero GUID / no code) and dedupe by code (trimmed, case-insensitive). Same rule as HeavyJob. */
export function realUnits(rows: Rec[]): Rec[] {
  const seen = new Map<string, Rec>();
  for (const u of rows) {
    const id = String(u.id ?? "");
    const code = normCode(u.code).toUpperCase();
    if (!id || /^[0-]+$/.test(id) || !code) continue;
    if (!seen.has(code)) seen.set(code, u);
  }
  return [...seen.values()];
}

/** The id of the only real business unit; throws listing the codes when there is not exactly one. */
export function defaultBusinessUnit(rows: Rec[]): string {
  const units = realUnits(rows);
  if (units.length === 1 && typeof units[0].id === "string") return units[0].id;
  throw new Error(`No default business unit (HCSS_BUSINESS_UNIT_ID unset) and ${units.length} real units exist (${units.map((u) => normCode(u.code)).join(", ")}). Call list_business_units and pass business_unit_id.`);
}
