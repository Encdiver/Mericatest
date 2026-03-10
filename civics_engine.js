// ═══════════════════════════════════════════════════════════════════════════
//  civics_engine.js  –  MERICA Sovereign v9.0
//  Express REST API layer.
//  Mount: app.use('/api', civicsRouter)
//  Boot:  await bootstrapCivics()
//
//  FIXED in v9.0:
//    [SV-07] Auction bid broadcasts are debounced at 200ms per auctionId
//    [SV-19] Auction bid REST path already had FOR UPDATE — no change needed
//    Added: /api/mechanic/* endpoints
//    Added: /api/garnishments endpoint
// ═══════════════════════════════════════════════════════════════════════════

"use strict";

const express = require("express");
const router  = express.Router();

// FIX: correct relative import path (was wrong in v8.8)
const {
  writeAudit,
  validateDepositCoords,
  settleMedicalBill,
  ulid,
  STATION_COORDS,
  getFedState,
} = require("./sovereign_core/sovereign_core");

const { db }   = require("../db");
const { emit } = require("../events");
const { requireAdmin, requireAuth } = require("../middleware/auth");

// ─────────────────────────────────────────────────────────────────────────
// Auction bid broadcast debounce  [FIX SV-07]
// Prevents socket flood on rapid bids.  200ms window per auction.
// ─────────────────────────────────────────────────────────────────────────
const pendingBidBroadcasts = new Map();

function emitBidDebounced(auctionId, payload) {
  if (pendingBidBroadcasts.has(auctionId)) {
    clearTimeout(pendingBidBroadcasts.get(auctionId));
  }
  const timer = setTimeout(() => {
    emit("auction:bid:updated", payload);
    pendingBidBroadcasts.delete(auctionId);
  }, 200);
  pendingBidBroadcasts.set(auctionId, timer);
}

// ═══════════════════════════════════════════════════════════════════════════
//  PART 1 – Federal State
// ═══════════════════════════════════════════════════════════════════════════

const FED_STATE_COLUMN_MAP = {
  liborRate:                 "libor_rate",
  rewardMultiplier:          "reward_multiplier",
  burnRate:                  "burn_rate",
  decayMultiplier:           "decay_multiplier",
  medicProfessionalBonusPct: "medic_professional_bonus_pct",
  officerSeizureBonusPct:    "officer_seizure_bonus_pct",
  cctvFps:                   "cctv_fps",
};

const FED_STATE_BOUNDS = {
  liborRate:                 { min: 0,   max: 2000 },
  rewardMultiplier:          { min: 0.1, max: 3.0  },
  burnRate:                  { min: 0.1, max: 5.0  },
  decayMultiplier:           { min: 0.1, max: 5.0  },
  medicProfessionalBonusPct: { min: 0,   max: 500  },
  officerSeizureBonusPct:    { min: 0,   max: 500  },
  cctvFps:                   { min: 6,   max: 24   },
};

/** GET /api/admin/fed-state */
router.get("/admin/fed-state", requireAdmin, async (req, res) => {
  try {
    const row = await getFedState();
    res.json({
      liborRate:                 row.libor_rate,
      rewardMultiplier:          row.reward_multiplier,
      burnRate:                  row.burn_rate,
      decayMultiplier:           row.decay_multiplier,
      medicProfessionalBonusPct: row.medic_professional_bonus_pct,
      officerSeizureBonusPct:    row.officer_seizure_bonus_pct,
      cctvFps:                   row.cctv_fps,
    });
  } catch (err) {
    console.error("[civics] GET fed-state:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

/** PATCH /api/admin/fed-state */
router.patch("/admin/fed-state", requireAdmin, async (req, res) => {
  const sets  = [];
  const vals  = [];
  const patch = {};

  for (const [key, col] of Object.entries(FED_STATE_COLUMN_MAP)) {
    if (req.body[key] === undefined) continue;
    const v = parseFloat(req.body[key]);
    if (isNaN(v)) return res.status(400).json({ error: `Invalid value for ${key}` });
    const b = FED_STATE_BOUNDS[key];
    if (v < b.min || v > b.max)
      return res.status(400).json({ error: `${key} out of range [${b.min}, ${b.max}]` });
    sets.push(`${col} = ?`);
    vals.push(v);
    patch[key] = v;
  }

  if (sets.length === 0) return res.status(400).json({ error: "No valid fields provided" });

  try {
    await db.execute(`UPDATE sovereign_fed_state SET ${sets.join(", ")} WHERE id = 1`, vals);
    emit("fed:rate:change", patch);
    if (patch.cctvFps !== undefined) emit("cctv:fps:change", { fps: patch.cctvFps });
    res.json({ ok: true, updated: patch });
  } catch (err) {
    console.error("[civics] PATCH fed-state:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// PART 1 – Audit Log
// ─────────────────────────────────────────────────────────────────────────

/** GET /api/admin/audits?limit=50&offset=0&event_type=SIPHON_POLICE */
router.get("/admin/audits", requireAdmin, async (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit  ?? "50", 10), 200);
  const offset = parseInt(req.query.offset ?? "0", 10);
  const type   = req.query.event_type;

  const where  = type ? " WHERE event_type = ?" : "";
  const params = type ? [type] : [];

  try {
    const [rows]      = await db.execute(`SELECT * FROM sovereign_audits${where} ORDER BY ts DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    const [[{ total }]] = await db.execute(`SELECT COUNT(*) AS total FROM sovereign_audits${where}`, params);
    res.json({ rows, total });
  } catch (err) {
    console.error("[civics] GET audits:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  PART 2 – Evidence
// ═══════════════════════════════════════════════════════════════════════════

/** POST /api/evidence/deposit */
router.post("/evidence/deposit", requireAuth, async (req, res) => {
  const { evidenceId, coords } = req.body;
  if (!evidenceId || typeof coords?.x !== "number")
    return res.status(400).json({ error: "Missing fields: evidenceId, coords.{x,y,z}" });

  const validation = validateDepositCoords(coords.x, coords.y, coords.z);
  if (!validation.valid)
    return res.status(403).json({ error: "NOT_AT_STATION", stations: Object.keys(STATION_COORDS) });

  try {
    const [result] = await db.execute(
      `UPDATE sv78_evidence_log
          SET status = 'DEPOSITED', deposited_at = NOW(3), deposit_coords = ?
        WHERE evidence_id = ? AND status = 'PENDING'`,
      [JSON.stringify(coords), evidenceId]
    );
    if (result.affectedRows === 0)
      return res.status(404).json({ error: "Evidence not found or already deposited" });

    await writeAudit({
      cycleId: "REALTIME", eventType: "EVIDENCE_DEPOSIT",
      actorId: req.citizen?.id ?? null, refId: evidenceId,
      amountCents: "0", currency: "EVIDENCE_UNITS",
      metadata: { station: validation.station, coords },
    });

    emit("evidence:deposited", { evidenceId, station: validation.station });
    res.json({ ok: true, station: validation.station });
  } catch (err) {
    console.error("[civics] POST evidence/deposit:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

/** GET /api/evidence/:id */
router.get("/evidence/:id", requireAuth, async (req, res) => {
  try {
    const [[row]] = await db.execute(
      "SELECT * FROM sv78_evidence_log WHERE evidence_id = ?", [req.params.id]
    );
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: "Internal error" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  PART 2 – Auctions
// ═══════════════════════════════════════════════════════════════════════════

/** GET /api/auctions?status=ACTIVE */
router.get("/auctions", async (req, res) => {
  const status = ["ACTIVE","SOLD","NO_SALE","CANCELLED"].includes(req.query.status)
    ? req.query.status : "ACTIVE";
  try {
    const [rows] = await db.execute(
      `SELECT a.*,
              (SELECT MAX(bid_cents) FROM sovereign_auction_bids b WHERE b.auction_id = a.auction_id) AS top_bid,
              (SELECT COUNT(*)       FROM sovereign_auction_bids b WHERE b.auction_id = a.auction_id) AS bid_count
         FROM sovereign_auctions a
        WHERE a.status = ?
        ORDER BY a.ends_at ASC`,
      [status]
    );
    res.json({ auctions: rows });
  } catch (err) {
    console.error("[civics] GET auctions:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

/** GET /api/auctions/:id/bids */
router.get("/auctions/:id/bids", async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT bid_id, bidder_id, bid_cents, bid_ts, source
         FROM sovereign_auction_bids
        WHERE auction_id = ?
        ORDER BY bid_cents DESC LIMIT 50`,
      [req.params.id]
    );
    res.json({ bids: rows });
  } catch (err) {
    res.status(500).json({ error: "Internal error" });
  }
});

/** POST /api/auctions/:id/bid  (transactional, FOR UPDATE) */
router.post("/auctions/:id/bid", requireAuth, async (req, res) => {
  const auctionId = req.params.id;
  const bidderId  = req.citizen.id;

  let bidCents;
  try {
    bidCents = BigInt(req.body.bidCents ?? "0");
  } catch {
    return res.status(400).json({ error: "Invalid bidCents — must be a numeric string" });
  }
  if (bidCents <= 0n) return res.status(400).json({ error: "Bid must be positive" });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[auction]] = await conn.execute(
      "SELECT * FROM sovereign_auctions WHERE auction_id = ? FOR UPDATE",
      [auctionId]
    );
    if (!auction)                           { await conn.rollback(); return res.status(404).json({ error: "Auction not found" }); }
    if (auction.status !== "ACTIVE")        { await conn.rollback(); return res.status(409).json({ error: "Auction not active" }); }
    if (new Date(auction.ends_at) < new Date()) { await conn.rollback(); return res.status(409).json({ error: "Auction expired" }); }
    if (bidCents <= BigInt(auction.current_bid_cents)) {
      await conn.rollback();
      return res.status(409).json({ error: "Bid too low", current: auction.current_bid_cents });
    }

    // Bidder solvency check
    const [[bidderAcct]] = await conn.execute(
      "SELECT balance_cents FROM player_accounts WHERE citizen_id = ?",
      [bidderId]
    );
    if (!bidderAcct || BigInt(bidderAcct.balance_cents) < bidCents) {
      await conn.rollback();
      return res.status(409).json({ error: "Insufficient funds to place this bid" });
    }

    await conn.execute(
      "UPDATE sovereign_auctions SET current_bid_cents=?, current_bidder_id=? WHERE auction_id=?",
      [bidCents.toString(), bidderId, auctionId]
    );
    await conn.execute(
      "INSERT INTO sovereign_auction_bids (auction_id, bidder_id, bid_cents, source) VALUES (?,?,?,?)",
      [auctionId, bidderId, bidCents.toString(), "WEBSITE"]
    );
    await conn.commit();

    await writeAudit({
      cycleId: "REALTIME", eventType: "AUCTION_BID",
      actorId: bidderId, targetId: auctionId,
      amountCents: bidCents.toString(),
      refId: auctionId,
      metadata: { plate: auction.vehicle_plate, source: "WEBSITE" },
    });

    // Debounced broadcast  [FIX SV-07]
    emitBidDebounced(auctionId, {
      auctionId, bidCents: bidCents.toString(), bidderId,
      plate: auction.vehicle_plate,
    });

    res.json({ ok: true, bid: bidCents.toString() });
  } catch (err) {
    await conn.rollback();
    console.error("[civics] POST auction bid:", err);
    res.status(500).json({ error: "Internal error" });
  } finally {
    conn.release();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  PART 3 – Medical
// ═══════════════════════════════════════════════════════════════════════════

/** POST /api/medical/records */
router.post("/medical/records", requireAuth, async (req, res) => {
  const { patientId, medicId, traumaZones, totalBillCents } = req.body;
  if (!patientId || totalBillCents === undefined)
    return res.status(400).json({ error: "Missing: patientId, totalBillCents" });

  // Input validation [FIX SV-16]
  const billNum = parseInt(totalBillCents, 10);
  if (isNaN(billNum) || billNum < 0)
    return res.status(400).json({ error: "totalBillCents must be a non-negative integer" });

  const recordId = ulid();
  try {
    await db.execute(
      `INSERT INTO medical_records
       (record_id, patient_id, medic_id, trauma_zones, total_bill_cents)
       VALUES (?,?,?,?,?)`,
      [recordId, patientId, medicId ?? req.citizen?.id, JSON.stringify(traumaZones ?? []), billNum]
    );

    const settlement = await settleMedicalBill({
      cycleId: "REALTIME", recordId, patientId, totalBillCents: billNum,
    });

    emit("medical:bill:settled", { recordId, patientId, ...settlement });
    res.json({ ok: true, recordId, ...settlement });
  } catch (err) {
    console.error("[civics] POST medical/records:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

/** GET /api/medical/records/:patientId */
router.get("/medical/records/:patientId", requireAuth, async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT * FROM medical_records WHERE patient_id = ? ORDER BY created_at DESC LIMIT 20",
      [req.params.patientId]
    );
    res.json({ records: rows });
  } catch (err) {
    res.status(500).json({ error: "Internal error" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  PART 4 – Repo Orders
// ═══════════════════════════════════════════════════════════════════════════

/** GET /api/repo/orders?status=ACTIVE */
router.get("/repo/orders", requireAuth, async (req, res) => {
  const status = ["ACTIVE","EXECUTED","CANCELLED"].includes(req.query.status)
    ? req.query.status : "ACTIVE";
  try {
    const [rows] = await db.execute(
      `SELECT r.*,
              pa.charinfo->>'$.firstname' AS target_first,
              pa.charinfo->>'$.lastname'  AS target_last
         FROM sovereign_repo_orders r
         LEFT JOIN players pa ON pa.citizenid = r.target_player_id
        WHERE r.status = ?
        ORDER BY r.issued_at DESC`,
      [status]
    );
    res.json({ orders: rows });
  } catch (err) {
    console.error("[civics] GET repo/orders:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

/** POST /api/repo/orders */
router.post("/repo/orders", requireAdmin, async (req, res) => {
  const { targetCid, vehiclePlate, loanId, outstandingCents } = req.body;
  if (!targetCid || !vehiclePlate || !loanId || outstandingCents === undefined)
    return res.status(400).json({ error: "Missing: targetCid, vehiclePlate, loanId, outstandingCents" });

  const orderId = ulid();
  try {
    await db.execute(
      `INSERT INTO sovereign_repo_orders
       (order_id, issued_by, target_player_id, vehicle_plate, loan_id, outstanding_cents)
       VALUES (?,?,?,?,?,?)`,
      [orderId, req.admin.id, targetCid, vehiclePlate, loanId, outstandingCents]
    );
    await writeAudit({
      cycleId: "REALTIME", eventType: "REPO_ORDER",
      actorId: req.admin.id, targetId: targetCid,
      amountCents: outstandingCents,
      refId: orderId,
      metadata: { plate: vehiclePlate, loan_id: loanId },
    });
    emit("repo:order:created", { orderId, plate: vehiclePlate, targetCid });
    res.status(201).json({ ok: true, orderId });
  } catch (err) {
    console.error("[civics] POST repo/orders:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

/** PATCH /api/repo/orders/:id/execute */
router.patch("/repo/orders/:id/execute", requireAuth, async (req, res) => {
  try {
    const [result] = await db.execute(
      `UPDATE sovereign_repo_orders
          SET status = 'EXECUTED', executed_at = NOW(3), executed_by = ?
        WHERE order_id = ? AND status = 'ACTIVE'`,
      [req.citizen.id, req.params.id]
    );
    if (result.affectedRows === 0)
      return res.status(404).json({ error: "Order not found or already closed" });
    emit("repo:order:executed", { orderId: req.params.id, executedBy: req.citizen.id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Internal error" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  PART 4 – Trophy Rack
// ═══════════════════════════════════════════════════════════════════════════

/** GET /api/trophies?org=lospollos */
router.get("/trophies", async (req, res) => {
  try {
    const org = req.query.org;
    const [rows] = await db.execute(
      `SELECT * FROM police_trophy_rack
        WHERE on_display = 1${org ? " AND from_org = ?" : ""}
        ORDER BY seized_at DESC`,
      org ? [org] : []
    );
    res.json({ trophies: rows });
  } catch (err) {
    res.status(500).json({ error: "Internal error" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  PART 5 – VIP Item Lock
// ═══════════════════════════════════════════════════════════════════════════

/** POST /api/vip/lock */
router.post("/vip/lock", requireAdmin, async (req, res) => {
  const { itemId, itemName, source, playerId } = req.body;
  if (!["real_money", "prize"].includes(source))
    return res.status(400).json({ error: "source must be 'real_money' or 'prize'" });
  if (!itemId || !itemName || !playerId)
    return res.status(400).json({ error: "Missing: itemId, itemName, playerId" });

  try {
    await db.execute(
      "INSERT INTO vip_locked_items (item_id, player_id, item_name, source) VALUES (?,?,?,?)",
      [itemId, playerId, itemName, source]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "Already locked" });
    res.status(500).json({ error: "Internal error" });
  }
});

/** GET /api/vip/locked/:playerId */
router.get("/vip/locked/:playerId", requireAuth, async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT * FROM vip_locked_items WHERE player_id = ?", [req.params.playerId]
    );
    res.json({ items: rows });
  } catch (err) {
    res.status(500).json({ error: "Internal error" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  v9.0 NEW – Mechanic Work Orders
// ═══════════════════════════════════════════════════════════════════════════

/** POST /api/mechanic/orders */
router.post("/mechanic/orders", requireAuth, async (req, res) => {
  const { customerId, vehiclePlate, vehicleModel, jobType, labourCents, partsUsed } = req.body;
  if (!customerId || !vehiclePlate || !jobType)
    return res.status(400).json({ error: "Missing: customerId, vehiclePlate, jobType" });

  const validJobTypes = ["repair","customise","tow","inspection"];
  if (!validJobTypes.includes(jobType))
    return res.status(400).json({ error: `jobType must be one of: ${validJobTypes.join(", ")}` });

  const orderId    = ulid();
  const labour     = parseInt(labourCents ?? 0, 10);
  const partsArr   = Array.isArray(partsUsed) ? partsUsed : [];
  const partsTotal = partsArr.reduce((s, p) => s + (parseInt(p.cost_cents ?? 0, 10) * (p.qty ?? 1)), 0);

  // 7.5% parts/goods tax → sovereign vault
  const taxCents   = Math.floor(partsTotal * 0.075);
  const total      = labour + partsTotal + taxCents;

  try {
    await db.execute(
      `INSERT INTO mechanic_work_orders
       (order_id, mechanic_id, customer_id, vehicle_plate, vehicle_model,
        job_type, parts_used, labour_cents, parts_total_cents, tax_cents, total_cents)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [orderId, req.citizen.id, customerId, vehiclePlate, vehicleModel ?? "",
       jobType, JSON.stringify(partsArr), labour, partsTotal, taxCents, total]
    );

    // Emit for Lua server to credit mechanic & debit customer
    emit("mechanic:order:created", {
      orderId, mechanicId: req.citizen.id, customerId, total,
      taxCents, plate: vehiclePlate,
    });

    res.status(201).json({ ok: true, orderId, total, taxCents });
  } catch (err) {
    console.error("[civics] POST mechanic/orders:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

/** PATCH /api/mechanic/orders/:id/complete */
router.patch("/mechanic/orders/:id/complete", requireAuth, async (req, res) => {
  const orderId = req.params.id;
  const conn    = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[order]] = await conn.execute(
      "SELECT * FROM mechanic_work_orders WHERE order_id = ? FOR UPDATE", [orderId]
    );
    if (!order)                              { await conn.rollback(); return res.status(404).json({ error: "Order not found" }); }
    if (order.status !== "IN_PROGRESS" && order.status !== "OPEN") {
      await conn.rollback();
      return res.status(409).json({ error: "Order already completed or cancelled" });
    }

    // Debit customer
    await conn.execute(
      `UPDATE player_accounts SET balance_cents = balance_cents - ? WHERE citizen_id = ?`,
      [order.total_cents, order.customer_id]
    );
    // Credit mechanic (labour portion)
    await conn.execute(
      `UPDATE player_accounts SET balance_cents = balance_cents + ? WHERE citizen_id = ?`,
      [order.labour_cents, order.mechanic_id]
    );
    // Route parts tax to vault
    if (order.tax_cents > 0) {
      await conn.execute(
        `UPDATE department_funds SET balance_cents = balance_cents + ? WHERE dept = 'POLICE'`,
        [order.tax_cents]
      );
    }
    await conn.execute(
      `UPDATE mechanic_work_orders SET status = 'COMPLETE', completed_at = NOW(3) WHERE order_id = ?`,
      [orderId]
    );

    await writeAudit({
      cycleId: "REALTIME", eventType: "MECHANIC_PAYOUT",
      actorId: order.mechanic_id, targetId: order.customer_id,
      amountCents: order.total_cents.toString(),
      refId: orderId,
      metadata: { job_type: order.job_type, plate: order.vehicle_plate },
      conn,
    });
    if (order.tax_cents > 0) {
      await writeAudit({
        cycleId: "REALTIME", eventType: "MECHANIC_PARTS_TAX",
        actorId: "system", targetId: "POLICE_FUND",
        amountCents: order.tax_cents.toString(),
        refId: orderId,
        conn,
      });
    }

    await conn.commit();
    emit("mechanic:order:complete", { orderId, customerId: order.customer_id });
    res.json({ ok: true });
  } catch (err) {
    await conn.rollback();
    console.error("[civics] PATCH mechanic complete:", err);
    res.status(500).json({ error: "Internal error" });
  } finally {
    conn.release();
  }
});

/** GET /api/mechanic/orders?mechanicId=... */
router.get("/mechanic/orders", requireAuth, async (req, res) => {
  try {
    const mechanicId = req.query.mechanicId ?? req.citizen.id;
    const [rows] = await db.execute(
      "SELECT * FROM mechanic_work_orders WHERE mechanic_id = ? ORDER BY created_at DESC LIMIT 30",
      [mechanicId]
    );
    res.json({ orders: rows });
  } catch (err) {
    res.status(500).json({ error: "Internal error" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  v9.0 NEW – Garnishments
// ═══════════════════════════════════════════════════════════════════════════

/** GET /api/garnishments/:citizenId */
router.get("/garnishments/:citizenId", requireAuth, async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT * FROM overdraft_garnishments WHERE citizen_id = ? ORDER BY triggered_at DESC LIMIT 10",
      [req.params.citizenId]
    );
    res.json({ garnishments: rows });
  } catch (err) {
    res.status(500).json({ error: "Internal error" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  Bootstrap: ensure tables exist, start treasury clock
// ═══════════════════════════════════════════════════════════════════════════

async function bootstrapCivics() {
  // Tables are created via v90_schema.sql — no inline DDL needed here.
  // Just start the treasury clock.
  const { startTreasuryClock } = require("./sovereign_core/sovereign_core");
  startTreasuryClock();
  console.log("[CIVICS] v9.0 bootstrapped — treasury clock running");
}

module.exports = { civicsRouter: router, bootstrapCivics };
