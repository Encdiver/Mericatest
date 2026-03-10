-- ═══════════════════════════════════════════════════════════════════════════
--  fxmanifest.lua  –  merica_sovereign  v9.0
-- ═══════════════════════════════════════════════════════════════════════════

fx_version 'cerulean'
game      'gta5'

name        'merica_sovereign'
description 'MERICA Sovereign v9.0 – Treasury, Police HUD, Medical, Repo, Mechanic'
version     '9.0.0'
author      'MERICA RP Dev Team'

-- ── Server Lua ──────────────────────────────────────────────────────────
server_scripts {
    '@oxmysql/lib/MySQL.lua',
    'server/sv_sovereign/sv_sovereign_v90.lua',
}

-- ── Client Lua ──────────────────────────────────────────────────────────
client_scripts {
    'client/cl_sovereign_v90.lua',
}

-- ── NUI ─────────────────────────────────────────────────────────────────
ui_page 'html/index.html'

files {
    'html/index.html',
    'html/main.js',     -- Vite bundle of all React HUDs
    'html/main.css',    -- Compiled CSS (includes sovereign.css)
}

-- ── Exports to other resources ──────────────────────────────────────────
exports {
    'ulid',                  -- Generate a ULID from Lua
    'validateDepositCoords', -- Evidence deposit coord validator
    'settleMedicalBill',     -- Medical bill settlement (JS bridge)
}

-- ── Dependencies ────────────────────────────────────────────────────────
dependencies {
    'qb-core',
    'oxmysql',
    'ps-dispatch',
    'z-phone',
    'ps-mdt',
    'qb-vehiclekeys',
    'Murderface-Pets',
}

-- ── ConVars (set in server.cfg, NEVER here) ─────────────────────────────
--   set merica_server_secret  "change_me_in_server_cfg"
--   set merica_streamer_mode  0

-- ── ACE Permissions (add to server.cfg) ─────────────────────────────────
--   add_ace group.admin  sovereign.admin  allow
--   add_ace group.police sovereign.police allow
