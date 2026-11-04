# E360 connector for Claude: setup guide

Adds a "Schreiber E360" connector. It only **reads** E360 time cards and equipment, to report Mechanic Time per Unit. Only emails in `ALLOWED_USER_EMAIL` can sign in. If the Team Owner adds it org-wide, others see it but can't sign in.

## Part 1: administrator, one time (Mac Terminal, Node 23.6+)

Before you start: ask an HCSS admin to enable `e360:read` and `e360:timecards:read` on the **existing HeavyJob API client** (no write scopes). Pick a new random password of 20+ characters for the connector and give it to users privately. Do not reuse the HeavyJob connector password.

Run these one at a time from the repo's `server/` folder:

1. `npm install`
2. `npx wrangler kv namespace create EXPORTS` → paste the printed id into `wrangler.toml` under `binding = "EXPORTS"` (replace `00000000000000000000000000000001`)
3. `npx wrangler kv namespace create OAUTH_KV` → paste the id under `binding = "OAUTH_KV"` (replace `00000000000000000000000000000002`)
4. `npx wrangler secret put HCSS_CLIENT_ID` (same value as the HeavyJob connector)
5. `npx wrangler secret put HCSS_CLIENT_SECRET` (same value as the HeavyJob connector)
6. `npx wrangler secret put ALLOWED_USER_EMAIL` (the same 6 emails as HeavyJob, comma-separated)
7. Set the password hash. It asks for the password (hidden) and stores only the hash:
   `python3 -c 'import hashlib,os,base64,getpass;s=os.urandom(16);p=getpass.getpass("Connector password: ");print("pbkdf2$30000$"+base64.b64encode(s).decode()+"$"+base64.b64encode(hashlib.pbkdf2_hmac("sha256",p.encode(),s,30000)).decode())' | npx wrangler secret put ACCESS_PASSWORD_HASH`
8. `openssl rand -hex 16 | npx wrangler secret put TOKEN_EPOCH`
9. `npx wrangler deploy`
10. Check: open `https://schrex-hcss-e360-mcp.schrex.workers.dev/healthz` → `ok`

The connector URL is `https://schrex-hcss-e360-mcp.schrex.workers.dev/mcp`. If your workers.dev subdomain isn't `schrex`, change `PUBLIC_ORIGIN` in `wrangler.toml` before deploying.

## Part 2: add the connector in Claude

Settings → Connectors → **Add custom connector**. Name `Schreiber E360`, URL above. Leave the OAuth Client ID/Secret fields empty. Save. (If only the Team Owner can add custom connectors, the Owner adds it.)

## Part 3: each allowed user signs in (once every 90 days)

1. Settings → Connectors → Schreiber E360 → **Connect**.
2. Enter your email and the connector password → **Sign in and allow**.
3. Switch the connector on in a chat and ask, e.g. "How many mechanic hours went into each unit last week?"

Five wrong passwords lock sign-in from that network for 15 minutes.

## Part 4: live check (first deploy)

Ask in Claude, then record the answers in `docs/spec-v1.md` (Further Notes):

- "Mechanic hours per unit last week": confirms the time card scope works. A scope error names the missing scope.
- What real mechanic codes look like (decide whether names are needed).
- Whether any Other Time line appears, and which work types it lists.
- Pick one Unit, ask for its detail, and compare hours and dates against E360. This shows whether dates filter on card date or entry date, and whether voided entries were excluded.
- Have someone not on the allowlist try to sign in: they must be refused.

## Admin tasks

- **Sign everyone out:** `openssl rand -hex 16 | npx wrangler secret put TOKEN_EPOCH`
- **Change the password:** rerun step 7 (existing sign-ins last until you also rotate TOKEN_EPOCH).
- **Add/remove a user:** rerun step 6 with the new list (a removed user is blocked at their next request).
- Logs (Cloudflare dashboard → Workers → schrex-hcss-e360-mcp → Logs) show who called which tool, never the data.

## Good to know

- Dates are `YYYY-MM-DD`. Units are given by equipment code (e.g. `305`).
- HCSS allows the company 100 calls/min, shared with the nightly sync and the HeavyBid/HeavyJob connectors.
- A report marked partial hit a limit: use a shorter range, or the export.
