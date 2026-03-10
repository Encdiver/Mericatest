-- ═══════════════════════════════════════════════════════════════════════════
--  MERICA SOVEREIGN v9.0  –  SQL Schema  (full, run once)
--  Idempotent: all statements use IF NOT EXISTS / INSERT IGNORE.
--
--  UPGRADE from v8.8:
--    • Adds sovereign_seizures table (was missing – crashed treasury cycle)
--    • Adds department_funds table  (was missing – crashed siphon + auctions)
--    • Adds department_staff table  (was missing – crashed payroll)
--    • Adds mechanic_work_orders table (new v9.0)
--    • Adds overdraft_garnishments table (new v9.0 waterfall liquidation)
--    • Audits event_type ENUM extended with REPO_ORDER, GARNISHMENT,
--      MECHANIC_PAYOUT, MECHANIC_PARTS_TAX
--    • player_accounts.balance_cents changed to SIGNED BIGINT
--      (run ALTER below if upgrading from UNSIGNED)
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────
-- UPGRADE: Make balance_cents SIGNED so overdraft is possible.
-- Run only if currently UNSIGNED BIGINT (comment out on fresh installs).
-- ─────────────────────────────────────────────────────────────────────────
-- ALTER TABLE `player_accounts` MODIFY `balance_cents` BIGINT NOT NULL DEFAULT 0;

-- ─────────────────────────────────────────────────────────────────────────
-- PART 1 · Federal State  (single-row config table)
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS `sovereign_fed_state` (
  `id`                           TINYINT UNSIGNED NOT NULL DEFAULT 1,
  `libor_rate`                   SMALLINT         NOT NULL DEFAULT 500
                                   COMMENT 'Basis points (500 = 5.00%)',
  `reward_multiplier`            DECIMAL(4,2)     NOT NULL DEFAULT 1.00,
  `burn_rate`                    DECIMAL(4,2)     NOT NULL DEFAULT 1.00,
  `decay_multiplier`             DECIMAL(4,2)     NOT NULL DEFAULT 1.00,
  `medic_professional_bonus_pct` SMALLINT         NOT NULL DEFAULT 0,
  `officer_seizure_bonus_pct`    SMALLINT         NOT NULL DEFAULT 0,
  `cctv_fps`                     TINYINT UNSIGNED NOT NULL DEFAULT 12,
  `overdraft_cap_cents`          BIGINT           NOT NULL DEFAULT 5000000
                                   COMMENT 'Max negative balance = -$50,000',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO `sovereign_fed_state` (`id`) VALUES (1);

-- ─────────────────────────────────────────────────────────────────────────
-- PART 1 · Treasury Audit Log
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS `sovereign_audits` (
  `id`           BIGINT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  `ts`           DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `cycle_id`     CHAR(26)         NOT NULL COMMENT 'ULID of the 5-hour heartbeat cycle',
  `event_type`   ENUM(
                   'SIPHON_POLICE','SIPHON_OFFICER','SIPHON_FEDERAL_BURN',
                   'PAYROLL','SEIZURE_CASH','SEIZURE_VEHICLE','SEIZURE_ITEM',
                   'MEDICAL_BILL','INSURANCE_PAYOUT',
                   'EVIDENCE_DEPOSIT',
                   'AUCTION_SALE','AUCTION_BID',
                   'REPO_ORDER',
                   'GARNISHMENT',
                   'MECHANIC_PAYOUT','MECHANIC_PARTS_TAX'
                 ) NOT NULL,
  `actor_id`     VARCHAR(64)      NULL COMMENT 'citizen_id or "system"',
  `target_id`    VARCHAR(64)      NULL COMMENT 'citizen_id or entity ref',
  `amount_cents` BIGINT           NOT NULL DEFAULT 0,
  `currency`     ENUM('USD_CENTS','EVIDENCE_UNITS') NOT NULL DEFAULT 'USD_CENTS',
  `ref_id`       VARCHAR(128)     NULL COMMENT 'evidence_id / plate / order_id etc.',
  `tx_hash`      CHAR(64)         NOT NULL COMMENT 'SHA-256 integrity chain',
  `metadata`     JSON             NULL,
  INDEX `idx_cycle`  (`cycle_id`),
  INDEX `idx_event`  (`event_type`),
  INDEX `idx_actor`  (`actor_id`),
  INDEX `idx_ts`     (`ts`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────
-- PART 1 · Cycle Heartbeat Log
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS `sovereign_cycle_log` (
  `cycle_id`           CHAR(26)    NOT NULL PRIMARY KEY,
  `completed_at`       DATETIME(3) NOT NULL,
  `seizures_processed` INT         NOT NULL DEFAULT 0,
  `metadata`           JSON        NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────
-- PART 1 · Seizures  (WAS MISSING — crashed treasury cycle)
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS `sovereign_seizures` (
  `id`                  CHAR(26)    NOT NULL PRIMARY KEY COMMENT 'ULID',
  `created_at`          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `arresting_officer_id` VARCHAR(64) NOT NULL,
  `suspect_id`          VARCHAR(64) NOT NULL,
  `total_cents`         BIGINT      NOT NULL DEFAULT 0,
  `verdict`             ENUM('PENDING','GUILTY','NOT_GUILTY','DISMISSED')
                          NOT NULL DEFAULT 'PENDING',
  `verdict_at`          DATETIME(3) NULL,
  `siphon_status`       ENUM('PENDING','COMPLETE','FAILED')
                          NOT NULL DEFAULT 'PENDING',
  `siphon_cycle_id`     CHAR(26)    NULL,
  `evidence_id`         CHAR(26)    NULL,
  `notes`               TEXT        NULL,
  INDEX `idx_verdict_siphon` (`verdict`, `siphon_status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────
-- PART 1 · Department Funds  (WAS MISSING — crashed siphon + auctions)
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS `department_funds` (
  `dept`          VARCHAR(32) NOT NULL PRIMARY KEY,
  `balance_cents` BIGINT      NOT NULL DEFAULT 0,
  `updated_at`    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                    ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO `department_funds` (`dept`, `balance_cents`) VALUES
  ('POLICE', 0),
  ('EMS',    0),
  ('COURT',  0);

-- ─────────────────────────────────────────────────────────────────────────
-- PART 1 · Department Staff Payroll  (WAS MISSING — crashed payroll)
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS `department_staff` (
  `id`             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `citizen_id`     VARCHAR(64) NOT NULL,
  `department`     VARCHAR(32) NOT NULL,
  `payroll_cents`  BIGINT      NOT NULL DEFAULT 0
                     COMMENT 'Amount paid per 5-hour cycle',
  `active`         TINYINT(1)  NOT NULL DEFAULT 1,
  `enrolled_at`    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY `uq_citizen_dept` (`citizen_id`, `department`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────
-- PART 2 · Evidence Log
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS `sv78_evidence_log` (
  `evidence_id`      CHAR(26)     NOT NULL PRIMARY KEY COMMENT 'ULID',
  `created_at`       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `deposited_at`     DATETIME(3)  NULL,
  `officer_id`       VARCHAR(64)  NOT NULL,
  `suspect_id`       VARCHAR(64)  NULL,
  `item_name`        VARCHAR(128) NOT NULL,
  `item_count`       INT UNSIGNED NOT NULL DEFAULT 1,
  `item_metadata`    JSON         NULL,
  `seized_coords`    JSON         NULL COMMENT '{x,y,z,heading}',
  `deposit_coords`   JSON         NULL COMMENT 'Validated station coords',
  `case_number`      VARCHAR(32)  NULL,
  `chain_of_custody` JSON         NOT NULL DEFAULT (JSON_ARRAY())
                       COMMENT '[{officer_id,ts,action}]',
  `status`           ENUM('PENDING','DEPOSITED','LOGGED_MDT','RELEASED','DESTROYED')
                       NOT NULL DEFAULT 'PENDING',
  INDEX `idx_officer` (`officer_id`),
  INDEX `idx_suspect` (`suspect_id`),
  INDEX `idx_status`  (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────
-- PART 2 · Vehicle Auctions
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS `sovereign_auctions` (
  `auction_id`         CHAR(26)    NOT NULL PRIMARY KEY,
  `created_at`         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `ends_at`            DATETIME(3) NOT NULL,
  `vehicle_plate`      VARCHAR(16) NOT NULL,
  `vehicle_model`      VARCHAR(64) NOT NULL,
  `original_owner_id`  VARCHAR(64) NULL COMMENT 'NULL = NPC vehicle',
  `seized_by`          VARCHAR(64) NOT NULL,
  `seizure_evidence_id` CHAR(26)   NULL,
  `reserve_cents`      BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `current_bid_cents`  BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `current_bidder_id`  VARCHAR(64) NULL,
  `status`             ENUM('ACTIVE','SOLD','NO_SALE','CANCELLED')
                         NOT NULL DEFAULT 'ACTIVE',
  INDEX `idx_status` (`status`),
  INDEX `idx_ends`   (`ends_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `sovereign_auction_bids` (
  `bid_id`     BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `auction_id` CHAR(26)        NOT NULL,
  `bidder_id`  VARCHAR(64)     NOT NULL,
  `bid_cents`  BIGINT UNSIGNED NOT NULL,
  `bid_ts`     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `source`     ENUM('INGAME','WEBSITE') NOT NULL DEFAULT 'INGAME',
  INDEX `idx_auction` (`auction_id`),
  CONSTRAINT `fk_bid_auction`
    FOREIGN KEY (`auction_id`) REFERENCES `sovereign_auctions`(`auction_id`)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────
-- PART 3 · Medical Records
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS `medical_records` (
  `record_id`            CHAR(26)    NOT NULL PRIMARY KEY,
  `created_at`           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `patient_id`           VARCHAR(64) NOT NULL,
  `medic_id`             VARCHAR(64) NOT NULL,
  `trauma_zones`         JSON        NOT NULL COMMENT '[{zone,injury,treatment,ts}]',
  `total_bill_cents`     BIGINT      NOT NULL DEFAULT 0,
  `insurance_pct`        TINYINT     NOT NULL DEFAULT 75,
  `insurance_paid_cents` BIGINT      NOT NULL DEFAULT 0,
  `patient_owed_cents`   BIGINT      NOT NULL DEFAULT 0,
  `paid`                 TINYINT(1)  NOT NULL DEFAULT 0,
  `paid_at`              DATETIME(3) NULL,
  INDEX `idx_patient` (`patient_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────
-- PART 3 · v9.0: Overdraft Garnishment / Waterfall Liquidation
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS `overdraft_garnishments` (
  `id`               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `citizen_id`       VARCHAR(64) NOT NULL,
  `triggered_at`     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `debt_cents`       BIGINT      NOT NULL COMMENT 'Negative balance at time of garnishment',
  `recovered_cents`  BIGINT      NOT NULL DEFAULT 0,
  `status`           ENUM('PENDING','PARTIAL','CLEARED','UNCOLLECTABLE')
                       NOT NULL DEFAULT 'PENDING',
  `ref_record_id`    CHAR(26)    NULL COMMENT 'Medical record that triggered overdraft',
  `cleared_at`       DATETIME(3) NULL,
  INDEX `idx_cid`    (`citizen_id`),
  INDEX `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────
-- PART 4 · Repo Orders
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS `sovereign_repo_orders` (
  `order_id`          CHAR(26)    NOT NULL PRIMARY KEY,
  `issued_at`         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `issued_by`         VARCHAR(64) NOT NULL COMMENT 'admin or banker citizen_id',
  `target_player_id`  VARCHAR(64) NOT NULL,
  `vehicle_plate`     VARCHAR(16) NOT NULL,
  `loan_id`           VARCHAR(64) NOT NULL,
  `outstanding_cents` BIGINT      NOT NULL,
  `status`            ENUM('ACTIVE','EXECUTED','CANCELLED') NOT NULL DEFAULT 'ACTIVE',
  `executed_at`       DATETIME(3) NULL,
  `executed_by`       VARCHAR(64) NULL,
  INDEX `idx_target` (`target_player_id`),
  INDEX `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────
-- PART 4 · Trophy Rack
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS `police_trophy_rack` (
  `trophy_id`       CHAR(26)    NOT NULL PRIMARY KEY,
  `seized_at`       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `seized_by`       VARCHAR(64) NOT NULL,
  `from_player_id`  VARCHAR(64) NOT NULL,
  `from_org`        VARCHAR(64) NULL,
  `identifier_type` VARCHAR(64) NOT NULL COMMENT 'badge,patch,tag,medallion,etc.',
  `identifier_data` JSON        NOT NULL,
  `on_display`      TINYINT(1)  NOT NULL DEFAULT 1,
  INDEX `idx_org`      (`from_org`),
  INDEX `idx_seized_by`(`seized_by`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────
-- PART 5 · VIP Item Lock Registry
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS `vip_locked_items` (
  `item_id`     CHAR(26)     NOT NULL PRIMARY KEY,
  `player_id`   VARCHAR(64)  NOT NULL,
  `item_name`   VARCHAR(128) NOT NULL,
  `source`      ENUM('real_money','prize') NOT NULL,
  `locked_at`   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `lock_reason` VARCHAR(256) NULL,
  INDEX `idx_player` (`player_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────
-- v9.0 NEW · Mechanic Work Orders
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS `mechanic_work_orders` (
  `order_id`        CHAR(26)    NOT NULL PRIMARY KEY COMMENT 'ULID',
  `created_at`      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `completed_at`    DATETIME(3) NULL,
  `mechanic_id`     VARCHAR(64) NOT NULL,
  `customer_id`     VARCHAR(64) NOT NULL,
  `vehicle_plate`   VARCHAR(16) NOT NULL,
  `vehicle_model`   VARCHAR(64) NOT NULL,
  `job_type`        ENUM('repair','customise','tow','inspection') NOT NULL,
  `parts_used`      JSON        NULL COMMENT '[{name,qty,cost_cents}]',
  `labour_cents`    BIGINT      NOT NULL DEFAULT 0,
  `parts_total_cents` BIGINT    NOT NULL DEFAULT 0,
  `tax_cents`       BIGINT      NOT NULL DEFAULT 0,
  `total_cents`     BIGINT      NOT NULL DEFAULT 0,
  `status`          ENUM('OPEN','IN_PROGRESS','COMPLETE','INVOICED','PAID','CANCELLED')
                      NOT NULL DEFAULT 'OPEN',
  `notes`           TEXT        NULL,
  INDEX `idx_mechanic`  (`mechanic_id`),
  INDEX `idx_customer`  (`customer_id`),
  INDEX `idx_plate`     (`vehicle_plate`),
  INDEX `idx_status`    (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
