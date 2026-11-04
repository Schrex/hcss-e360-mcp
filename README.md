# hcss-e360-mcp

Read-only remote MCP connector "Schreiber E360" for HCSS Equipment 360, on Cloudflare Workers (free plan) as `schrex-hcss-e360-mcp`. Reports **Mechanic Time per Unit** from E360 time cards. Spec: [docs/spec-v1.md](docs/spec-v1.md). Terms: [GLOSSARY.md](GLOSSARY.md). Setup: [setup-guide.md](setup-guide.md).

- MCP endpoint: `https://schrex-hcss-e360-mcp.schrex.workers.dev/mcp`
- HCSS access: GET only, scopes `e360:read e360:timecards:read`, the same HCSS API client as the HeavyJob connector.
- Sign-in: email allowlist + shared password, same as the HeavyJob connector. `/mcp` only accepts Anthropic's IP range.

Secrets (Cloudflare only, never committed): `HCSS_CLIENT_ID`, `HCSS_CLIENT_SECRET`, `ALLOWED_USER_EMAIL`, `ACCESS_PASSWORD_HASH`, `TOKEN_EPOCH`.

## Tools

Both take `start`, `end` (`YYYY-MM-DD`), `equipment` (Unit code, e.g. `305`), `mechanic` (mechanic code), `approved_only` (bool). All optional.

### get_equipment_labor_hours

Mechanic Time per Unit as JSON.

- No dates: the last full Mon–Sun week (US Central). Ranges over 92 days are refused; use the export.
- Per Unit: regular, overtime, double-time, total; breakdown by mechanic code and by work order. Most hours first.
- Shop Time, Job Time and Other Time (unrecognised work types) are separate lines. The grand total covers all Counted Time.
- Counted Time leaves out rejected cards and voided entries. `approved_only` keeps approved and exported cards only.
- `equipment` set: that Unit only, with its daily entries (Shop/Job/Other lines omitted). An unknown code returns close matches.
- `scope: "partial"` when the 20,000-row cap or the request budget was hit.

### export_equipment_labor_hours

Same report as an xlsx (Summary, Detail, Notes sheets). Returns a single-use download link that expires in 15 minutes. No 92-day limit; a capped pull is labelled PARTIAL.

## Development

From `server/` (Node 23.6+):

```bash
npm install
```

```bash
npm run typecheck && npm test && npm run build
```

## Unverified until the first live call

- v1 time cards document no `voided` field; only rows with `voided === true` are excluded.
- Real `workType` and `status` values and casing.
- Whether `beginDate`/`endDate` filter on card date or entry date.
- That every time card `equipmentId` matches an `/api/v1/equipment` record.
