# MERICA Sovereign v9.0 — Code Review Notes

## Errors / Risks Found

1. **Frontend build is broken in this repository state.**
   - `vite.config.ts` expects entrypoint `react/main.tsx` and sets `root: "react"`, but there is no `react/` folder in this repo snapshot.
   - `npm run build` fails with: `Could not resolve entry module "react/main.tsx"`.

2. **Express import path likely broken for this repo layout.**
   - `civics_engine.js` imports core helpers from `./sovereign_core/sovereign_core`, but this repo contains `sovereign_core.js` at the root.
   - Unless moved externally at runtime, this will fail with module resolution errors.

3. **Express support modules are referenced but missing in repo.**
   - `civics_engine.js` imports `../db`, `../events`, and `../middleware/auth`; these files are not present in this repository snapshot.
   - This may be intentional for integration, but it means the API cannot run standalone from this repo as-is.

4. **FiveM manifest paths do not match files in this repo root.**
   - `fxmanifest.lua` expects `server/sv_sovereign/sv_sovereign_v90.lua`, `client/cl_sovereign_v90.lua`, and `html/index.html`/`html/main.js`/`html/main.css`.
   - The checked-in files currently live at root (`cl_sovereign_v90.lua`, `index.html`, `sovereign.css`) and no built `html/main.js` exists.

5. **Cannot validate Lua syntax in this environment.**
   - `luac` is not installed in the container, so Lua syntax checks were not run.

## Included Features (as implemented)

- 5-hour treasury cycle orchestration (seizures, payroll, auctions, garnishments).
- Siphon engine for guilty seizures with police/officer/burn split and audit trail.
- Audit logger with deterministic SHA-256 hash for transaction integrity.
- Fed-state configurable economic controls (rates/multipliers/caps).
- Auction system (list bids/place bids/settlement with solvency check).
- Medical billing settlement with insurance split and overdraft cap enforcement.
- Overdraft garnishment scheduler + periodic recovery waterfall.
- Evidence deposit validation based on station coordinates.
- Repo order lifecycle API (create/list/execute).
- Trophy rack listing endpoint.
- VIP item lock endpoints and permission checks.
- Mechanic work order APIs (create/complete/list) with tax routing + audit events.
- Treasury clock bootstrap/start routine.
- SQL schema for all major tables used in v9.0 (audits, fed state, seizures, auctions, medical, garnishments, repo, trophies, VIP lock, mechanic orders).

## Suggested New Features

1. **Automated health-check endpoint**
   - Add `/api/health/sovereign` that verifies DB connectivity, required tables, and treasury scheduler status.

2. **Idempotency keys on money-moving POST endpoints**
   - Prevent duplicate deductions/payouts from retries (`/medical/records`, `/auctions/:id/bid`, mechanic completion).

3. **Role-aware row-level authorization**
   - Restrict access so users can only view their own medical records/garnishments/orders unless admin/police role.

4. **Settlement dry-run mode**
   - Add simulation endpoints to preview deductions, taxes, garnishment effects before committing transactions.

5. **Dead-letter queue for failed treasury actions**
   - Store failures with retry policy and admin reprocess action for failed siphons/auction settlements.

6. **Real-time admin dashboard stream**
   - Live feed for cycle status, failed operations, abnormal balance deltas, and suspicious patterns.

7. **Config-driven station coordinates**
   - Move `STATION_COORDS` to DB or environment config to avoid redeploys for map changes.

8. **Comprehensive test harness**
   - Add integration tests with a temporary DB and deterministic fixtures for all financial flows.
