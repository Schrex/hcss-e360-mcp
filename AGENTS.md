# AGENTS.md

Read-only remote MCP connector for HCSS Equipment 360 (E360) on Cloudflare Workers, Schreiber Excavating. Reports Mechanic Time per Unit from E360 time cards. Spec: `docs/spec-v1.md`. Pattern, stack and auth layer mirror `../hcss-heavyjob-mcp`.

## Git

- Never add `Co-Authored-By: Claude` (or any Claude/Anthropic attribution) to commit messages or PR descriptions.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on Schrex/hcss-e360-mcp (via `gh`). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
