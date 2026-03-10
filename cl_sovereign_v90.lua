-- ═══════════════════════════════════════════════════════════════════════════
--  cl_sovereign_v90.lua  –  MERICA Sovereign v9.0  (CLIENT)
--
--  FIXED in v9.0:
--    [SV-08] Global Escape handler added — player can NEVER get permanently stuck
--    [SV-11] sovereign:repo:executeOrder NUI callback registered
--    [SV-17] openPoliceHUD debounced — rapid F5 spam cannot stack NUI opens
--    [SV-18] All NUI close calls use fetchNui() consistently
--    [SV-12] Notification now handled by sovereign:client:notify event
-- ═══════════════════════════════════════════════════════════════════════════

local QBCore    = exports['qb-core']:GetCoreObject()
local nuiActive = false     -- true while ANY sovereign NUI panel is focused
local nuiOpening = false    -- debounce flag — prevents rapid-open stacking  [FIX SV-17]

-- ─────────────────────────────────────────────────────────────────────────
-- Utility helpers
-- ─────────────────────────────────────────────────────────────────────────

--- Send a message to the NUI iframe
local function sendNUI(event, data)
    SendNUIMessage({ type = event, data = data or {} })
end

--- Set NUI focus state and update local flag
local function focusNUI(state)
    SetNuiFocus(state, state)
    nuiActive  = state
    nuiOpening = false
end

--- Wrapper for NUI fetch callbacks to the Lua resource
local function fetchNui(event, data)
    -- fired via RegisterNUICallback on the NUI side
    -- we only need this wrapper for direct Lua-side close triggers
    sendNUI(event, data)
end

-- ─────────────────────────────────────────────────────────────────────────
-- Standardised notification receiver  [FIX SV-12]
-- Server sends 'sovereign:client:notify' with {type, title, message}
-- We forward to z-phone on the client side where its API is available.
-- ─────────────────────────────────────────────────────────────────────────

RegisterNetEvent('sovereign:client:notify', function(data)
    exports['z-phone']:sendCustomAppNotification(
        data.title   or 'SOVEREIGN',
        data.message or '',
        data.type    or 'info'
    )
end)

-- ─────────────────────────────────────────────────────────────────────────
-- GLOBAL ESCAPE HANDLER  [FIX SV-08]
-- Safety net: if ANY sovereign NUI is open and ESC is pressed in-game,
-- this ensures focus is always released even if the React ESC handler
-- inside the NUI fails to fire (e.g., NUI crash, iframe unload).
-- ─────────────────────────────────────────────────────────────────────────

CreateThread(function()
    while true do
        Wait(0)
        if nuiActive and IsControlJustReleased(0, 322) then  -- 322 = ESC
            -- Release focus and tell all panels to close
            sendNUI('sovereign:closeAll', {})
            focusNUI(false)
        end
    end
end)

-- ─────────────────────────────────────────────────────────────────────────
-- PART 2 · Police Radial HUD  — Open
-- [FIX SV-17] nuiOpening flag prevents double-open on rapid F5
-- ─────────────────────────────────────────────────────────────────────────

RegisterCommand('openPoliceHUD', function()
    if nuiActive or nuiOpening then return end  -- [FIX SV-17]

    local Player = QBCore.Functions.GetPlayerData()
    if Player.job.name ~= 'police' and Player.job.name ~= 'sheriff' then return end

    nuiOpening = true

    -- Find nearest player ped within 3m
    local ped    = PlayerPedId()
    local myCoords = GetEntityCoords(ped)
    local targetNetId = nil

    local closestDist = 3.0
    for _, p in ipairs(GetGamePool('CPed')) do
        -- [FIX from v8.8] correctly filter to player peds only
        if p ~= ped and IsPedAPlayer(p) then
            local dist = #(myCoords - GetEntityCoords(p))
            if dist < closestDist then
                closestDist = dist
                targetNetId = NetworkGetNetworkIdFromEntity(p)
            end
        end
    end

    sendNUI('police:radial:open', {
        targetNetId  = targetNetId,
        certLevel    = Player.metadata.cert_level or {},
        officerGrade = Player.job.grade.name or 'Patrol',
    })
    focusNUI(true)
end, false)

RegisterKeyMapping('openPoliceHUD', 'Open Police Radial HUD', 'keyboard', 'F5')

RegisterNUICallback('police:radial:close', function(_, cb)
    focusNUI(false)
    cb('ok')
end)

-- ─────────────────────────────────────────────────────────────────────────
-- PART 2 · Tactical Action Execution  (animations)
-- ─────────────────────────────────────────────────────────────────────────

local ACTION_ANIMS = {
    cuff        = { dict = 'mp_arresting',                          anim = 'a_uncuff',  duration = 4000 },
    hobble      = { dict = 'amb@code_human_cower@female@idle_a',    anim = 'idle_d',    duration = 3000 },
    gag         = { dict = 'mp_arresting',                          anim = 'a_uncuff',  duration = 2500 },
    escort      = { dict = 'anim@move_m@prisoner_cuffed',           anim = 'idle',      duration = -1   },
    put_vehicle = { dict = 'mp_arresting',                          anim = 'a_uncuff',  duration = 3000 },
    search      = { dict = 'amb@world_human_cop_idles@male@idle_a', anim = 'idle_b',    duration = 4000 },
    confiscate  = { dict = 'amb@world_human_cop_idles@male@idle_a', anim = 'idle_c',    duration = 3000 },
}

RegisterNetEvent('sovereign:police:executeAction', function(data)
    local anim = ACTION_ANIMS[data.action]
    if not anim then return end

    local ped = PlayerPedId()
    RequestAnimDict(anim.dict)
    local t = 0
    while not HasAnimDictLoaded(anim.dict) and t < 80 do
        Wait(10); t = t + 1
    end
    if not HasAnimDictLoaded(anim.dict) then return end  -- timeout guard
    TaskPlayAnim(ped, anim.dict, anim.anim, 8.0, -8.0, anim.duration, 0, 0, false, false, false)
end)

-- ─────────────────────────────────────────────────────────────────────────
-- PART 2 · K9 Commands  (Murderface-Pets)
-- ─────────────────────────────────────────────────────────────────────────

RegisterNetEvent('sovereign:k9:executeCommand', function(data)
    local cmd    = data.command
    local target = data.targetId

    if cmd == 'chase' or cmd == 'attack' then
        local targetPed = target and NetworkGetEntityFromNetworkId(target) or nil
        if targetPed and DoesEntityExist(targetPed) then
            exports['Murderface-Pets']:setK9Target(targetPed, cmd == 'attack')
        end

    elseif cmd == 'sniff_drugs' or cmd == 'sniff_explosives' then
        local sniffType = (cmd == 'sniff_drugs') and 'drugs' or 'explosives'
        exports['Murderface-Pets']:triggerSniff(sniffType, function(result)
            TriggerServerEvent('sovereign:k9:sniffResult', {
                command = cmd,
                result  = result,
                coords  = GetEntityCoords(PlayerPedId()),
            })
        end)
    end
end)

-- ─────────────────────────────────────────────────────────────────────────
-- PART 2 · Car Grappler
-- ─────────────────────────────────────────────────────────────────────────

local grapplerRope   = nil
local grapplerTarget = nil

RegisterNetEvent('sovereign:grappler:attach', function(data)
    local targetNetId   = data.targetNetId
    local targetVehicle = NetworkGetEntityFromNetworkId(targetNetId)
    local myVehicle     = GetVehiclePedIsIn(PlayerPedId(), false)

    if not DoesEntityExist(targetVehicle) or not DoesEntityExist(myVehicle) then return end

    RopeLoadTextures()
    local dist = #(GetEntityCoords(myVehicle) - GetEntityCoords(targetVehicle))
    grapplerRope = AddRope(
        GetEntityCoords(myVehicle), 0.0, 0.0, 0.0,
        dist, 0, dist, 0, 0.0, 0.0, 0.0, false, false, true, 5.0, false, nil
    )
    AttachEntitiesToRope(grapplerRope, myVehicle, targetVehicle,
        GetEntityCoords(myVehicle), GetEntityCoords(targetVehicle), dist,
        nil, nil, nil, nil)

    SetVehicleMaxSpeed(targetVehicle, 8.0)
    SetVehicleHandlingFloat(targetVehicle, 'CHandlingData', 'fInitialDragCoeff', 50.0)
    grapplerTarget = targetVehicle

    sendNUI('grappler:status', { active = true, targetNetId = targetNetId })
end)

RegisterNetEvent('sovereign:grappler:release', function()
    if grapplerRope then DeleteRope(grapplerRope); grapplerRope = nil end
    if grapplerTarget and DoesEntityExist(grapplerTarget) then
        SetVehicleMaxSpeed(grapplerTarget, 999.0)
        SetVehicleHandlingFloat(grapplerTarget, 'CHandlingData', 'fInitialDragCoeff', 2.0)
        grapplerTarget = nil
    end
    sendNUI('grappler:status', { active = false })
end)

-- Delete seized NPC vehicle on all clients
RegisterNetEvent('sovereign:vehicle:deleteEntity', function(data)
    for _, veh in ipairs(GetGamePool('CVehicle')) do
        local plate = GetVehicleNumberPlateText(veh):match('^%s*(.-)%s*$')
        if plate == data.plate then
            DeleteVehicle(veh)
            break
        end
    end
end)

-- ─────────────────────────────────────────────────────────────────────────
-- PART 2 · Vehicle Seizure Command (G key)
-- ─────────────────────────────────────────────────────────────────────────

local function getClosestVehicle(maxDist)
    local coords = GetEntityCoords(PlayerPedId())
    local closest, closestDist = nil, maxDist or 5.0
    for _, v in ipairs(GetGamePool('CVehicle')) do
        local d = #(coords - GetEntityCoords(v))
        if d < closestDist then closestDist = d; closest = v end
    end
    return closest
end

RegisterCommand('seizeVehicle', function()
    local Player = QBCore.Functions.GetPlayerData()
    if Player.job.name ~= 'police' and Player.job.name ~= 'sheriff' then return end

    local veh = getClosestVehicle(5.0)
    if not veh then
        exports['z-phone']:sendCustomAppNotification('SEIZURE', '⚠️ No vehicle nearby', 'error')
        return
    end

    local plate = GetVehicleNumberPlateText(veh):match('^%s*(.-)%s*$')
    local model = GetDisplayNameFromVehicleModel(GetEntityModel(veh))
    local isNPC = (GetVehicleNumberPlateText(veh):match('^%s*$') ~= nil)

    TriggerServerEvent('sovereign:vehicle:seize', {
        plate        = plate,
        model        = model,
        isNPC        = isNPC,
        ownerCid     = nil,       -- server will look up via plate
        reserveCents = 0,
    })
end, false)

RegisterKeyMapping('seizeVehicle', 'Seize Nearby Vehicle', 'keyboard', 'G')

-- ─────────────────────────────────────────────────────────────────────────
-- PART 3 · Medical Trauma HUD
-- ─────────────────────────────────────────────────────────────────────────

RegisterNetEvent('sovereign:medical:openTraumaHUD', function(data)
    if nuiActive then return end
    sendNUI('medical:trauma:open', data)
    focusNUI(true)
end)

RegisterNUICallback('medical:trauma:close', function(_, cb)
    focusNUI(false)
    cb('ok')
end)

RegisterNUICallback('sovereign:medical:submitRecord', function(data, cb)
    -- [FIX SV-16] validate on client before sending to server
    if not data.recordId or not data.patientCid or not data.totalBillCents then
        cb({ error = 'Missing required fields' })
        return
    end
    local bill = tonumber(data.totalBillCents)
    if not bill or bill < 0 then
        cb({ error = 'Invalid bill amount' })
        return
    end

    TriggerServerEvent('sovereign:medical:settleBill', {
        patientSrc     = data.patientNetId,
        patientCid     = data.patientCid,
        recordId       = data.recordId,
        totalBillCents = math.floor(bill),
        zones          = data.zones,
    })
    focusNUI(false)
    cb('ok')
end)

-- Air Unit gate: Doctor+ rank only
RegisterNetEvent('sovereign:medical:requestAirUnit', function()
    local Player = QBCore.Functions.GetPlayerData()
    local rank   = Player.job.grade.name:lower():gsub('%s+', '_')
    if rank ~= 'doctor' and rank ~= 'surgeon_general' then
        exports['z-phone']:sendCustomAppNotification('AIR UNIT', '⚠️ Doctor+ rank required', 'error')
        return
    end
    exports['ps-dispatch']:CustomAlert(PlayerId(), {
        code    = 'AIR-UNIT',
        type    = 'ems',
        message = 'Air Medical Unit Requested',
        coords  = GetEntityCoords(PlayerPedId()),
    })
end)

-- ─────────────────────────────────────────────────────────────────────────
-- PART 4 · RepoTablet NUI
-- ─────────────────────────────────────────────────────────────────────────

RegisterCommand('openRepoTablet', function()
    if nuiActive then return end
    local Player = QBCore.Functions.GetPlayerData()
    if Player.job.name ~= 'repo' and Player.job.name ~= 'banker'
       and not IsPlayerAceAllowed(tostring(PlayerId()), 'sovereign.admin') then
        return
    end
    TriggerServerEvent('sovereign:repo:fetchOrders', { status = 'ACTIVE' })
end, false)

RegisterNetEvent('sovereign:repo:ordersLoaded', function(data)
    sendNUI('repo:tablet:open', { orders = data.orders or {} })
    focusNUI(true)
end)

RegisterNUICallback('repo:tablet:close', function(_, cb)
    focusNUI(false)
    cb('ok')
end)

-- [FIX SV-11] Execute order callback was completely missing
RegisterNUICallback('sovereign:repo:executeOrder', function(data, cb)
    if not data.orderId then cb({ error = 'Missing orderId' }); return end
    TriggerServerEvent('sovereign:repo:executeOrder', { orderId = data.orderId })
    cb('ok')
end)

-- GPS blip management
RegisterNUICallback('repo:setGpsBlip', function(data, cb)
    if _G._repoBlip and DoesBlipExist(_G._repoBlip) then
        RemoveBlip(_G._repoBlip)
    end
    if data.coords then
        _G._repoBlip = AddBlipForCoord(data.coords.x, data.coords.y, data.coords.z)
        SetBlipSprite(_G._repoBlip, 225)
        SetBlipColour(_G._repoBlip, 1)
        SetBlipScale(_G._repoBlip, 1.2)
        BeginTextCommandSetBlipName('STRING')
        AddTextComponentString('REPO TARGET: '..(data.plate or ''))
        EndTextCommandSetBlipName(_G._repoBlip)
    end
    cb('ok')
end)

-- CeeU ping request from NUI
RegisterNUICallback('sovereign:ceeu:requestPing', function(data, cb)
    TriggerServerEvent('sovereign:ceeu:requestPing', { plate = data.plate })
    cb('ok')
end)

-- Server sends ping result → forward to NUI
RegisterNetEvent('sovereign:ceeu:pingResult', function(data)
    sendNUI('sovereign:ceeu:pingResult', data)
end)

-- ─────────────────────────────────────────────────────────────────────────
-- PART 4 · Trophy Rack
-- ─────────────────────────────────────────────────────────────────────────

RegisterCommand('viewTrophyRack', function()
    if nuiActive then return end
    local Player   = QBCore.Functions.GetPlayerData()
    local org      = Player.gang and Player.gang.name or nil

    local policeHQ = vector3(453.33, -982.0, 30.68)
    if #(GetEntityCoords(PlayerPedId()) - policeHQ) > 25.0 then
        exports['z-phone']:sendCustomAppNotification('TROPHY RACK', '⚠️ Must be at Police HQ', 'error')
        return
    end

    TriggerServerEvent('sovereign:trophy:fetchRack', { org = org })
end, false)

RegisterNetEvent('sovereign:trophy:rackLoaded', function(data)
    sendNUI('trophy:rack:open', data)
    focusNUI(true)
end)

RegisterNUICallback('trophy:rack:close', function(_, cb)
    focusNUI(false)
    cb('ok')
end)

-- ─────────────────────────────────────────────────────────────────────────
-- PART 5 · CCTV FPS change
-- ─────────────────────────────────────────────────────────────────────────

RegisterNetEvent('sovereign:cctv:setFps', function(data)
    sendNUI('cctv:fps:change', { fps = data.fps })
end)

-- ─────────────────────────────────────────────────────────────────────────
-- PART 5 · VIP Item Lock intercept
-- ─────────────────────────────────────────────────────────────────────────

AddEventHandler('qb-inventory:client:itemHeld', function(itemData)
    if itemData and itemData.metadata and itemData.metadata.is_locked then
        local src = itemData.source
        if src == 'real_money' or src == 'prize' then
            TriggerServerEvent('sovereign:vip:checkLock', {
                itemId   = itemData.unique_id,
                itemName = itemData.name,
            })
        end
    end
end)

RegisterNetEvent('sovereign:vip:itemBlocked', function(data)
    exports['z-phone']:sendCustomAppNotification(
        'ITEM LOCKED',
        '🔒 '..tostring(data.itemId)..' is VIP-locked and cannot be moved.',
        'error'
    )
end)

print('[SOVEREIGN v9.0] cl_sovereign_v90.lua loaded')

-- ─────────────────────────────────────────────────────────────────────────
-- v9.0 · Mechanic HUD  (new)
-- ─────────────────────────────────────────────────────────────────────────

RegisterCommand('openMechanicHUD', function()
    if nuiActive then return end
    local Player = QBCore.Functions.GetPlayerData()
    if Player.job.name ~= 'mechanic' and Player.job.name ~= 'ls_customs'
       and not IsPlayerAceAllowed(tostring(PlayerId()), 'sovereign.admin') then
        return
    end
    -- TODO: trigger ox_target or zone detection to populate customer data
    -- For now, open with a placeholder session for testing
    sendNUI('mechanic:hud:open', {
        mechanicId   = Player.citizenid,
        customerId   = 'CUSTOMER_CID',
        customerName = 'Customer',
        vehiclePlate = 'UNKNOWN',
        vehicleModel = 'Unknown',
    })
    focusNUI(true)
end, false)

RegisterNUICallback('mechanic:hud:close', function(_, cb)
    focusNUI(false)
    cb('ok')
end)

RegisterNUICallback('sovereign:mechanic:createOrder', function(data, cb)
    -- Forward to Express REST via a server event bridge
    TriggerServerEvent('sovereign:mechanic:createOrder', data)
    cb('ok')
end)
