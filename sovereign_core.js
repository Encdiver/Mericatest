// ═══════════════════════════════════════════════════════════════════════════
//  sovereign_core.js  –  MERICA Sovereign v9.0
//  5-Hour Treasury Cycle · Siphon Engine · Audit Logger · Garnishment
//
//  FIXED in v9.0:
//    [SV-04] sovereign_seizures table now exists – treasury cycle no longer crashes
//    [SV-05] Overdraft cap enforced via fed_state.overdraft_cap_cents
//    [SV-06] Duplicate audit insert removed; all writes use the open conn
//    [SV-19] Auction winner solvency check before debit
//    [SV-20] Waterfall garnishment on overdraft
// ═══════════════════════════════════════════════════════════════════════════

"use strict";

const crypto   = require("crypto");
const { db }   = require("../db");
const { emit } = require("../events");

// ── Constants ─────────────────────────────────────────────────────────────
const CYCLE_MS       = 5 * 60 * 60 * 1000;   // 5 hours
const SIPHON_POLICE  = 0.65;
const SIPHON_OFFICER = 0.05;
// Burn = remainder (30%) – not deposited anywhere, supply is destroyed

// ── Evidence deposit station coordinates (server-authoritative) ────────────
// IMPORTANT: verify these match your actual MLO/server coords.
const STATION_COORDS = {
  pillbox:  { x:  457.44, y: -989.09, z:  24.92, radius: 6.0 },
  sandy:    { x: 1853.05, y: 3687.43, z:  34.27, radius: 6.0 },
  paleto:   { x: -448.17, y: 6012.18, z:  31.72, radius: 6.0 },
  vinewood: { x: -1095.8, y: -845.26, z:  19.32, radius: 6.0 },
};

// ─────────────────────────────────────────────────────────────────────────
// ULID  (no external dependency)
// ─────────────────────────────────────────────────────────────────────────
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulid() {
  const ts    = Date.now();
  let t = "";
  let n = ts;
  for (let i = 9; i >= 0; i--) { t = ENCODING[n % 32] + t; n = Math.floor(n / 32); }
  let r = "";
  const bytes = crypto.randomBytes(10);
  for (let i = 0; i < 10; i++) r += ENCODING[bytes[i] % 32];
  return t + r;
}

// ─────────────────────────────────────────────────────────────────────────
// Audit integrity hash
// SHA-256(cycleId | eventType | actorId | targetId | amountCents | ts)
// ─────────────────────────────────────────────────────────────────────────
function txHash(cycleId, eventType, actorId, targetId, amountCents, ts) {
  const payload = [cycleId, eventType, actorId ?? "", targetId ?? "", amountCents, ts].join("|");
  return crypto.createHash("sha256").update(payload).digest("hex");
}

// ─────────────────────────────────────────────────────────────────────────
// writeAudit  —  every financial event flows through here.
//
// Pass `conn` if called inside an open transaction so the audit write is
// part of the same atomic unit.  Omit `conn` for out-of-transaction writes.
// ─────────────────────────────────────────────────────────────────────────
async function writeAudit({
  cycleId,
  eventType,
  actorId    = null,
  targetId   = null,
  amountCents,
  currency   = "USD_CENTS",
  refId      = null,
  metadata   = null,
  conn,                   // optional: open db connection for transactional writes
}) {
  const ts   = new Date();
  const hash = txHash(cycleId, eventType, actorId, targetId, amountCents, ts.toISOString());
  const executor = conn ?? db;
  await executor.execute(
    `INSERT INTO sovereign_audits
     (ts,cycle_id,event_type,actor_id,target_id,amount_cents,currency,ref_id,tx_hash,metadata)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [ts, cycleId, eventType, actorId, targetId, amountCents, currency, refId, hash,
     metadata ? JSON.stringify(metadata) : null]
  );
  return hash;
}

// ─────────────────────────────────────────────────────────────────────────
// Fetch fed_state levers  (cached per cycle to avoid repeated DB hits)
// ─────────────────────────────────────────────────────────────────────────
async function getFedState() {
  const [[row]] = await db.execute("SELECT * FROM sovereign_fed_state WHERE id = 1");
  if (!row) throw new Error("sovereign_fed_state row missing — run v90_schema.sql");
  return row;
}

// ─────────────────────────────────────────────────────────────────────────
// Siphon Engine  —  called per GUILTY seizure row
//   65% → POLICE fund | 5% → arresting officer | 30% → supply burn
// ─────────────────────────────────────────────────────────────────────────
async function executeSiphon({ cycleId, seizureId, arrestingOfficerId, totalCents, fedState }) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const total          = BigInt(totalCents);
    const policePortion  = (total * BigInt(Math.floor(SIPHON_POLICE  * 1000))) / 1000n;
    const officerPortion = (total * BigInt(Math.floor(SIPHON_OFFICER * 1000))) / 1000n;
    const burnPortion    = total - policePortion - officerPortion;

    // Apply officer seizure bonus from fed_state
    const seizureBonusPct  = fedState?.officer_seizure_bonus_pct ?? 0;
    const officerBonus     = (officerPortion * BigInt(seizureBonusPct)) / 100n;
    const officerFinal     = officerPortion + officerBonus;

    // 1. Credit police fund
    await conn.execute(
      `UPDATE department_funds SET balance_cents = balance_cents + ? WHERE dept = 'POLICE'`,
      [policePortion.toString()]
    );
    await writeAudit({
      cycleId, eventType: "SIPHON_POLICE",
      actorId: "system", targetId: "POLICE_FUND",
      amountCents: policePortion.toString(),
      refId: seizureId, conn,
    });

    // 2. Credit arresting officer (+ bonus)
    await conn.execute(
      `UPDATE player_accounts SET balance_cents = balance_cents + ? WHERE citizen_id = ?`,
      [officerFinal.toString(), arrestingOfficerId]
    );
    await writeAudit({
      cycleId, eventType: "SIPHON_OFFICER",
      actorId: "system", targetId: arrestingOfficerId,
      amountCents: officerFinal.toString(),
      refId: seizureId,
      metadata: { bonus_pct: seizureBonusPct },
      conn,
    });

    // 3. Federal burn — supply destruction (no debit target)
    await writeAudit({
      cycleId, eventType: "SIPHON_FEDERAL_BURN",
      actorId: "system", targetId: null,
      amountCents: burnPortion.toString(),
      refId: seizureId,
      metadata: { burn_reason: "federal_supply_control" },
      conn,
    });

    await conn.commit();
    emit("treasury:siphon_complete", {
      seizureId, policePortion: policePortion.toString(),
      officerFinal: officerFinal.toString(), burnPortion: burnPortion.toString(),
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 5-Hour Treasury Heartbeat
// ─────────────────────────────────────────────────────────────────────────
async function runTreasuryCycle() {
  const cycleId = ulid();
  console.log(`[SOVEREIGN] Treasury cycle START  id=${cycleId}`);

  try {
    const fedState = await getFedState();

    // 1. Process GUILTY seizures queued since last cycle
    const [pendingSeizures] = await db.execute(
      `SELECT id, arresting_officer_id, total_cents
         FROM sovereign_seizures
        WHERE verdict = 'GUILTY' AND siphon_status = 'PENDING'`
    );

    for (const row of pendingSeizures) {
      try {
        await executeSiphon({
          cycleId,
          seizureId:          row.id,
          arrestingOfficerId: row.arresting_officer_id,
          totalCents:         row.total_cents,
          fedState,
        });
        await db.execute(
          `UPDATE sovereign_seizures
              SET siphon_status = 'COMPLETE', siphon_cycle_id = ?
            WHERE id = ?`,
          [cycleId, row.id]
        );
      } catch (err) {
        console.error(`[SOVEREIGN] Siphon failed for seizure ${row.id}:`, err);
        await db.execute(
          `UPDATE sovereign_seizures SET siphon_status = 'FAILED' WHERE id = ?`,
          [row.id]
        );
      }
    }

    // 2. Run payroll
    await runPayroll(cycleId, fedState);

    // 3. Expire and settle auctions
    await settleAuctions(cycleId);

    // 4. Attempt pending garnishments
    await processGarnishments(cycleId);

    // 5. Log cycle summary
    await db.execute(
      `INSERT INTO sovereign_cycle_log
       (cycle_id, completed_at, seizures_processed, metadata)
       VALUES (?, NOW(3), ?, ?)`,
      [cycleId, pendingSeizures.length,
       JSON.stringify({ payroll: true, auctions: true, garnishments: true })]
    );

    emit("treasury:cycle_complete", { cycleId, seizures: pendingSeizures.length });
    console.log(`[SOVEREIGN] Treasury cycle DONE  id=${cycleId}  seizures=${pendingSeizures.length}`);
  } catch (err) {
    console.error(`[SOVEREIGN] Treasury cycle FAILED  id=${cycleId}`, err);
    emit("treasury:cycle_failed", { cycleId, error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Payroll  (called from heartbeat)
// ─────────────────────────────────────────────────────────────────────────
async function runPayroll(cycleId, fedState) {
  const rewardMult = fedState?.reward_multiplier ?? 1.0;
  const [staff] = await db.execute(
    `SELECT citizen_id, department, payroll_cents FROM department_staff WHERE active = 1`
  );
  for (const s of staff) {
    const gross = Math.round(s.payroll_cents * rewardMult);
    await db.execute(
      `UPDATE player_accounts SET balance_cents = balance_cents + ? WHERE citizen_id = ?`,
      [gross, s.citizen_id]
    );
    await writeAudit({
      cycleId, eventType: "PAYROLL",
      actorId: "system", targetId: s.citizen_id,
      amountCents: gross,
      metadata: { department: s.department, base: s.payroll_cents, multiplier: rewardMult },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Auction Settlement  (called from heartbeat)
// FIX [SV-19]: winner solvency check before debit
// ─────────────────────────────────────────────────────────────────────────
async function settleAuctions(cycleId) {
  const [expired] = await db.execute(
    `SELECT * FROM sovereign_auctions WHERE status = 'ACTIVE' AND ends_at <= NOW(3)`
  );

  for (const a of expired) {
    if (a.current_bid_cents > 0 && a.current_bidder_id) {
      const conn = await db.getConnection();
      try {
        await conn.beginTransaction();

        // Solvency check: ensure winner has enough funds
        const [[winnerAcct]] = await conn.execute(
          `SELECT balance_cents FROM player_accounts WHERE citizen_id = ? FOR UPDATE`,
          [a.current_bidder_id]
        );
        if (!winnerAcct || BigInt(winnerAcct.balance_cents) < BigInt(a.current_bid_cents)) {
          // Mark as NO_SALE if winner is insolvent
          await conn.execute(
            `UPDATE sovereign_auctions SET status = 'NO_SALE',
               metadata = JSON_SET(IFNULL(metadata,'{}'), '$.no_sale_reason', 'winner_insolvent')
             WHERE auction_id = ?`,
            [a.auction_id]
          );
          await conn.commit();
          console.warn(`[AUCTION] Winner ${a.current_bidder_id} insolvent for ${a.auction_id} — NO_SALE`);
          continue;
        }

        // Debit winner
        await conn.execute(
          `UPDATE player_accounts SET balance_cents = balance_cents - ? WHERE citizen_id = ?`,
          [a.current_bid_cents, a.current_bidder_id]
        );
        // Credit police fund
        await conn.execute(
          `UPDATE department_funds SET balance_cents = balance_cents + ? WHERE dept = 'POLICE'`,
          [a.current_bid_cents]
        );
        await conn.execute(
          `UPDATE sovereign_auctions SET status = 'SOLD' WHERE auction_id = ?`,
          [a.auction_id]
        );
        await writeAudit({
          cycleId, eventType: "AUCTION_SALE",
          actorId: a.current_bidder_id, targetId: "POLICE_FUND",
          amountCents: a.current_bid_cents,
          refId: a.auction_id,
          metadata: { plate: a.vehicle_plate, model: a.vehicle_model },
          conn,
        });

        await conn.commit();
        emit("auction:sold", {
          auctionId: a.auction_id,
          buyerId:   a.current_bidder_id,
          plate:     a.vehicle_plate,
        });
      } catch (err) {
        await conn.rollback();
        console.error(`[AUCTION] Settlement failed for ${a.auction_id}:`, err);
      } finally {
        conn.release();
      }
    } else {
      await db.execute(
        `UPDATE sovereign_auctions SET status = 'NO_SALE' WHERE auction_id = ?`,
        [a.auction_id]
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Medical Bill Settlement  [FIX SV-05, SV-06]
//   75% insurance / 25% patient (BigInt arithmetic throughout)
//   Enforces overdraft cap from fed_state.
//   Triggers garnishment if account goes negative.
//   All audit writes are inside the single transaction via conn.
// ─────────────────────────────────────────────────────────────────────────
async function settleMedicalBill({ cycleId, recordId, patientId, totalBillCents }) {
  const fedState       = await getFedState();
  const overdraftCap   = BigInt(fedState.overdraft_cap_cents ?? 5_000_000);

  const total          = BigInt(totalBillCents);
  const insurancePays  = (total * 75n) / 100n;
  const patientOwes    = total - insurancePays;   // 25%

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // Fetch current balance
    const [[acct]] = await conn.execute(
      `SELECT balance_cents FROM player_accounts WHERE citizen_id = ? FOR UPDATE`,
      [patientId]
    );
    const currentBalance = BigInt(acct?.balance_cents ?? 0);
    const newBalance     = currentBalance - patientOwes;

    // Enforce overdraft cap  [FIX SV-05]
    // If deduction would exceed cap, clamp the actual deduction
    const cappedBalance   = newBalance < -overdraftCap ? -overdraftCap : newBalance;
    const actualDeduction = currentBalance - cappedBalance;

    await conn.execute(
      `UPDATE player_accounts SET balance_cents = ? WHERE citizen_id = ?`,
      [cappedBalance.toString(), patientId]
    );

    await conn.execute(
      `UPDATE medical_records
          SET insurance_paid_cents = ?,
              patient_owed_cents   = ?,
              paid = 1, paid_at = NOW(3)
        WHERE record_id = ?`,
      [insurancePays.toString(), patientOwes.toString(), recordId]
    );

    // Single transactional audit for patient deduction  [FIX SV-06]
    await writeAudit({
      cycleId: cycleId ?? "REALTIME", eventType: "MEDICAL_BILL",
      actorId: "system", targetId: patientId,
      amountCents: actualDeduction.toString(),
      refId: recordId,
      metadata: {
        total_bill:        totalBillCents,
        insurance_covered: insurancePays.toString(),
        patient_owed:      patientOwes.toString(),
        capped:            newBalance < -overdraftCap,
      },
      conn,
    });

    // Single transactional audit for insurance credit  [FIX SV-06]
    await writeAudit({
      cycleId: cycleId ?? "REALTIME", eventType: "INSURANCE_PAYOUT",
      actorId: "INSURANCE_FUND", targetId: patientId,
      amountCents: insurancePays.toString(),
      refId: recordId,
      conn,
    });

    await conn.commit();

    // If account went negative, create garnishment order  [FIX SV-20]
    if (cappedBalance < 0n) {
      await scheduleGarnishment(patientId, cappedBalance, recordId);
    }

    return {
      insurancePays: insurancePays.toString(),
      patientOwes:   patientOwes.toString(),
      newBalance:    cappedBalance.toString(),
      overdrafted:   cappedBalance < 0n,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Garnishment / Waterfall Liquidation  [NEW v9.0 — FIX SV-20]
// ─────────────────────────────────────────────────────────────────────────

/** Creates a garnishment record when a player goes into overdraft. */
async function scheduleGarnishment(citizenId, negativeBalance, refRecordId) {
  const debtCents = (-negativeBalance).toString();
  await db.execute(
    `INSERT INTO overdraft_garnishments
     (citizen_id, debt_cents, ref_record_id) VALUES (?,?,?)`,
    [citizenId, debtCents, refRecordId ?? null]
  );
  emit("garnishment:scheduled", { citizenId, debtCents });
}

/**
 * processGarnishments  —  called each treasury cycle.
 * For each PENDING/PARTIAL garnishment, attempts to collect from player's
 * balance up to the outstanding debt.
 */
async function processGarnishments(cycleId) {
  const [pending] = await db.execute(
    `SELECT * FROM overdraft_garnishments WHERE status IN ('PENDING','PARTIAL')`
  );

  for (const g of pending) {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      const [[acct]] = await conn.execute(
        `SELECT balance_cents FROM player_accounts WHERE citizen_id = ? FOR UPDATE`,
        [g.citizen_id]
      );
      if (!acct) { await conn.rollback(); continue; }

      const balance  = BigInt(acct.balance_cents);
      if (balance <= 0n) { await conn.rollback(); continue; }  // still in debt

      const totalDebt    = BigInt(g.debt_cents) - BigInt(g.recovered_cents);
      const canCollect   = balance < totalDebt ? balance : totalDebt;

      if (canCollect <= 0n) { await conn.rollback(); continue; }

      await conn.execute(
        `UPDATE player_accounts SET balance_cents = balance_cents - ? WHERE citizen_id = ?`,
        [canCollect.toString(), g.citizen_id]
      );

      const newRecovered = BigInt(g.recovered_cents) + canCollect;
      const isCleared    = newRecovered >= BigInt(g.debt_cents);

      await conn.execute(
        `UPDATE overdraft_garnishments
            SET recovered_cents = ?,
                status = ?,
                cleared_at = ${isCleared ? "NOW(3)" : "NULL"}
          WHERE id = ?`,
        [newRecovered.toString(), isCleared ? "CLEARED" : "PARTIAL", g.id]
      );

      await writeAudit({
        cycleId, eventType: "GARNISHMENT",
        actorId: "system", targetId: g.citizen_id,
        amountCents: canCollect.toString(),
        refId: g.ref_record_id,
        metadata: { garnishment_id: g.id, cleared: isCleared },
        conn,
      });

      await conn.commit();
      emit("garnishment:payment", {
        citizenId: g.citizen_id,
        collected: canCollect.toString(),
        cleared:   isCleared,
      });
    } catch (err) {
      await conn.rollback();
      console.error(`[GARNISHMENT] Failed for ${g.citizen_id}:`, err);
    } finally {
      conn.release();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Evidence Deposit Coordinate Validator
// ─────────────────────────────────────────────────────────────────────────
function validateDepositCoords(x, y, z) {
  for (const [stationId, coord] of Object.entries(STATION_COORDS)) {
    const dist = Math.sqrt(
      (x - coord.x) ** 2 +
      (y - coord.y) ** 2 +
      (z - coord.z) ** 2
    );
    if (dist <= coord.radius) return { valid: true, station: stationId };
  }
  return { valid: false, station: null };
}

// ─────────────────────────────────────────────────────────────────────────
// VIP item lock assertion
// ─────────────────────────────────────────────────────────────────────────
async function assertVipLockPermission(itemId, requestingPlayerId) {
  const [[item]] = await db.execute(
    `SELECT source FROM vip_locked_items WHERE item_id = ? AND player_id = ?`,
    [itemId, requestingPlayerId]
  );
  if (!item) throw new Error("ITEM_NOT_FOUND");
  if (!["real_money", "prize"].includes(item.source)) throw new Error("NOT_VIP_LOCKED");
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// Treasury clock scheduler
// ─────────────────────────────────────────────────────────────────────────
function startTreasuryClock() {
  // Immediate catch-up run on server start, then every 5 hours
  runTreasuryCycle().catch(console.error);
  setInterval(() => runTreasuryCycle().catch(console.error), CYCLE_MS);
  console.log(`[SOVEREIGN] Treasury clock started  interval=${CYCLE_MS / 3600000}h`);
}

// ─────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────
module.exports = {
  ulid,
  txHash,
  writeAudit,
  validateDepositCoords,
  settleMedicalBill,
  scheduleGarnishment,
  assertVipLockPermission,
  executeSiphon,
  runTreasuryCycle,
  runPayroll,
  settleAuctions,
  processGarnishments,
  startTreasuryClock,
  getFedState,
  STATION_COORDS,
};
