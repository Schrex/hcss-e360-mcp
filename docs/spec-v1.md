## Problem Statement

The Equipment Manager has no quick way to see how much Mechanic Time went into each Unit. The hours sit on individual E360 time cards. Answering "which units ate the most shop labor last week?" or "how many hours have mechanics put into unit 305 this month?" means opening cards one by one or building reports by hand in E360. Schreiber already uses Claude connectors for HeavyBid, HeavyJob and ClearStory, but none of them reads E360.

## Solution

Build a read-only remote MCP connector, "Schreiber E360", that Claude can call to report Mechanic Time per Unit for a date range. Hours come from E360 time cards and are split into regular, overtime and double-time. Each Unit is broken down by mechanic and by work order. Shop Time and Job Time appear as separate labelled lines so the totals match the mechanics' full time cards. The same report can be downloaded as an xlsx file. Only the 6 allowlisted Schreiber staff can sign in, with the same sign-in experience as the HeavyJob connector.

## User Stories

1. As the Equipment Manager, I want to ask Claude "how many mechanic hours went into each unit last week", so that I can see where shop labor went without opening time cards.
2. As the Equipment Manager, I want units sorted by most hours first, so that the costliest units stand out.
3. As the Equipment Manager, I want each Unit's hours split into regular, overtime and double-time, so that I can see overtime pressure per unit.
4. As the Equipment Manager, I want a total per Unit, so that I can compare units at a glance.
5. As the Equipment Manager, I want each Unit broken down by mechanic, so that I can see who worked on it.
6. As the Equipment Manager, I want each Unit broken down by work order, so that I can tie hours to specific repairs.
7. As the Equipment Manager, I want to ask about one Unit and see its daily entries, so that I can review exactly when and by whom work was done.
8. As the Equipment Manager, I want to filter by mechanic, so that I can see which units one mechanic spent time on.
9. As the Equipment Manager, I want to give a start and end date, so that I can report on any period.
10. As the Equipment Manager, I want the last full week (Mon–Sun) used when I give no dates, so that the common weekly review needs no extra input.
11. As the Equipment Manager, I want Shop Time and Job Time shown as separate labelled lines, so that the grand total matches the mechanics' time cards.
12. As the Equipment Manager, I want rejected cards and voided entries excluded by default, so that totals reflect real work.
13. As the Equipment Manager, I want an approved-only option, so that I can report on hours that are final.
14. As the Equipment Manager, I want each row to show its card status, so that I know which hours are still in review.
15. As the Equipment Manager, I want to refer to units by their equipment code (e.g. "305"), not internal IDs, so that I can ask naturally.
16. As the Equipment Manager, I want equipment codes matched loosely (trimmed, case-insensitive), so that "305 " and "305" mean the same unit.
17. As the Equipment Manager, I want a clear message with close matches when a unit code isn't found, so that I can correct typos.
18. As the Equipment Manager, I want to export the report to xlsx, so that I can share it or keep it.
19. As the Equipment Manager, I want the export link to be single-use and expire after 15 minutes, so that the file can't be passed around.
20. As the Equipment Manager, I want ranges over 92 days refused in chat with a pointer to the export, so that big pulls don't fail silently.
21. As the Equipment Manager, I want to be told when a report is partial because a limit was hit, so that I don't trust incomplete totals.
22. As the Equipment Manager, I want an invalid date to produce an error naming the bad field, so that I can fix my request.
23. As the Equipment Manager, I want a start date after the end date rejected, so that I don't get an empty report by mistake.
24. As an allowlisted staff member, I want to sign in with my email and the shared password, so that I can use the connector from Claude.
25. As an allowlisted staff member, I want to stay signed in for 90 days, so that I'm not asked to sign in constantly.
26. As a Schreiber staff member not on the allowlist, I want to be refused at sign-in even if the connector was added org-wide, so that equipment labor data stays limited.
27. As the administrator, I want to revoke every session by changing one secret, so that I can cut off access instantly.
28. As the administrator, I want to remove one email from the allowlist and have it blocked at the next request, so that offboarding is simple.
29. As the administrator, I want login attempts throttled per IP and globally, so that the shared password can't be brute-forced.
30. As the administrator, I want the connector to only accept MCP calls from Anthropic's IP range, so that a leaked URL is useless elsewhere.
31. As the administrator, I want the connector to make only GET requests to HCSS, so that it can never change E360 data.
32. As the administrator, I want it to reuse the existing HeavyJob HCSS API client credentials, so that no new HCSS client is needed.
33. As the administrator, I want a clear error naming the missing scope if HCSS refuses time card access, so that I know what to enable.
34. As the administrator, I want an audit log of who called which tool (never the data), so that I can see usage without leaking information.
35. As the administrator, I want the connector to respect HCSS's shared rate limit (retry with backoff, honour Retry-After), so that it doesn't disrupt the nightly sync or other connectors.
36. As the administrator, I want it to run on the Cloudflare Workers free plan, so that it costs nothing.
37. As the administrator, I want a setup guide covering secrets, password hashing on my own machine, and adding the connector in Claude, so that I can deploy without help.

## Implementation Decisions

- **Starting point:** copy the HeavyJob connector's server and keep its platform pieces unchanged: Worker entry, OAuth provider wiring and sign-in page, IP allowlist, config loading, HCSS token client with caching/retry/backoff, subrequest budget, xlsx writer, KV export links. Remove HeavyJob, Telematics, cron and D1 code.
- **Stack:** TypeScript on Cloudflare Workers (free plan), MCP TypeScript SDK with stateless Streamable HTTP (JSON responses, no Durable Objects), zod for tool inputs, Cloudflare's workers-oauth-provider for OAuth 2.1, fflate for xlsx.
- **Names:** Worker `schrex-hcss-e360-mcp`; MCP endpoint `https://schrex-hcss-e360-mcp.schrex.workers.dev/mcp`; connector display name "Schreiber E360".
- **Auth (Claude → connector):** identical to HeavyJob v0.2 + 90-day grant: email allowlist secret (the same 6 people as HeavyJob), shared password checked against a PBKDF2 hash secret (30,000 iterations), login throttle in KV (5 failures per IP / 20 global per 15 min), 1 h access tokens with rotating refresh, 90-day grant, `TOKEN_EPOCH` revoke-all, allowlist and epoch re-checked on every MCP request. New secret values; the password hash is generated by the administrator locally and never shared in chat or the repo.
- **Auth (connector → HCSS):** client_credentials against the HCSS identity token endpoint using the existing HeavyJob API client's ID and secret. Requested scope `e360:read e360:timecards:read`. No write scopes. A refused scope or 403 returns a fixed error naming the missing scope.
- **HCSS client guard:** GET-only. E360 documents no read-only POST endpoints, so any non-GET is refused in the client before sending. Base URL `https://api.hcssapps.com/e360`.
- **E360 endpoints used:**
  - `GET /api/v1/timeCards` (v1 chosen over v2 because each row carries `equipmentId`, `workOrderNumber`, `workType`, `hours`, `overtime`, `doubleTime`, `mechanicCode`, `status`, `timeCardDate`; v2 nests details and identifies equipment only by name/accounting code). Filters: `beginDate`, `endDate` (ISO 8601), `status`, `mechanicId`. Paging via `count` (max 1000) + integer `cursor`; response `next`.
  - `GET /api/v1/equipment` to map `equipmentId` → equipment code and description, and to resolve a user-supplied code. Paged the same way.
  - `GET /api/v1/businessUnits` to auto-select the single real business unit, same rule as HeavyJob.
- **Report module (the core, pure):** input = raw v1 time card rows, equipment list, options (date range, optional unit code, optional mechanic code, approved-only flag). Output = per-Unit rows (code, description, regular, overtime, double-time, total, sorted by total desc then natural code order), each with breakdowns by mechanic code and by work order; separate Shop Time and Job Time lines; grand totals; `scope` field (`full` or `partial`); when one Unit is requested, its daily entries. Counted Time excludes rejected cards and voided entries; approved-only keeps only approved and exported. Hours rounded to 2 dp.
- **Date handling:** strict `YYYY-MM-DD`; default is the last full Mon–Sun week relative to "today" passed in (so it's testable); start must be ≤ end; chat tool refuses ranges over 92 days and points to the export.
- **Tools:**
  - `get_equipment_labor_hours(start?, end?, equipment?, mechanic?, approved_only?)`: returns the report as compact JSON. With `equipment` set, includes that Unit's daily entries.
  - `export_equipment_labor_hours(start?, end?, equipment?, mechanic?, approved_only?)`: same report as xlsx (one sheet per-Unit summary, one sheet detail rows), stored in KV, returns a single-use 15-minute link. Allows ranges past 92 days within the subrequest budget; marks `partial` if capped.
- **Equipment code matching:** trimmed, case-insensitive, natural sort; not-found returns close matches.
- **Mechanics:** shown by `mechanicCode` only. No employee-name lookup in v1.
- **Limits:** subrequest budget 45 per request; page size 1000; 20,000-row cap per pull then `partial`; 5-minute isolate cache for equipment and business units.
- **Audit log:** `tool_call` {email, tool}, `login_ok`, `login_failed`/`login_locked` (IP only), `mcp_denied`. Never arguments or data.

## Testing Decisions

- **One seam: the pure report module.** Tests feed it time card rows and equipment records shaped like the published E360 OpenAPI examples and assert on the returned report. No HCSS calls, no Worker, no fake fetch.
- Good tests check only what the Equipment Manager would see: per-Unit totals, sort order, mechanic/work-order breakdowns, Shop/Job lines, grand totals, status filtering, voided-entry exclusion, approved-only, default week, date validation, 92-day refusal, unknown-code close matches, rounding, `partial` flag. They do not assert on internal helpers or call order.
- **Prior art:** the HeavyJob connector's telematics tests (node:test with a TypeScript transform loader, sample records taken from the HCSS OpenAPI, pure mapper/aggregation functions). Reuse its test runner setup.
- Auth, IP allowlist, HCSS client and xlsx are copied unchanged from HeavyJob and are not re-tested here. Typecheck (`tsc --noEmit`) and a `wrangler deploy --dry-run` build must pass.
- **Post-deploy manual check:** one real `get_equipment_labor_hours` call to confirm the scope works, see what real mechanic codes look like, and spot-check one Unit's hours against E360.

## Out of Scope

- Any write to E360.
- Work orders, maintenance requests, backlog, parts, inventory, fuel, purchasing and cost-dollar reports.
- Mechanic name lookup (revisit after seeing real mechanic codes).
- v2 time cards, pay adjustments and shift details.
- Operator run-time hours and telematics (already in the HeavyJob connector).
- Cron jobs, D1 database, historical snapshots.
- A new HCSS API client.

## Further Notes

- Domain terms (Mechanic Time, Unit, Unit/Shop/Job Time, Counted Time, Equipment Manager) are defined in the repo's GLOSSARY.md.
- UNVERIFIED and to confirm on the first live call:
  - whether `beginDate`/`endDate` filter on card date or entry date;
  - whether omitting `businessUnitId` returns all business units;
  - that `equipmentId` on time card rows always matches an `/api/v1/equipment` record.
- HCSS rate limit (100 req/min, 20 concurrent) is shared with the nightly sync and the HeavyBid/HeavyJob connectors.
- Deploy steps the administrator runs: create KV namespaces, set secrets (HCSS client ID/secret, allowlist, password hash, token epoch), deploy, add the connector URL in Claude with OAuth.
