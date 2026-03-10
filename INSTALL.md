# MERICA Sovereign v9.0 — Installation & Deployment Guide

## What Changed in v9.0

### Critical Bug Fixes
| ID | Bug | Fix Applied |
|----|-----|-------------|
| SV-01 | `targetNetId` undefined in police action MDT log | Read from `data.targetNetId` |
| SV-02 | `exports.qb-vehiclekeys` syntax crash (Lua parse error) | Changed to `exports['qb-vehiclekeys']` |
| SV-03 | Auction bid race condition (no transaction, double-spend possible) | In-game path now uses atomic `UPDATE ... WHERE current_bid_cents < ?` |
| SV-04 | `sovereign_seizures` table missing → treasury cycle crashed on first run | Table added to schema |
| SV-05 | Overdraft spiral — no debt cap on medical bills | `overdraft_cap_cents` in `sovereign_fed_state` (default: $50k) |
| SV-06 | Medical bill wrote two audit rows, second outside transaction | Single transactional pair of writes via `conn` |
| SV-07 | Auction bid socket event floods all clients on rapid bids | 200ms debounce per `auctionId` in `civics_engine.js` |
| SV-08 | NUI focus permanently stuck if React close handler fails | Global ESC thread in `cl_sovereign_v90.lua` |
| SV-11 | `sovereign:repo:executeOrder` NUI callback missing → execute button did nothing | Registered in client Lua + server handler |
| SV-12 | Mixed z-phone notification APIs | Standardised to `sovereign:client:notify` + `z-phone` client-side |
| SV-14 | `department_funds`, `department_staff` tables missing → payroll/siphon crashed | Both tables added to schema with seed data |
| SV-16 | No input validation on NUI callbacks → potential exploits | `str()` / `int()` sanitisers on every net event |
| SV-17 | Rapid F5 could stack multiple `focusNUI(true)` calls | `nuiOpening` debounce flag added |
| SV-19 | Auction winner could be insolvent → account goes deeply negative | Solvency check before debit in `settleAuctions` |
| SV-20 | No overdraft recovery | Waterfall garnishment system in `sovereign_core.js` + `overdraft_garnishments` table |

### New in v9.0
- **`MechanicHUD.tsx`** — Work order UI with parts list, labour, 7.5% goods tax routing to vault
- **`mechanic_work_orders`** table
- **`overdraft_garnishments`** table + `processGarnishments()` in treasury cycle
- **`/api/mechanic/orders`** REST endpoints (create + complete)
- **`/api/garnishments/:citizenId`** REST endpoint

---

## Directory Structure

```
merica_sovereign/                     ← FiveM resource root
├── fxmanifest.lua
├── package.json                      ← React build dependencies
├── vite.config.ts                    ← NUI build config
├── sql/
│   └── v90_schema.sql                ← Run once on DB
├── server/
│   ├── sovereign_core/
│   │   └── sovereign_core.js         ← 5-hr cycle, siphon, audit, garnishment
│   ├── civics_engine/
│   │   └── civics_engine.js          ← Express REST routes
│   └── sv_sovereign/
│       └── sv_sovereign_v90.lua      ← Server-side net events
├── client/
│   └── cl_sovereign_v90.lua          ← Client-side NUI bridge
├── react/
│   ├── main.tsx                      ← Vite entrypoint
│   ├── PoliceRadial/
│   │   └── PoliceRadialHUD.tsx
│   ├── MedicalTraumaHUD/
│   │   └── MedicalTraumaHUD.tsx
│   ├── RepoTablet/
│   │   └── RepoTablet.tsx
│   ├── AuctionHub/
│   │   └── AuctionHub.tsx
│   ├── TrophyRack/
│   │   └── TrophyRack.tsx
│   ├── MechanicHUD/
│   │   └── MechanicHUD.tsx           ← NEW v9.0
│   ├── FederalDashboard/
│   │   └── FederalDashboard.tsx      ← Admin panel (Next.js only, not in NUI)
│   └── shared/
│       ├── utils/format.ts
│       ├── hooks/useSocket.ts
│       └── types/
└── html/
    ├── index.html                    ← NUI page (committed)
    ├── main.js                       ← Built by Vite (gitignore or commit)
    ├── main.css                      ← Built by Vite
    └── sovereign.css                 ← Source styles
```

---

## Step 1 — Database

```bash
# Run on your FiveM MySQL database
mysql -u root -p YOUR_DB_NAME < sql/v90_schema.sql

# If upgrading from v8.8 (player_accounts may be UNSIGNED):
mysql -u root -p YOUR_DB_NAME -e \
  "ALTER TABLE player_accounts MODIFY balance_cents BIGINT NOT NULL DEFAULT 0;"
```

---

## Step 2 — Build the React NUI Bundle

```bash
cd merica_sovereign/

# Install dependencies (first time only)
npm install

# Build — outputs html/main.js and html/main.css
npm run build
```

The build must complete **before** starting the resource. The `html/` folder is
committed to git so this step only needs to run when React files change.

---

## Step 3 — Node.js Server Setup

The `sovereign_core.js` and `civics_engine.js` files run in your **Node.js
Express server** (not inside FiveM). Mount them like this:

```js
// server/app.js (your Express entry)
const { civicsRouter, bootstrapCivics } = require("./civics_engine/civics_engine");

app.use("/api", civicsRouter);

// After DB is ready:
await bootstrapCivics();
```

### Required modules
```bash
npm install express mysql2 socket.io crypto
```

### Required peer files (provide your own)
| Import | What to provide |
|--------|----------------|
| `./db` | `{ db }` — a `mysql2/promise` pool |
| `./events` | `{ emit }` — your internal event bus (Socket.io or EventEmitter) |
| `./middleware/auth` | `{ requireAdmin, requireAuth }` — JWT middleware |

---

## Step 4 — server.cfg

```cfg
# Secrets (NEVER in fxmanifest.lua)
set merica_server_secret "CHANGE_THIS_TO_A_STRONG_SECRET"

# ACE Permissions
add_ace group.admin  sovereign.admin  allow
add_ace group.police sovereign.police allow

# Ensure correct load order
ensure oxmysql
ensure qb-core
ensure ps-dispatch
ensure ps-mdt
ensure z-phone
ensure qb-vehiclekeys
ensure Murderface-Pets
ensure merica_sovereign
```

---

## Step 5 — Post-Deploy Verification

### Treasury Cycle
```js
// Node REPL or test endpoint:
const { runTreasuryCycle } = require("./sovereign_core/sovereign_core");
await runTreasuryCycle();
// Check: no errors in console, sovereign_cycle_log has a row
```

### Evidence Deposit
1. Set `EVIDENCE` cert on a test cop character
2. Confiscate an item (F5 → Confiscate)
3. Drive to one of the 4 STATION_COORDS in `sovereign_core.js`
4. Run `/depositEvidence` (or however you expose the deposit trigger)
5. Check `sv78_evidence_log` for `status = 'DEPOSITED'`

### CeeU GPS
1. Set `vehicle_metadata = '{"ceeu_active": "true"}'` on a test vehicle in `player_vehicles`
2. Open RepoTablet → GPS Ping → verify coords returned
3. Set `ceeu_active: false` → verify "No CeeU subscription" response

### Overdraft + Garnishment
1. Create a medical record with a very high bill
2. Verify `player_accounts.balance_cents` goes negative (but not below `-overdraft_cap_cents`)
3. Check `overdraft_garnishments` has a PENDING row
4. Manually trigger `runTreasuryCycle()` — verify garnishment is collected next cycle

### Auction Solvency (SV-19 fix)
1. Create an auction, have a test bidder bid more than their balance
2. Let the auction expire
3. Verify `sovereign_auctions.status = 'NO_SALE'` and reason `winner_insolvent` in metadata

---

## Verifying STATION_COORDS

The four evidence deposit stations in `sovereign_core.js` must match your
server's actual MLO positions. Edit `STATION_COORDS` if they differ:

```js
const STATION_COORDS = {
  pillbox:  { x:  457.44, y: -989.09, z:  24.92, radius: 6.0 },
  sandy:    { x: 1853.05, y: 3687.43, z:  34.27, radius: 6.0 },
  paleto:   { x: -448.17, y: 6012.18, z:  31.72, radius: 6.0 },
  vinewood: { x: -1095.8, y: -845.26, z:  19.32, radius: 6.0 },
};
```

---

## PS Event Names to Verify

| Resource | Assumed API |
|----------|-------------|
| `ps-banking` | `exports['ps-banking']:addAccountMoney(acct, amt)` |
| `ps-dispatch` | `exports['ps-dispatch']:CustomAlert(src, data)` |
| `ps-mdt` | `TriggerEvent('mdt:server:addReport', data)` |
| `ps-mdt` | `TriggerEvent('mdt:server:addEvidenceDeposit', data)` |
| `z-phone` | `exports['z-phone']:sendCustomAppNotification(title, msg, type)` |
| `qb-vehiclekeys` | `exports['qb-vehiclekeys']:getPlayerVehicles(src)` |
| `Murderface-Pets` | `exports['Murderface-Pets']:setK9Target(ped, attack)` |
| `Murderface-Pets` | `exports['Murderface-Pets']:triggerSniff(type, cb)` |

---

## Mechanic HUD Integration (v9.0)

The `MechanicHUD` is triggered by `openMechanicHUD` command on the client.
For a production setup, replace the placeholder in `cl_sovereign_v90.lua` with
an `ox_target` zone near the mechanic garage that populates `customerId` and
`vehiclePlate` from the nearest player/vehicle.

The server-side `sovereign:mechanic:createOrder` net event bridges to the
Express REST endpoint via your server's Lua→Node bridge. Ensure this bridge
is set up the same way as `sovereign:medical:settleBill`.
