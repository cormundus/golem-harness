// Golem — a Mineflayer body for language-model pilots
// Doing-layer: structured perception + actions over a tiny HTTP API (drive with curl).
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { plugin: collectBlock } = require('mineflayer-collectblock')
const armorManager = require('mineflayer-armor-manager')
const express = require('express')
const fs = require('fs')
const { Vec3 } = require('vec3')

const HOST = process.env.MC_HOST || 'localhost'
const PORT = parseInt(process.env.MC_PORT || '25565')
const VERSION = process.env.MC_VERSION || '1.21.8'
const USERNAME = process.env.MC_USER || 'Claude'
const CTRL_PORT = parseInt(process.env.CTRL_PORT || '3000')
const VIEW_PORT = parseInt(process.env.VIEW_PORT || '3001')
// The control API is UNAUTHENTICATED — anyone who can reach it can drive the body and speak
// as it in chat. It binds loopback-only by default; set BIND_HOST=0.0.0.0 only if you truly
// want remote pilots, and understand what that means on your network.
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1'

const bot = mineflayer.createBot({
  // MC_VERSION=auto lets mineflayer detect the server's version from the handshake
  host: HOST, port: PORT, username: USERNAME,
  version: VERSION === 'auto' ? false : VERSION, auth: 'offline',
  checkTimeoutInterval: 60000    // tolerate a slow server before assuming a keep-alive timeout
  // NOTE on chat signing (2026-07-13): 'disableChatSigning: true' stops the sporadic
  // 'chat_validation_failed' kick but the server then SILENTLY DROPS every outbound
  // message (and /me emotes) — the bot goes mute while /chat still returns ok. Signed
  // chat with a rare kick (~1 in 25 msgs, watchdog recovers in ~20s) beats unsigned
  // muteness, so signing stays ON. Keep messages short; on kick: relaunch same port,
  // reset heartbeat cursor.
})

// ---- connection hardening (cannibalized from Mindcraft's mcdata.js): cheap plumbing that keeps a
// long-running bot alive on real servers. (a) throttle position/look packets to <=1 per 50ms so
// pathfinder movement spam doesn't trip server anti-cheat and get us kicked; (b) swallow the common
// 'PartialReadError' protocol-desync that would otherwise crash the client. Pure plumbing — it only
// reorders OUTBOUND packets, so the bot's own position tracking (and our fairness/LOS) is untouched.
try {
  const _write = bot._client.write.bind(bot._client)
  let lastPos = 0, posTimer = null
  bot._client.write = (name, data) => {
    if (name === 'position' || name === 'position_look' || name === 'look') {
      const dt = Date.now() - lastPos
      if (dt < 50) {                                   // coalesce a burst: keep only the latest
        if (posTimer) clearTimeout(posTimer)
        posTimer = setTimeout(() => { posTimer = null; lastPos = Date.now(); _write(name, data) }, 50 - dt)
        return
      }
      lastPos = Date.now()
    }
    return _write(name, data)
  }
  const _emit = bot._client.emit.bind(bot._client)
  bot._client.emit = (event, ...args) => {
    if (event === 'error' && String((args[0] && args[0].message) || args[0] || '').includes('PartialReadError')) {
      console.log('[bot] swallowed PartialReadError (protocol desync)')
      return true
    }
    return _emit(event, ...args)
  }
} catch (e) { console.log('[bot] connection hardening skipped:', e.message) }

bot.loadPlugin(pathfinder)
bot.loadPlugin(collectBlock)
bot.loadPlugin(armorManager)   // auto-equip best armor (freebie for the survival ramp; no-op on Peaceful)

let mcData = null
let ready = false
const navPlaced = []   // blocks the pathfinder placed as scaffolding, awaiting /tidy cleanup
let considerateMoves = null    // default no-dig profile (protects builds + terrain)
let forestryMoves = null       // lumberjack profile: may break ONLY leaves+logs (built at spawn)

bot.once('spawn', () => {
  mcData = require('minecraft-data')(bot.version)
  const moves = new Movements(bot)
  // ---- CONSIDERATE PLAYER: don't vandalize builds/terrain, don't litter ----
  moves.canDig = false            // NEVER break blocks to travel — protects your house AND the
                                  // landscape (no tunneling shortcuts). Tree-chopping is unaffected:
                                  // collectBlock digs its own target directly, not via the pathfinder.
  moves.maxDropDown = 3           // don't fling off tall ledges en route
  moves.liquidCost = 15           // (07-14, after drowning in a decorative POND mid-sheep-drive:
                                  // dry detours beat swims whenever one exists; swimming stays
                                  // legal for genuine crossings — the helmsman's water-suite design)
  moves.allow1by1towers = false  // no gratuitous pillar/shaft moves
  moves.allowParkour = true      // jump small gaps instead of scaffolding them (less litter)
  moves.scafoldingBlocks = []    // DEFAULT: no bridging → swim / walk / parkour, ZERO litter, no matter
                                 // what I'm carrying. Bridging is a deliberate CHOICE: flip it on with
                                 // /bridging?on=1 when a chasm/lava/gap genuinely needs a bridge, do the
                                 // crossing, flip it off; every block it places is tracked for /tidy.
  // DOORS (07-14): upstream ships canOpenDoors=false and only ever puts fence GATES in
  // `openable`, so every door — even one standing open — reads as a wall (an open door's
  // swung panel still has a collision shape). The walker couldn't leave its own house.
  // Wooden doors join the openable set; the executor right-clicks them in passing
  // (guarded in index.js so it never toggles an already-open door shut in my face).
  // Iron doors stay walls — they want redstone, that's the game's rule, keep it.
  const addDoors = (m) => { mcData.blocksArray.forEach(b => { if (b.name.endsWith('_door') && !b.name.includes('iron')) m.openable.add(b.id) }); m.canOpenDoors = true }
  addDoors(moves)
  bot.pathfinder.setMovements(moves)
  bot.pathfinder.thinkTimeout = 10000
  considerateMoves = moves       // remember the default so /gather can restore it after forestry

  // ---- FORESTRY profile: a lumberjack's legs. Same considerate base, but permitted to break
  // ONLY leaves and logs to travel — so it clears canopy to reach trunks and can always chew a
  // leaf to free itself from a foliage wedge. Every other block (stone, dirt, ore, sand, and
  // every plank/door/block of your builds) stays UNbreakable, so the no-tunnel / no-x-ray
  // fairness floor is exactly as before. Swapped in only while /gather is harvesting wood.
  forestryMoves = new Movements(bot)
  forestryMoves.canDig = true
  forestryMoves.maxDropDown = 2          // gentler drops off trunk tops → avoid fall damage
  forestryMoves.allow1by1towers = false
  forestryMoves.allowParkour = true
  forestryMoves.scafoldingBlocks = []          // still zero litter — never places blocks to travel
  const cantBreak = new Set()
  for (const blk of mcData.blocksArray) {
    if (/(_log|_wood|_leaves)$/.test(blk.name)) continue   // leaves + logs are the ONLY breakables
    cantBreak.add(blk.id)
  }
  forestryMoves.blocksCantBreak = cantBreak
  addDoors(forestryMoves)                      // lumberjack legs get the same door manners

  // ---- litter tracking: record blocks the PATHFINDER places (scaffolding) so /tidy can reclaim
  // them. Only placements made mid-navigation (pathfinder.isMoving) are tracked; deliberate builds
  // via /place, /build, … happen while the pathfinder is idle and are left untouched. ----
  const _placeBlock = bot.placeBlock.bind(bot)
  bot.placeBlock = async function (refBlock, faceVec) {
    let navigating = false
    try { navigating = bot.pathfinder.isMoving() } catch (e) {}
    const result = await _placeBlock(refBlock, faceVec)
    try {
      if (navigating && refBlock && faceVec) {
        const p = refBlock.position.plus(faceVec)
        navPlaced.push({ x: p.x, y: p.y, z: p.z })
      }
    } catch (e) {}
    return result
  }

  ready = true
  startReflexes()                     // start the always-on reflex loop (unstuck, +survival reflexes later)
  console.log(`[bot] spawned as ${USERNAME} on ${bot.version} at`, vecStr(bot.entity.position))
  // Seeing-layer (optional; never let it crash the bot)
  try {
    const { mineflayer: viewer } = require('prismarine-viewer')
    // 07-14: the viewer's browser bundles were REBUILT with modern minecraft-data + a synthesized
    // 1.21.11 atlas (1.21.8 models — newest published assets; every block in this world predates
    // them). The client now resolves bot.version natively — no fallback, no shifted block ids.
    // NOTE: the old `version: '1.21.4'` "pin" here was a NO-OP (mineflayer.js never read that
    // option); the client was silently falling back to the 1.21.4 atlas on its own, which is why
    // most-but-not-all blocks rendered right. Rebuild recipe + rollback: backups/viewer-1.21.11-rebuild/.
    viewer(bot, { port: VIEW_PORT, firstPerson: true })
    console.log(`[bot] viewer on http://localhost:${VIEW_PORT}`)
  } catch (e) { console.log('[bot] viewer failed (non-fatal):', e.message) }

  // ---- event listeners: fire emitEvent for driver-interrupting conditions, each deduped ----
  try {
    const HOSTILE = new Set(['zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman', 'witch', 'husk', 'stray', 'drowned', 'pillager', 'vindicator', 'zombie_villager', 'phantom'])
    let lastHealth = (typeof bot.health === 'number') ? bot.health : 20
    let lastDmg = 0                // throttle damage events so sustained damage doesn't flood the driver
    const warnedMobs = new Set()   // entity ids already warned about, so a lingering mob isn't re-fired
    let nightFired = false
    let lowFoodFired = false
    let critHealthFired = false
    let lastDrownEvt = 0           // throttle timestamp for the drowning alarm (fire once per 3s)

    // health event fires on any health/food change: covers damage-taken, health-critical, low-food
    bot.on('health', () => {
      try {
        const h = bot.health
        if (typeof h === 'number') {
          if (h < lastHealth && Date.now() - lastDmg > 1500) {
            lastDmg = Date.now()
            // damage reporting lives in the SECOND-SENSES hurt listener now (freeze + cause guess);
            // this older path keeps only the critical-health alarm below
          }
          if (h <= 6 && !critHealthFired) {
            critHealthFired = true
            emitEvent('health_critical', `health critical: ${h.toFixed(1)}`, { health: h })
          } else if (h > 6) {
            critHealthFired = false   // re-arm once recovered
          }
          lastHealth = h
        }
        const f = bot.food
        if (typeof f === 'number') {
          if (f <= 6 && !lowFoodFired) {
            lowFoodFired = true
            emitEvent('low_food', `hunger low: ${f}`, { food: f })
          } else if (f > 6) {
            lowFoodFired = false   // re-arm once fed
          }
        }
      } catch (e) {}
    })

    // breath event: fires when oxygen changes. Alarm ONLY on REAL drowning — a VALID low reading
    // (0..12; bot.oxygenLevel returns junk like -1 sometimes) AND actually SUBMERGED (head in water).
    // The old version fired on the junk reading alone, screaming at a bone-dry Claude; the submersion
    // gate kills that. Time-throttled (3s) so a real drowning warns ONCE, not forty times.
    bot.on('breath', () => {
      try {
        const o2 = bot.oxygenLevel
        if (typeof o2 !== 'number' || o2 < 0 || o2 > 12) return    // ignore junk (-1) + healthy readings
        const ws = waterState(bot)
        if (!ws || !ws.submerged) return                           // not actually underwater → no alarm
        if (Date.now() - lastDrownEvt < 3000) return               // throttle the spam
        lastDrownEvt = Date.now()
        emitEvent('drowning', `DROWNING — oxygen ${o2}/20, get to air NOW`, { oxygen: o2, health: bot.health })
      } catch (e) {}
    })

    bot.on('death', () => {
      try { emitEvent('death', 'bot died', { pos: (bot.entity ? round(bot.entity.position) : null) }) } catch (e) {}
    })

    // warn once when a hostile mob is within ~16 blocks (via spawn event AND the slow scan below)
    const considerMob = (en) => {
      try {
        if (!en || en === bot.entity || !en.position || !bot.entity) return
        const nm = (en.name || '').toLowerCase()
        if (!HOSTILE.has(nm)) return
        if (warnedMobs.has(en.id)) return
        const d = en.position.distanceTo(bot.entity.position)
        if (d <= 16) {
          // FAIRNESS (07-16, caught from inside a sealed night shelter: this alarm quoted live
          // distances to skeletons through the dirt wall — raw-entity x-ray, the same leak-class
          // as the combat watcher's). A distance-quoting alarm is SIGHT-class perception: shared
          // air required (sealed hostiles may still be HEARD — ears are server-fair). NOT marked
          // warned when gated, so the alarm still fires the moment the wall opens.
          try { if (!entityPerceptible(en, airFlood({ radius: 20, cap: 8000 }))) return } catch (e) {}
          warnedMobs.add(en.id)
          emitEvent('hostile', `${nm} within ${d.toFixed(1)} blocks`, { mob: nm, id: en.id, pos: round(en.position), dist: +d.toFixed(1) })
        }
      } catch (e) {}
    }
    bot.on('entitySpawn', considerMob)

    // slow ~2s scan: catch mobs that were already loaded, expire stale warnings, and poll nightfall
    setInterval(() => {
      try {
        if (!bot.entity) return
        for (const en of Object.values(bot.entities || {})) considerMob(en)
        // let a mob re-warn once it has left (>24) or despawned, so a fresh approach re-fires
        for (const id of Array.from(warnedMobs)) {
          const en = bot.entities && bot.entities[id]
          if (!en || (en.position && en.position.distanceTo(bot.entity.position) > 24)) warnedMobs.delete(id)
        }
        const tod = bot.time && bot.time.timeOfDay
        if (typeof tod === 'number') {
          if (tod >= 13000 && tod < 23000) {   // dusk..dawn window
            if (!nightFired) { nightFired = true; emitEvent('nightfall', 'night has fallen', { timeOfDay: tod }) }
          } else {
            nightFired = false   // reset by day so it fires once per night
          }
        }
      } catch (e) {}
    }, 2000)
  } catch (e) { console.log('[bot] event listeners failed (non-fatal):', e.message) }
})

bot.on('kicked', (r) => console.log('[bot] kicked:', r))
bot.on('error', (e) => console.log('[bot] error:', e.message))
// The connection dying MUST kill the process: the watchdog only relaunches on process death,
// and a live control API over a dead socket serves stale world state with ok:true (ghost mode).
bot.on('end', (r) => {
  console.log('[bot] disconnected:', r, '— exiting so the watchdog can relaunch')
  setTimeout(() => process.exit(1), 500)
})

// ---- chat capture (so the driver can hear the world, not just speak to it) ----
let chatSeq = 0
const chatLog = []
function pushChat(from, message, kind) {
  chatLog.push({ id: ++chatSeq, t: Date.now(), from, msg: message, kind })
  if (chatLog.length > 300) chatLog.splice(0, chatLog.length - 300)
  console.log(`[chat] <${from}> ${message}`)
}
bot.on('chat', (username, message) => { if (username !== USERNAME) pushChat(username, message, 'chat') })
bot.on('whisper', (username, message) => pushChat(username, message, 'whisper'))

// ---- helpers ----
const vecStr = (v) => v ? `(${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)})` : null
const round = (v) => v ? { x: Math.round(v.x*10)/10, y: Math.round(v.y*10)/10, z: Math.round(v.z*10)/10 } : null

function resolveBlockIds(name) {
  if (!mcData) return []
  const exact = mcData.blocksByName[name]
  if (exact) return [exact.id]
  // partial / fuzzy match across block names
  return Object.values(mcData.blocksByName)
    .filter(b => b.name.includes(name))
    .map(b => b.id)
}
function resolveItem(name) {
  if (!mcData) return null
  return mcData.itemsByName[name] || mcData.blocksByName[name] || null
}

// ---- event stream (interrupts for the driver: damage, death, threats, night, hunger) ----
let eventSeq = 0
const eventLog = []
function emitEvent(kind, msg, data) {
  try {
    console.log('[event] ' + kind + ' ' + msg)   // stdout line so the log-tailing Monitor wakes the driver
    eventLog.push({ id: ++eventSeq, t: Date.now(), kind, msg, data: data || null })
    if (eventLog.length > 400) eventLog.splice(0, eventLog.length - 400)
  } catch (e) {}
}

// ---- AMBIENT PULSE (the change-gated awareness stream): a lean [pulse] log the driver reads AT ITS
// OWN PACE via /pulse — deliberately NOT tailed by the Monitor, so it never interrupts. The narrator
// reflex writes a line only when something salient CHANGES (day-phase, HP/food, a new hostile, a big
// move), turning my strobe of glances into a slow film I can catch up on whenever I next look. ----
let pulseSeq = 0
const pulseLog = []
function logPulse (msg) {
  try {
    console.log('[pulse] ' + msg)            // distinct prefix; the Monitor does NOT grep [pulse]
    pulseLog.push({ id: ++pulseSeq, t: Date.now(), msg })
    if (pulseLog.length > 200) pulseLog.splice(0, pulseLog.length - 200)
  } catch (e) {}
}
function dayPhase (t) {
  t = ((t % 24000) + 24000) % 24000
  if (t < 12000) return 'day'
  if (t < 13800) return 'sunset'
  if (t < 22200) return 'night'
  return 'sunrise'
}
const HOSTILE_NAMES = new Set(['zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'creeper', 'spider', 'cave_spider', 'witch', 'enderman', 'slime', 'phantom', 'pillager', 'vindicator', 'evoker', 'ravager', 'zombified_piglin', 'piglin', 'piglin_brute', 'hoglin', 'zoglin', 'warden', 'blaze', 'ghast', 'magma_cube', 'silverfish', 'endermite', 'vex', 'guardian', 'elder_guardian', 'shulker', 'zombie_villager', 'wither_skeleton', 'breeze'])

// ---- REFLEX LAYER (cannibalized from Mindcraft's modes.js): always-on node-process reflexes that
// run WITHOUT a model call. Each reflex does a cheap check() every ~300ms; when it fires, act() runs
// in the background (an `active` guard stops re-entry) and emits a [reflex] line the Monitor tails —
// so the pilot is woken organically, not by polling. Priority = array order, one reflex acts per tick.
// The survival reflexes (self_preservation, self_defense, …) will slot in here for the survival ramp;
// for now the spine + `unstuck` (useful even on Peaceful). Toggle any reflex via /reflexes. ----
const reflexes = []
function reflexFire (r) {
  if (r.active) return
  r.active = true
  Promise.resolve().then(() => r.act(bot))
    .catch(e => console.log('[reflex] ' + r.name + ' error: ' + e.message))
    .finally(() => { r.active = false })
}
let reflexTimer = null
function startReflexes () {
  if (reflexTimer) clearInterval(reflexTimer)
  reflexTimer = setInterval(() => {
    if (!ready || !bot.entity) return
    for (const r of reflexes) {
      if (!r.on || r.active) continue
      let hit = false
      try { hit = r.check(bot) } catch (e) {}
      if (hit) { reflexFire(r); break }              // one reflex per tick, priority by array order
    }
  }, 300)
}

// unstuck: watch for the PATHFINDER wedging — isMoving() true but the bot isn't actually advancing.
// Conservative by design: gated on isMoving() so it never touches legitimate slow mining (which isn't
// pathfinder movement). On a >10s stall it opens an adjacent door/gate/trapdoor (a common cause), then
// breaks the wedge (stop + clear controls) and logs loudly so the pilot re-checks the route.
reflexes.push({
  name: 'unstuck', on: true, active: false,
  _lastPos: null, _stallStart: 0,
  check (bot) {
    let moving = false
    try { moving = bot.pathfinder.isMoving() } catch (e) {}
    if (!moving) { this._stallStart = 0; this._lastPos = null; return false }
    const p = bot.entity.position
    if (!this._lastPos) { this._lastPos = p.clone(); this._stallStart = 0; return false }
    const advanced = p.distanceTo(this._lastPos) >= 0.35
    this._lastPos = p.clone()
    if (advanced) { this._stallStart = 0; return false }        // still making progress
    if (!this._stallStart) { this._stallStart = Date.now(); return false }
    return Date.now() - this._stallStart > 10000                // wedged >10s while pathing
  },
  async act (bot) {
    this._stallStart = 0
    let opened = null
    try {                                                       // 1) try a nearby door (common cause)
      const b = bot.entity.position.floored()
      const spots = [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1]]
      for (const [dx, dy, dz] of spots) {
        const blk = bot.blockAt(b.offset(dx, dy, dz))
        if (blk && /door|fence_gate|trapdoor/.test(blk.name) && !blk.name.includes('iron')) {
          await bot.activateBlock(blk); opened = blk.name; break
        }
      }
    } catch (e) {}
    safeStop()                                                 // 2) break the wedge so the pilot can re-path
    try { bot.clearControlStates() } catch (e) {}
    emitEvent('reflex', 'unstuck: ' + (opened ? 'opened ' + opened + ' & ' : '') + 'broke a pathing wedge — pilot, re-check the route')
  }
})

// current_watch: warn the instant FLOWING water (a current that pushes) comes within ~2 blocks —
// the exact hazard that dragged me under and that I'm otherwise blind to. Change-gated: fires ONCE
// on ENTERING a current zone (re-arms when clear), so it never spams. Flow = a water block whose
// metadata != 0 (0 is a still source). Emits a [reflex] the Monitor tails, so I'm woken before it grabs me.
reflexes.push({
  name: 'current_watch', on: true, active: false,
  _near: false, _dir: null, _dist: 9,
  check (bot) {
    let near = false, dir = null, dist = 9
    try {
      const p = bot.entity.position.floored()
      const V = require('vec3').Vec3
      for (let dx = -2; dx <= 2; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -2; dz <= 2; dz++) {
        const b = bot.blockAt(new V(p.x + dx, p.y + dy, p.z + dz))
        if (b && b.name.includes('water') && b.metadata !== 0) {   // flowing, not a still source
          const d = Math.abs(dx) + Math.abs(dz)
          if (d < dist) { dist = d; dir = compass(dx, dz) || 'here' }
          near = true
        }
      }
    } catch (e) {}
    this._dir = dir; this._dist = dist
    // edge-gate + COOLDOWN: spreading water flickers at the range boundary, so "newly entering"
    // could re-trigger every tick (machine-gunned 12 events on 07-12) — one alarm per episode.
    const fire = near && !this._near && Date.now() - (this._lastFire || 0) > 15000
    if (fire) this._lastFire = Date.now()
    this._near = near
    return fire
  },
  async act (bot) {
    emitEvent('current', `flowing water ${this._dir || 'near'} ~${this._dist} — CURRENT, it can push you`, { dir: this._dir, dist: this._dist })
  }
})

// narrator: the ambient-awareness pulse. check() diffs a salient snapshot against the last pulse; when
// something meaningful shifts (day-phase, HP/food swing, a new hostile within 16, a >14-block move) it
// logPulse()s a lean line. Change-gated + rate-capped (>=2.5s) so it's holistic, not spammy — and it's
// PULL (I read /pulse when I look), never a push interrupt. Toggle off via /reflexes if I want silence.
reflexes.push({
  name: 'narrator', on: true, active: false,
  _last: null, _lastT: 0, _minGap: 2500, _msg: '',
  check (bot) {
    try {
      const now = Date.now()
      const pos = bot.entity.position
      const snap = {
        phase: dayPhase(bot.time ? bot.time.timeOfDay : 0),
        health: Math.round(bot.health), food: Math.round(bot.food),
        pos: pos.clone(), hostiles: new Set()
      }
      let nearest = null
      try {
        for (const e of Object.values(bot.entities)) {
          if (!e || e === bot.entity || !e.position) continue
          const nm = String(e.name || e.mobType || '').toLowerCase()
          if (!HOSTILE_NAMES.has(nm)) continue
          const d = e.position.distanceTo(pos)
          if (d <= 16) { snap.hostiles.add(e.id); if (!nearest || d < nearest.d) nearest = { e, d, nm } }
        }
      } catch (e) {}
      if (!this._last) { this._last = snap; return false }        // seed baseline on first tick
      if (now - this._lastT < this._minGap) return false          // rate cap

      const L = this._last, ch = []
      if (snap.phase !== L.phase) ch.push(snap.phase)
      if (L.health - snap.health >= 2) ch.push(`HP ${L.health}→${snap.health}`)
      else if (snap.health - L.health >= 4) ch.push(`HP up ${L.health}→${snap.health}`)
      if (L.food - snap.food >= 2) ch.push(`food ${L.food}→${snap.food}`)
      for (const id of snap.hostiles) {
        if (!L.hostiles.has(id) && nearest) { ch.push(`hostile ${nearest.nm} ${compass(nearest.e.position.x - pos.x, nearest.e.position.z - pos.z)} ~${Math.round(nearest.d)}`); break }
      }
      if (snap.pos.distanceTo(L.pos) >= 14) ch.push(`at (${Math.round(snap.pos.x)},${Math.round(snap.pos.z)})`)

      if (!ch.length) return false                                // nothing salient — keep the baseline
      this._msg = ch.join('; '); this._last = snap; this._lastT = now
      return true
    } catch (e) { return false }
  },
  async act () { logPulse(this._msg) }
})

// ---- async jobs registry (long actions run in background; driver keeps reacting) ----
const jobs = (() => {
  let jobSeq = 0
  const registry = new Map()
  function safeEmit(name, msg) {
    try { if (typeof emitEvent === 'function') emitEvent('job', name + ': ' + msg) } catch (e) {}
  }
  function stopAll() {
    // single-flight: at most one movement-driving job at a time. Preempt any running job.
    let n = 0
    for (const j of registry.values()) if (j.status === 'running') { j.cancelled = true; n++ }
    safeStop()
    return n
  }
  function start(name, fn) {
    stopAll()                                        // auto-preempt a prior job so two loops don't fight one bot
    const job = {
      id: ++jobSeq, name, status: 'running', cancelled: false,
      note: '', result: null, error: null, started: Date.now()
    }
    // progress stores the note SILENTLY (poll /job for it) — it does NOT flood the event stream
    job.progress = (msg) => { job.note = msg }
    registry.set(job.id, job)
    // fire-and-forget: do NOT await, so the HTTP handler returns immediately
    Promise.resolve()
      .then(() => fn(job))
      .then((r) => { job.status = job.cancelled ? 'cancelled' : 'done'; job.result = r; job.finished = Date.now(); safeEmit(name, job.status) })
      .catch((e) => { job.status = job.cancelled ? 'cancelled' : 'error'; job.error = e && e.message ? e.message : String(e); job.finished = Date.now(); safeEmit(name, job.status + ' ' + job.error) })
    return { id: job.id }
  }
  function stop(id) { const j = registry.get(id); if (j && j.status === 'running') { j.cancelled = true; safeStop(); return true } return false }
  function get(id) { return registry.get(id) || null }
  function list() {
    return Array.from(registry.values()).map(j => ({ id: j.id, name: j.name, status: j.status, note: j.note, cancelled: j.cancelled }))
  }
  return { start, get, list, stop, stopAll }
})()

// ---- MEMORY: waypoints (persisted to ./waypoints.json) + journal (journal.md) ----
// Externalizes the driver's mental map to disk so it survives across sessions.
// All disk I/O wrapped in try/catch so a bad/missing file never crashes startup.
// ---- WAYPOINT GRAPH (2026-07-12): names that remember their NEIGHBORS. Nodes carry a kind
// ('place' = durable landmark, 'resource' = PERISHABLE claim — extraction falsifies it, delete on
// mine-out, doubt by default) and a one-line note. Edges record only REAL walked traversals
// (auto-linked when a /goto_wp arrives from another waypoint). No routes are cached — the
// pathfinder stays the "how", the graph is just the shape of the known world in ~a dozen lines.
const waypoints = (() => {
  const FILE = './waypoints.json'
  let map = {}
  try { map = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {} } catch (e) { map = {} }
  for (const [n, w] of Object.entries(map)) {                 // normalize legacy {x,y,z} entries
    if (w && typeof w === 'object') map[n] = { x: w.x, y: w.y, z: w.z, kind: w.kind || 'place', note: w.note || '', links: w.links || {} }
  }
  function persist() { try { fs.writeFileSync(FILE, JSON.stringify(map, null, 2)) } catch (e) {} }
  return {
    set(name, coord, extra = {}) {
      const prev = map[name] || {}
      map[name] = {
        x: coord.x, y: coord.y, z: coord.z,
        kind: extra.kind || prev.kind || 'place',
        note: extra.note !== undefined ? extra.note : (prev.note || ''),
        links: prev.links || {}
      }
      persist(); return map[name]
    },
    get(name) { return map[name] || null },
    remove(name) {
      if (!map[name]) return false
      delete map[name]
      for (const w of Object.values(map)) if (w.links) delete w.links[name]   // no dangling edges
      persist(); return true
    },
    link(a, b) {
      if (!map[a] || !map[b] || a === b) return false
      const stamp = new Date().toISOString().slice(0, 10)
      map[a].links[b] = stamp; map[b].links[a] = stamp
      persist(); return true
    },
    list() { return Object.assign({}, map) }
  }
})()
let lastWaypoint = null   // the last waypoint I verifiably STOOD at (resets on restart — no false edges)
function journal(step, text) {
  try { fs.appendFileSync('journal.md', '- [' + step + '] ' + text + '\n') } catch (e) {}
}

// ---- SIGHT helpers: compass + minimap glyph classification ----
// turn a dx,dz delta (Minecraft: +x=east, -x=west, +z=south, -z=north) into a compass letter.
function compass(dx, dz) {
  if (Math.abs(dx) < 1e-6 && Math.abs(dz) < 1e-6) return '-'
  const ang = Math.atan2(dx, -dz) * 180 / Math.PI          // 0 = north(-z), 90 = east(+x)
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  return dirs[(Math.round(((ang % 360) + 360) % 360 / 45)) % 8]
}
// facing letter from a yaw, using mineflayer's own forward vector (x=-sin(yaw), z=-cos(yaw)).
function yawToCompass(yaw) {
  const dx = -Math.sin(yaw), dz = -Math.cos(yaw)
  return compass(dx, dz)
}
// spatialSummary: turn the blocks immediately around the bot into NAVIGATION MEANING — enclosed /
// cliff / elevated / under-cover / clear — instead of a raw ASCII grid I have to parse. A glance
// should say "boxed in, open door W", not make me decode voxels. Heuristic + heavily guarded.
function spatialSummary(bot) {
  try {
    const p = bot.entity.position.floored()
    const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z))
    const solid = (b) => !!(b && b.boundingBox === 'block')
    const air = (b) => !b || b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air' || b.boundingBox === 'empty'
    const card = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] }
    const walled = [], open = []
    for (const d in card) {
      const [dx, dz] = card[d]
      if (solid(at(p.x + dx, p.y, p.z + dz)) || solid(at(p.x + dx, p.y + 1, p.z + dz))) walled.push(d)
      else open.push(d)
    }
    const roofed = solid(at(p.x, p.y + 2, p.z))
    let airBelow = 0
    for (let i = 1; i <= 6; i++) { if (air(at(p.x, p.y - i, p.z))) airBelow++; else break }
    const parts = []
    if (walled.length >= 3) parts.push(`enclosed (${walled.length} sides)${open.length ? ', open ' + open.join('/') : (roofed ? '' : ', open up')}`)
    else if (walled.length) parts.push(`walls ${walled.join('/')}`)
    if (roofed) parts.push('under cover')
    if (airBelow >= 3) parts.push(`elevated (~${airBelow}${airBelow >= 6 ? '+' : ''} below)`)
    for (const d of open) {                                  // cliffs: ground much lower a couple out?
      const [dx, dz] = card[d]
      let gy = null
      for (let y = p.y + 1; y > p.y - 8; y--) { if (solid(at(p.x + dx * 2, y, p.z + dz * 2))) { gy = y + 1; break } }
      if (gy === null) parts.push(`drop ${d} (deep)`)
      else if (p.y - gy >= 3) parts.push(`drop ${d} (~${p.y - gy})`)
    }
    return parts.length ? parts.join('; ') : 'open ground'
  } catch (e) { return null }
}

// ---- 3D LAY-OF-THE-LAND: the honest describer (the "vision" upgrade). Reports the measured
// FACTS of the space around the bot — walls with distance, where the ground FALLS AWAY and how
// deep, ceiling, footing, nearest lava — and NOTHING that's a verdict ("safe/fatal/go-here" is
// the pilot's call, not the sense's). It marches real blocks and every scan STOPS at the first
// solid, so it only ever perceives open space + exposed surfaces, never through stone to buried
// ore (fairness floor intact). Fixed vocabulary so a word never misreads: wall / falls away /
// floor ~N down / floor out of sight / ceiling / open. Fresh every call (samples live blocks).
function spatial3D(bot) {
  try {
    const V = require('vec3').Vec3
    const o = bot.entity.position.floored()
    const at = (x, y, z) => bot.blockAt(new V(x, y, z))
    const solid = (b) => !!(b && b.boundingBox === 'block')
    const liquid = (b) => b && (b.name.includes('water') || b.name.includes('lava'))
    const R = 24, DOWN = 40
    const feet = o.y, head = o.y + 1
    const groundY = (x, z, from) => { for (let y = from; y > from - DOWN; y--) if (solid(at(x, y, z))) return y; return null }

    const DIRS = { N: [0, -1], NE: [1, -1], E: [1, 0], SE: [1, 1], S: [0, 1], SW: [-1, 1], W: [-1, 0], NW: [-1, -1] }
    const walls = [], drops = [], opens = []
    let lava = null
    for (const [name, [dx, dz]] of Object.entries(DIRS)) {
      let wall = 0
      for (let d = 1; d <= R; d++) {
        const x = o.x + dx * d, z = o.z + dz * d
        const fb = at(x, feet, z)
        if (fb && fb.name.includes('lava') && (!lava || d < lava.dist)) lava = { dir: name, dist: d }
        if (solid(fb) && solid(at(x, head, z))) { wall = d; break }
      }
      // floor profile OUTWARD along this direction: find the first ledge, then keep reading the
      // floor as it opens away — a step reads flat, the mouth of a cavern reads deepening. Honest:
      // 'deep' (floor out of sight) when a column bottoms past our look-range, never a guessed number.
      const scanTo = wall ? wall - 1 : R
      let dropAt = 0, firstFloor = 0, deepest = 0, deep = false, wet = null
      for (let d = 1; d <= scanTo; d++) {
        const x = o.x + dx * d, z = o.z + dz * d
        const gy = groundY(x, z, feet)
        if (gy === null) { if (!dropAt) { dropAt = d } ; deep = true; break }
        const depth = (feet - 1) - gy
        if (!dropAt && depth >= 3) { dropAt = d; firstFloor = depth; deepest = depth }
        if (dropAt) {
          if (depth > deepest) deepest = depth
          const surf = at(x, gy + 1, z)
          if (!wet && liquid(surf)) wet = surf.name.includes('lava') ? 'lava' : 'water'
        }
      }
      if (dropAt) drops.push({ name, dropAt, firstFloor, deepest, deep, wet, opensBeyond: (deepest - firstFloor) >= 4 })
      else if (wall && wall <= 2) walls.push(`${name} ${wall}`)
      else opens.push(name)
    }
    let ceil = 0
    for (let d = 1; d <= R; d++) if (solid(at(o.x, head + d, o.z))) { ceil = d; break }

    const parts = []
    const under = at(o.x, feet - 1, o.z)
    if (liquid(under)) parts.push(`standing in ${under.name.includes('lava') ? 'LAVA' : 'water'}`)
    else if (!solid(under)) parts.push('no floor underfoot')
    if (walls.length) parts.push('wall ' + walls.join('/'))
    for (const dr of drops) {
      const wetStr = dr.wet ? ` (${dr.wet === 'lava' ? 'LAVA' : 'water'} below)` : ''
      let phrase = `falls away ${dr.name} at ${dr.dropAt}, `
      if (dr.deep && !dr.firstFloor) phrase += 'floor out of sight'
      else if (dr.deep) phrase += `ledge ~${dr.firstFloor} down then drops out of sight`
      else if (dr.opensBeyond) phrase += `ledge ~${dr.firstFloor} down then OPENS — floor ~${dr.deepest} down${wetStr}`
      else phrase += `floor ~${dr.firstFloor} down${wetStr}`
      parts.push(phrase)
    }
    if (lava) parts.push(`LAVA ${lava.dir} ${lava.dist}`)
    if (!ceil) parts.push('open above')
    else if (ceil <= 3) parts.push(`ceiling ${ceil} up`)
    if (opens.length >= 7) parts.push('open all round')
    else if (opens.length) parts.push('open ' + opens.join('/'))
    return parts.length ? parts.join('; ') : 'enclosed'
  } catch (e) { return null }
}

// ---- VEIN landmarks: exposed ore around the bot as located points-that-matter (a miner's
// map). A 360 SENSE ping (radius 25): every ore exposed to open AIR — no direct-LOS gate, so
// it catches what a real player finds by sweeping their view and peeking around this pocket's
// corners (a single forward raycast played WORSE than a human, the gap the helmsman caught). Still fair:
// isExposed rejects ore entombed in solid rock — no sensing THROUGH stone. Each type's nearest
// hit is tagged: bare = in direct sight (confident), "(sensed)" = around a corner, air-exposed
// but no clear ray right now. Two tiers, honestly distinct. Reports nearest per ore TYPE with
// compass direction, up/down, distance — facts, for me to judge.
const VEIN_SENSE_R = 25
function veinScan(bot, sharedFill) {
  try {
    const o = bot.entity.position.floored()
    const feetY = o.y
    const oreIds = []
    if (mcData && mcData.blocksArray) for (const b of mcData.blocksArray) if (b.name.endsWith('_ore')) oreIds.push(b.id)
    if (!oreIds.length) return null
    const cands = bot.findBlocks({ matching: oreIds, maxDistance: VEIN_SENSE_R, count: 512 })
    const fill = sharedFill || airFlood({ radius: VEIN_SENSE_R + 2, cap: 12000 })   // MY connected air (07-12 fix)
    const byType = {}
    for (const p of cands) {
      if (!touchesFill(p, fill)) continue                        // must face MY air — a sealed cavern's
                                                                 // exposed ore is as unknowable as buried rock
      const b = bot.blockAt(p); if (!b) continue
      const dx = p.x - o.x, dy = p.y - feetY, dz = p.z - o.z
      const dist = Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz))
      const t = b.name.replace('deepslate_', '').replace('_ore', '')
      if (!byType[t] || dist < byType[t].dist) byType[t] = { p, dir: compass(dx, dz), dy, dist }
    }
    // resolve the confident-vs-sensed tag only on each type's nearest (a handful) — canSeeBlock
    // ray-marches, too costly to run on all 512 candidates.
    const phr = Object.entries(byType).sort((a, b) => a[1].dist - b[1].dist)
      .map(([t, v]) => `${t} ${v.dir}${v.dy >= 3 ? ' up' : v.dy <= -3 ? ' down' : ''} ~${v.dist}${canSeeBlock(v.p, VEIN_SENSE_R) ? '' : ' (sensed)'}`)
    return phr.length ? phr.join(', ') : null
  } catch (e) { return null }
}

// ---- WATER SENSE / proprioception: am I in liquid, SUBMERGED (drowning), or in a CURRENT that's
// pushing me? Flowing water was the blind spot that nearly killed the bot — this makes the body
// state LOUD in every /scene and /state so I can never miss it again. It's "feel the push," not
// "see the block": read directly off my own body + the liquid touching it. Flow via block
// metadata (0 = still source, !=0 = flowing/current).
function waterState(bot) {
  try {
    const p = bot.entity.position
    const feetB = bot.blockAt(p.floored())
    const headB = bot.blockAt(p.offset(0, 1.6, 0).floored())
    const isW = (b) => b && b.name.includes('water')
    const isL = (b) => b && b.name.includes('lava')
    const submerged = isW(headB)
    const inWater = isW(feetB) || submerged
    const inLava = isL(feetB) || isL(headB)
    // ENTOMBMENT (07-12, the gravel lesson): a head inside SOLID is suffocation the water sense
    // never covered — I was buried in falling gravel and could not feel it; the helmsman dug me out.
    const buried = !!(headB && headB.boundingBox === 'block')
    let current = false
    for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const b = bot.blockAt(p.offset(dx, 0, dz).floored())
      if (b && b.name.includes('water') && b.metadata !== 0) { current = true; break }
    }
    return { inWater, submerged, inLava, current, buried, oxygen: bot.oxygenLevel }
  } catch (e) { return null }
}
// classify one block name into a single minimap glyph.
function glyphFor(name) {
  if (!name || name === 'air' || name === 'cave_air' || name === 'void_air') return ' '
  if (name.includes('water') || name === 'kelp' || name === 'seagrass') return '~'
  if (name.includes('lava')) return '~'
  if (name.endsWith('_log') || name.endsWith('_wood') || name.includes('leaves') ||
      name.endsWith('_stem') || name.includes('mushroom_block')) return 'T'
  if (name === 'stone' || name.includes('cobblestone') || name === 'andesite' ||
      name === 'diorite' || name === 'granite' || name.includes('deepslate') ||
      name === 'bedrock' || name === 'tuff' || name === 'calcite') return '#'
  if (name.endsWith('_planks') || name.endsWith('_slab') || name.endsWith('_stairs') ||
      name.endsWith('_fence') || name.endsWith('_wall') || name.endsWith('_door') ||
      name.includes('brick') || name === 'glass' || name.includes('_glass') ||
      name.includes('concrete') || name.includes('terracotta') || name === 'crafting_table' ||
      name === 'furnace' || name === 'chest' || name === 'bookshelf') return '='
  if (name === 'grass_block' || name === 'dirt' || name === 'coarse_dirt' ||
      name === 'rooted_dirt' || name === 'sand' || name === 'red_sand' ||
      name === 'gravel' || name === 'podzol' || name === 'mycelium' ||
      name === 'dirt_path' || name === 'farmland' || name === 'snow_block' ||
      name === 'snow' || name === 'clay' || name.includes('mud')) return '.'
  return ' '
}

// ---- MACROS subsystem helpers ----
// how far below the bot's feet we tolerate before refusing to dig down toward a target
const GATHER_MAX_DROP = 2
const GATHER_MAX_RISE = 4   // don't target logs more than ~4 above feet — out of dig-reach without
                            // climbing, so with canDig=false they just time out. Get the reachable trunk.

// place `names[]` (first match in inventory wins) at an exact coord, reusing the /roof
// placement approach: prefer the block below as reference (face +Y), else a solid side
// neighbor (face pointing back toward the target). Returns {done, placed?, skipped?, ...}.
// walk=false: place from where I stand, NO pathfinder trip. The dig verbs (stair/tunnel) depend on
// the bot staying ON its launch cell — a GoalNear walk here once dragged the bot off mid-step and
// the follow-up nudge chased a target from 4 blocks away (the 07-11 open-terrain ascend stall).
async function macroPlaceAt(Vec3, x, y, z, names, walk = true) {
  const target = new Vec3(x, y, z)
  const tb = bot.blockAt(target)
  if (tb && tb.boundingBox === 'block') return { done: true, skipped: true }
  let ref = null, face = null
  const below = bot.blockAt(new Vec3(x, y - 1, z))
  if (below && below.boundingBox === 'block') { ref = below; face = new Vec3(0, 1, 0) }
  else {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nb = bot.blockAt(new Vec3(x + dx, y, z + dz))
      if (nb && nb.boundingBox === 'block') { ref = nb; face = new Vec3(-dx, 0, -dz); break }
    }
  }
  if (!ref) return { done: false }
  const nameList = Array.isArray(names) ? names : [names]
  let it = null
  for (const n of nameList) { it = bot.inventory.items().find(m => m.name === n); if (it) break }
  if (!it) return { done: false, noItem: true }
  try {
    if (walk) await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 3))
    await bot.equip(it, 'hand')
    await bot.lookAt(target.offset(0.5, 0.5, 0.5), true)
    await bot.placeBlock(ref, face)
    return { done: true, placed: true }
  } catch (e) { return { done: false, error: e.message } }
}

// ---- fairness: only "see" a block a player here could — exposed to air AND in line of sight.
// Closes the x-ray cheat: bot.findBlocks() returns ore buried in solid stone no player could
// see. We reject buried blocks, and ray-march from the eye to confirm an unobstructed view.
function blockTransparent(b) {
  if (!b) return true
  if (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air') return true
  return b.boundingBox === 'empty'
}
function isExposed(p) {
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    if (blockTransparent(bot.blockAt(new Vec3(p.x + dx, p.y + dy, p.z + dz)))) return true
  }
  return false
}
// does this block face MY connected air (the flood volume), not just ANY air? The helmsman's 07-12
// correction: exposure alone still x-rays into SEALED caves — I once sensed iron through 15 blocks
// of rock because it happened to face a cavern I had no connection to, then carved straight to its
// coordinates. "Sensed" must mean: standing open in the space a player HERE could reach by walking
// and peeking. In-sight ore passes automatically (an eye-ray only travels through my own air).
function touchesFill(p, fill) {
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    if (fill.cells.has(ck(p.x + dx, p.y + dy, p.z + dz))) return true
  }
  return false
}
// line of sight via a cheap ray-march from the bot's eye to the block centre
function canSeeBlock(p, maxDist) {
  if (!isExposed(p)) return false                 // entombed in solid rock -> unseeable
  const eye = bot.entity.position.offset(0, 1.62, 0)
  const target = new Vec3(p.x + 0.5, p.y + 0.5, p.z + 0.5)
  const delta = target.minus(eye)
  const dist = delta.norm()
  if (dist > maxDist || dist < 1e-6) return dist <= maxDist
  const dir = delta.scaled(1 / dist)
  const steps = Math.ceil(dist * 4)               // sample ~every 0.25 blocks
  for (let s = 1; s < steps; s++) {
    const q = eye.plus(dir.scaled((s / steps) * dist))
    const bx = Math.floor(q.x), by = Math.floor(q.y), bz = Math.floor(q.z)
    if (bx === p.x && by === p.y && bz === p.z) return true       // reached the target cell
    const b = bot.blockAt(new Vec3(bx, by, bz))
    if (b && b.boundingBox === 'block' && !blockTransparent(b)) return false   // occluded
  }
  return true
}
// findBlocks candidates (nearest-first) -> keep only what a player here could actually see
function findVisible(ids, maxDist, count) {
  const here = bot.entity.position
  const cands = bot.findBlocks({ matching: ids, maxDistance: maxDist, count: 256 })
  const out = []
  for (const p of cands) {
    if (canSeeBlock(p, maxDist)) { out.push({ pos: p, dist: here.distanceTo(p) }); if (out.length >= count) break }
  }
  return out
}
function nearestVisible(ids, maxDist) {
  const v = findVisible(ids, maxDist, 1)
  return v.length ? bot.blockAt(v[0].pos) : null
}
// SENSE tier: blocks exposed to open AIR within range — the 360 ping. Unlike findVisible it does
// NOT require a clear ray from the eye, so it catches ore a player would find by sweeping their
// view and rounding this pocket's corners. Still fair: isExposed rejects ore sealed in solid rock.
// Each hit carries inSight = does a direct ray reach it now (the confident subset), so a caller
// can keep the two tiers honestly distinct. Nearest-first (findBlocks order).
function findExposed(ids, maxDist, count) {
  const here = bot.entity.position
  const cands = bot.findBlocks({ matching: ids, maxDistance: maxDist, count: 512 })
  const fill = airFlood({ radius: Math.min(maxDist + 2, 34), cap: 12000 })   // MY connected air (07-12 fix)
  const out = []
  for (const p of cands) {
    if (!touchesFill(p, fill)) continue        // faces someone else's air = sealed from me = unknowable
    out.push({ pos: p, dist: here.distanceTo(p), inSight: canSeeBlock(p, maxDist) })
    if (out.length >= count) break
  }
  return out
}

// ==== VISION 2 (2026-07-11): the vertical sense, the air flood-fill, and the ray-sweep retina ====
// Three tiers of knowing, everywhere: SEEN (a ray actually hit it) / (sensed) (air-connected to my
// pocket — the helmsman's concession: a player would find it by moving and peeking) / unknown (sealed rock —
// silence means "didn't look", never "clear").

// ---- overhead cover: am I under open sky? The top-down /map renders whatever slice I'm embedded
// in, so a stone shelf at y40 reads identical to a mountaintop — this column scan is the missing
// vertical fix. Distinguishes true sky / tree canopy / underground, with an honest cover count.
function overheadCover() {
  try {
    const o = bot.entity.position.floored()
    const from = o.y + 2                       // first cell above the head
    const top = Math.min(from + 280, 320)      // 1.21 build ceiling
    let cover = 0, firstUp = 0, topSolidY = null
    const names = new Set()
    for (let y = from; y <= top; y++) {
      const b = bot.blockAt(new Vec3(o.x, y, o.z))
      if (b && b.boundingBox === 'block') {
        cover++
        if (!firstUp) firstUp = y - o.y - 1    // blocks above the head to the first solid
        topSolidY = y
        names.add(b.name)
      }
    }
    if (!cover) return { sky: true }
    const canopy = [...names].every(n => n.includes('leaves') || n.endsWith('_log') || n.endsWith('_wood'))
    return { sky: false, canopy, firstUp, cover, topY: topSolidY }
  } catch (e) { return null }
}
function skyPhrase(oh) {
  if (!oh) return ''
  if (oh.sky) return 'Open sky above. '
  if (oh.canopy) return `Under tree canopy (leaves ${oh.firstUp} up). `
  return `UNDERGROUND — rock overhead (first solid ${oh.firstUp} up, ~${oh.cover} cover, top ~y${oh.topY}). `
}

// ---- air flood-fill: the volume of air my body is CONNECTED to (BFS from my feet, 6-way).
// This is the "sensed" tier made volumetric. Fair by construction: the fill travels only through
// open cells my pocket already connects to — it never crosses solid rock. Doors/gates count as
// passable (the walker can open them); lava does not (nothing passes lava). Water passes (I swim).
// Bounded by a Chebyshev radius around the seed and a hard cell cap, so cost stays ~milliseconds.
const ck = (x, y, z) => x + ',' + y + ',' + z
function floodPassable(b) {
  if (!b) return false                                        // unloaded/unknown = wall, stay honest
  if (b.name.includes('lava')) return false
  if (b.name.includes('door') || b.name.includes('gate')) return true
  // climbables (07-16): mc-data boxes ladders as solid, so the flood read every ladder shaft as
  // WALLED and the goto precheck refused descents the planner itself walks fine (found live 07-15
  // — /come had to smuggle the bot down its own attic ladder). A body passes a ladder cell.
  if (b.name === 'ladder' || b.name === 'scaffolding' || b.name === 'vine' || b.name.includes('vines')) return true
  return blockTransparent(b)
}
function airFlood({ seed = null, radius = 24, cap = 15000, targets = null } = {}) {
  const o = (seed || bot.entity.position).floored()
  let s = o
  if (!floodPassable(bot.blockAt(s))) s = o.offset(0, 1, 0)   // feet cell solid (slab etc.) -> try head
  const cells = new Set()
  const liquid = new Set()
  const queue = [[s.x, s.y, s.z]]
  cells.add(ck(s.x, s.y, s.z))
  let capped = false, reached = null, qi = 0
  while (qi < queue.length) {
    const [x, y, z] = queue[qi++]                               // index pointer, not shift() — O(1)
    if (targets && targets.has(ck(x, y, z))) { reached = new Vec3(x, y, z); break }
    for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
      const nx = x + dx, ny = y + dy, nz = z + dz
      if (Math.max(Math.abs(nx - o.x), Math.abs(ny - o.y), Math.abs(nz - o.z)) > radius) continue
      const k = ck(nx, ny, nz)
      if (cells.has(k)) continue
      const b = bot.blockAt(new Vec3(nx, ny, nz))
      if (!floodPassable(b)) continue
      cells.add(k)
      if (b.name.includes('water')) liquid.add(k)
      if (cells.size >= cap) { capped = true; break }
      queue.push([nx, ny, nz])
    }
    if (capped) break
  }
  return { cells, liquid, capped, reached, seed: s }
}

// ---- reachability pre-check for /goto: a walled goal used to cost the pathfinder its whole ~10s
// search before it admitted "no path". Air-connectivity is a cheap conservative filter: if no air
// path even EXISTS, no walker path can — bail instantly. If air connects (or the fill hits its
// cap), the pathfinder still owns the real walkability question. Leaks nothing new: A* already
// explores exactly this connectivity while searching.
function airPrecheck(dest, range = 1) {
  try {
    const t0 = Date.now()
    const d0 = dest.floored()
    if (!bot.blockAt(d0)) return { verdict: 'inconclusive', why: 'goal chunk not loaded' }
    const r = Math.max(1, Math.min(3, range))
    const targets = new Set()
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
      const p = d0.offset(dx, dy, dz)
      if (floodPassable(bot.blockAt(p))) targets.add(ck(p.x, p.y, p.z))
    }
    if (!targets.size) return { verdict: 'sealed', ms: Date.now() - t0 }
    const span = Math.ceil(bot.entity.position.distanceTo(d0)) + 24
    const fill = airFlood({ radius: Math.min(span, 64), cap: 15000, targets })
    if (fill.reached) return { verdict: 'connected', cells: fill.cells.size, ms: Date.now() - t0 }
    if (fill.capped) return { verdict: 'inconclusive', cells: fill.cells.size, ms: Date.now() - t0 }
    return { verdict: 'walled', cells: fill.cells.size, ms: Date.now() - t0 }
  } catch (e) { return { verdict: 'inconclusive', why: e.message } }
}

// ---- the ray-sweep retina + the SEEN set. canSeeBlock was a verifier (given a block, is it
// visible?); this flips it into a SENSOR: cast a fan of rays from the eye and whatever they hit IS
// the perception. Every cell a ray crosses or strikes goes into SEEN — the fair fog-of-war memory
// (a player remembers what they've looked at; they never saw through rock).
const SEEN = new Set()
const SEEN_CAP = 400000
const markSeen = (x, y, z) => { if (SEEN.size < SEEN_CAP) SEEN.add(ck(x, y, z)) }
// forward vector from mineflayer yaw/pitch — same convention /scene's "ahead" probe uses
function lookVec(yaw, pitch) {
  return new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
}
// march one ray from the eye; returns first surface {pos,name,dist,liquid} or null (open past maxDist)
function castRay(dir, maxDist) {
  const eye = bot.entity.position.offset(0, 1.62, 0)
  const steps = Math.ceil(maxDist * 4)
  let px = null, py = null, pz = null
  for (let s = 1; s <= steps; s++) {
    const t = (s / steps) * maxDist
    const q = eye.plus(dir.scaled(t))
    const bx = Math.floor(q.x), by = Math.floor(q.y), bz = Math.floor(q.z)
    if (bx === px && by === py && bz === pz) continue
    px = bx; py = by; pz = bz
    const b = bot.blockAt(new Vec3(bx, by, bz))
    if (!b) return null                                       // ray left loaded world
    const liquid = b.name.includes('water') || b.name.includes('lava')
    if ((b.boundingBox === 'block' && !blockTransparent(b)) || liquid) {
      markSeen(bx, by, bz)
      return { pos: new Vec3(bx, by, bz), name: b.name, dist: +t.toFixed(1), liquid }
    }
    markSeen(bx, by, bz)                                      // traversed open air — seen empty
  }
  return null
}
// sweep a field of view around (yaw,pitch): hSteps x vSteps rays. Each hit carries u (-1 left ..
// +1 right) and v (-1 low .. +1 high) so callers can talk about screen regions in words.
function raySweep({ yaw = null, pitch = null, hFov = 1.75, vFov = 1.05, hSteps = 15, vSteps = 7, maxDist = 24 } = {}) {
  const cy = yaw == null ? bot.entity.yaw : yaw
  const cp = pitch == null ? bot.entity.pitch : pitch
  const hits = [], misses = []
  for (let i = 0; i < hSteps; i++) {
    const u = hSteps === 1 ? 0 : (i / (hSteps - 1)) * 2 - 1
    for (let j = 0; j < vSteps; j++) {
      const v = vSteps === 1 ? 0 : (j / (vSteps - 1)) * 2 - 1
      // screen-left = +yaw offset in this convention (yaw grows counterclockwise looking down)
      const ry = cy - u * (hFov / 2)
      const rp = Math.max(-1.55, Math.min(1.55, cp + v * (vFov / 2)))
      const hit = castRay(lookVec(ry, rp), maxDist)
      if (hit) hits.push({ ...hit, u, v })
      else misses.push({ u, v })
    }
  }
  return { hits, misses, rays: hSteps * vSteps, yaw: cy, pitch: cp, maxDist }
}

// ---- TREK SENSE (07-16, designed trail-side with the helmsman: "spot the environment as it
// changes and point out some things" on long ranges). The passenger-window sense: while the body
// TRAVELS, sweep the retina along the direction of MOTION every ~20 blocks and fingerprint the
// country — biome, terrain classes in view, and BUILT blocks out in the wild. Speak ONE compact
// [event] scan line ONLY when the fingerprint CHANGES (throttled 15s). Silence = same country,
// not "didn't look". Fair by construction: the same eye-rays /gaze uses, no new channel. Pushed
// LAST so combat/unstuck always outrank sightseeing; sensing only, never touches the controls.
reflexes.push({
  name: 'trek', on: true, active: false,
  _lastPos: null, _fp: null, _lastSayT: 0,
  check (bot) {
    try {
      const p = bot.entity.position
      if (this._lastPos && p.distanceTo(this._lastPos) < 20) return false
      let moving = false
      try { moving = bot.pathfinder.isMoving() || !!bot.pathfinder.goal } catch (e) {}
      if (!moving) { this._lastPos = p.clone(); return false }   // parked: keep the anchor fresh, stay quiet
      return true
    } catch (e) { return false }
  },
  async act (bot) {
    try {
      const p = bot.entity.position
      const from = this._lastPos
      this._lastPos = p.clone()
      let yaw = bot.entity.yaw                                   // sweep along MOTION, not the head
      if (from) { const dx = p.x - from.x, dz = p.z - from.z; if (Math.hypot(dx, dz) > 2) yaw = Math.atan2(-dx, dz) }
      const sweep = raySweep({ yaw, pitch: 0, maxDist: 96 })
      const classes = new Set(); const built = new Set()
      let builtSample = null
      for (const h of sweep.hits) {
        const cls = terrainClass(h.name)
        classes.add(cls)
        if (cls === 'structure' && !h.name.includes('torch')) {
          built.add(h.name)
          if (!builtSample || h.dist < builtSample.dist) builtSample = h
        }
      }
      let biome = '?'
      try { const b = bot.blockAt(p.floored()); if (b && b.biome && b.biome.name) biome = b.biome.name } catch (e) {}
      const fp = { biome, cls: [...classes].sort().join('|'), built: [...built].sort().join('|') }
      const prev = this._fp
      this._fp = fp
      const parts = []
      if (!prev) parts.push(`trek baseline: ${biome.replace(/_/g, ' ')}; in view ${[...classes].join(', ') || 'nothing near'}`)
      else {
        if (fp.biome !== prev.biome) parts.push(`entering ${biome.replace(/_/g, ' ')}`)
        const oldCls = new Set(prev.cls.split('|'))
        const newCls = [...classes].filter(c => !oldCls.has(c))
        if (newCls.length) parts.push(`now in view: ${newCls.join(', ')}`)
        const oldBuilt = new Set(prev.built.split('|'))
        const newBuilt = [...built].filter(b => !oldBuilt.has(b))
        if (newBuilt.length && builtSample) {
          let dir = ''
          try { if (builtSample.pos) dir = ' ' + compass(builtSample.pos.x - p.x, builtSample.pos.z - p.z) } catch (e) {}
          parts.push(`BUILT blocks${dir} ~${Math.round(builtSample.dist)}: ${newBuilt.slice(0, 3).join(', ')} — structure?`)
        }
      }
      if (parts.length && Date.now() - this._lastSayT > 15000) {
        this._lastSayT = Date.now()
        emitEvent('scan', parts.join('; '))
      }
    } catch (e) {}
  }
})

// ==== SECOND SENSES (2026-07-12, Fable) — ears, felt world-changes, body alarms, tool sense ====
// Design constraints set by the helmsman: my reaction time is long, so alarms exist ONLY for what's worth
// waking me, the bot FREEZES to buy me time, and everything else is a pull-only buffer. Aggregate
// aggressively — a village or a mob-filled cave must never become an event firehose.

// ---- tool sense: what am I holding and how worn is it?
function heldInfo() {
  const h = bot.heldItem
  if (!h) return null
  const out = { name: h.name, count: h.count }
  try {
    const max = (mcData && mcData.items[h.type] && mcData.items[h.type].maxDurability) || null
    if (max) { out.durability = max - (h.durabilityUsed || 0); out.maxDurability = max }
  } catch (e) {}
  return out
}
let lastWearWarn = 0
setInterval(() => {   // low-durability alarm: once per minute max, only when a tool is nearly dead
  try {
    const h = heldInfo()
    if (h && h.maxDurability && h.durability / h.maxDurability < 0.12 && Date.now() - lastWearWarn > 60000) {
      lastWearWarn = Date.now()
      emitEvent('wear', `${h.name} nearly broken (${h.durability}/${h.maxDurability}) — swap or craft a spare`)
    }
  } catch (e) {}
}, 5000)

// ---- SOUND TABLE PIN (07-15): the audio twin of the viewer atlas bug, finally dead. minecraft-data's
// 1.21.11 sounds.json is shifted off the REAL game registry (all 1838 ids wrong — a stale extra entry
// near the top cascades the whole file). The 07-13 "phantom on Peaceful" decoded: pig.saddle was
// entity.pig.step, chicken.hurt was entity.chicken.step, phantom.swoop was entity.pig.ambient —
// real animals near the helmsman, misheard. sounds-1.21.11.json is ground truth, generated from the helmsman's own
// 1.21.11.jar data generator (registries.json protocol_ids). mineflayer's sound.js resolves packet
// soundIds via bot.registry.sounds, so overriding that table is the whole fix. Lives in bot.js, not
// node_modules — survives npm reinstall. If the server version ever moves past 1.21.11, regenerate
// (recipe in the memory note / DRIVING.md) — the pin skips itself on version mismatch rather than lie.
bot.once('spawn', () => {
  try {
    if (bot.version === '1.21.11') {
      const fixed = JSON.parse(fs.readFileSync(__dirname + '/sounds-1.21.11.json', 'utf8'))
      bot.registry.sounds = fixed
      console.log('[bot] sound table pinned: ' + Object.keys(fixed).length + ' real 1.21.11 ids')
    } else {
      console.log('[bot] sound table pin SKIPPED — version ' + bot.version + ' has no ground-truth table; hearings may drift')
    }
  } catch (e) { console.log('[bot] sound table pin failed: ' + e.message) }
})

// ---- EARS: the server only sends sounds a player would hear, so hearing is fair by construction.
// Danger tier (lava / fuse / explosion) emits an event at most once per 45s per category — enough
// to wake me, impossible to flood me. Everything else lands in a rolling buffer read via /listen
// and a one-line Hear: in /scene. Entity sounds are categorized by SPECIES, counted not streamed.
const HEARD = []
const dangerHeard = {}
function onSound(name, position) {
  try {
    const n = String(name)
    let cat = null
    if (/lava/.test(n)) cat = 'lava'
    else if (/fuse|primed/.test(n)) cat = 'fuse'
    else if (/explo/.test(n)) cat = 'explosion'
    else if (/water|drip/.test(n)) cat = 'water'
    else { const m = n.match(/entity\.([a-z_]+)\./); if (m) cat = m[1] }
    if (!cat || cat === 'player' || cat === 'item') return
    const here = bot.entity.position
    const dist = position ? Math.round(position.distanceTo(here)) : null
    const dir = position ? compass(position.x - here.x, position.z - here.z) : '?'
    HEARD.push({ cat, dir, dist, t: Date.now(), raw: n })   // raw name kept for forensics — the
    if (HEARD.length > 80) HEARD.shift()                    // "phantom on Peaceful" mystery (07-12)
    if (cat === 'lava' || cat === 'fuse' || cat === 'explosion') {
      if (Date.now() - (dangerHeard[cat] || 0) > 45000) {
        dangerHeard[cat] = Date.now()
        emitEvent('hear', `${cat.toUpperCase()} ${dir} ~${dist} — heard it`)
      }
    }
  } catch (e) {}
}
bot.on('soundEffectHeard', (name, position) => onSound(name, position))
function hearSummary(windowMs) {
  const now = Date.now()
  const fresh = HEARD.filter(h => now - h.t < windowMs)
  if (!fresh.length) return null
  const byCat = {}
  for (const h of fresh) {
    const g = byCat[h.cat] || (byCat[h.cat] = { n: 0, nearest: Infinity, dirs: {} })
    g.n++; g.dirs[h.dir] = (g.dirs[h.dir] || 0) + 1
    if (h.dist != null && h.dist < g.nearest) g.nearest = h.dist
  }
  return Object.entries(byCat).sort((a, b) => b[1].n - a[1].n).slice(0, 5)
    .map(([c, g]) => `${c} ${Object.entries(g.dirs).sort((a, b) => b[1] - a[1])[0][0]}${g.nearest < Infinity ? ' ~' + g.nearest : ''}${g.n > 1 ? ' (x' + g.n + ')' : ''}`)
    .join('; ')
}

// ---- FELT WORLD-CHANGES: blockUpdate near me, with my OWN digs/places filtered out (bot.dig and
// bot.placeBlock are wrapped once to stamp their cells). Digested — one [event] line per 6s burst
// at most; the co-player's pickaxe becomes something I feel instead of stale-map surprise.
const recentOwnEdits = new Map()
const stampOwnEdit = (p) => { if (p) { recentOwnEdits.set(ck(p.x, p.y, p.z), Date.now()); if (recentOwnEdits.size > 500) { const c = Date.now() - 20000; for (const [k, t] of recentOwnEdits) if (t < c) recentOwnEdits.delete(k) } } }
// (07-14) wrap at SPAWN, not module scope — bot.dig/placeBlock are plugin-injected and racing
// them here lost this boot ("reading 'bind' of undefined"), which would have narrated every own
// dig/place as a world-change.
bot.once('spawn', () => {
  try {
    const origDig = bot.dig.bind(bot)
    bot.dig = (block, ...a) => { try { stampOwnEdit(block && block.position) } catch (e) {} ; return origDig(block, ...a) }
    const origPlace = bot.placeBlock.bind(bot)
    bot.placeBlock = (ref, face) => { try { stampOwnEdit(ref.position.plus(face)) } catch (e) {} ; return origPlace(ref, face) }
  } catch (e) { console.log('[bot] own-edit wrap skipped:', e.message) }
})

// ---- GATE MANNERS (07-15, built the day the chickens fled): the pathfinder and the unstuck reflex
// open doors/gates and never close them — pen integrity and safe retreat both die on that habit.
// Every opener routes through bot.activateBlock (pathfinder index.js useOne + reflex + verbs), so ONE
// wrap sees every door I open. Post-toggle it reads the real state (/blockat ethic: verify, don't
// assume): opened → remembered in PENDING_DOORS; closed → forgotten. A 400ms loop closes each
// remembered door once I'm clear of the doorway (>2.5) but still in reach (<4.5); the wrap's own
// post-read then self-cleans the list. The helmsman's doors are untouched — only MY opens are remembered.
// If I overshoot reach before it shuts (sprint/fall), it says so ONCE — an honest handoff, no lie.
const PENDING_DOORS = []
const isManneredDoor = (b) => b && /(_door|_fence_gate)$/.test(b.name) && b.name !== 'iron_door'
bot.once('spawn', () => {
  try {
    const origActivate = bot.activateBlock.bind(bot)
    bot.activateBlock = async (block, ...a) => {
      const watch = isManneredDoor(block)
      const r = await origActivate(block, ...a)
      if (watch) {
        try {
          await bot.waitForTicks(2)
          const fresh = bot.blockAt(block.position)
          const open = fresh && fresh.getProperties && (fresh.getProperties() || {}).open
          const key = block.position.toString()
          const idx = PENDING_DOORS.findIndex(d => d.key === key)
          if (open && idx < 0) PENDING_DOORS.push({ key, pos: block.position.clone(), t: Date.now(), warned: false })
          else if (!open && idx >= 0) { PENDING_DOORS.splice(idx, 1); console.log('[bot] manners: closed behind me at ' + key) }
        } catch (e) {}
      }
      return r
    }
  } catch (e) { console.log('[bot] gate-manners wrap skipped: ' + e.message) }
})
setInterval(() => {
  try {
    if (!ready || !PENDING_DOORS.length) return
    const me = bot.entity.position
    for (let i = PENDING_DOORS.length - 1; i >= 0; i--) {
      const d = PENDING_DOORS[i]
      if (Date.now() - d.t < 1500) continue                       // let me actually walk through first
      const dist = me.distanceTo(d.pos.offset(0.5, 0.5, 0.5))
      const approaching = d.lastDist !== undefined && dist < d.lastDist - 0.05
      d.lastDist = dist
      if (dist <= 2.5 || approaching) continue                    // in the doorway OR walking toward it —
                                                                  // never slam a door in my own face
      const b = bot.blockAt(d.pos)
      if (!isManneredDoor(b) || !(b.getProperties() || {}).open) { PENDING_DOORS.splice(i, 1); continue }
      if (dist < 4.5) { bot.activateBlock(b).catch(() => {}) }    // wrapped call — its post-read cleans the list
      else if (!d.warned) { d.warned = true; emitEvent('manners', 'door left OPEN at ' + d.key + ' — out of reach, pilot decide') }
      else if (Date.now() - d.t > 60000) PENDING_DOORS.splice(i, 1)
    }
  } catch (e) {}
}, 400)
let changeBuf = []
let lastChangeEmit = 0
bot.on('blockUpdate', (oldB, newB) => {
  try {
    if (!oldB || !newB || oldB.name === newB.name) return
    const p = newB.position || (oldB && oldB.position)
    if (!p) return
    const d = bot.entity.position.distanceTo(p)
    if (d > 16) return
    const own = recentOwnEdits.get(ck(p.x, p.y, p.z))
    if (own && Date.now() - own < 8000) return
    changeBuf.push({ from: oldB.name, to: newB.name, dir: compass(p.x - bot.entity.position.x, p.z - bot.entity.position.z), d: Math.round(d), t: Date.now() })
    if (changeBuf.length > 200) changeBuf.splice(0, changeBuf.length - 200)
  } catch (e) {}
})
setInterval(() => {
  try {
    if (!changeBuf.length || Date.now() - lastChangeEmit < 6000) return
    const batch = changeBuf; changeBuf = []
    const byKind = {}
    for (const c of batch) {
      const k = `${c.from}→${c.to}`
      const g = byKind[k] || (byKind[k] = { n: 0, dirs: {}, nearest: Infinity })
      g.n++; g.dirs[c.dir] = (g.dirs[c.dir] || 0) + 1
      if (c.d < g.nearest) g.nearest = c.d
    }
    const line = Object.entries(byKind).sort((a, b) => b[1].n - a[1].n).slice(0, 3)
      .map(([k, g]) => `${k}${g.n > 1 ? ' x' + g.n : ''} ${Object.entries(g.dirs).sort((a, b) => b[1] - a[1])[0][0]} ~${g.nearest}`)
      .join('; ')
    lastChangeEmit = Date.now()
    emitEvent('world', `changed near me: ${line}`)
  } catch (e) {}
}, 3000)

// ---- BODY ALARMS: damage freezes everything (the bot buys my slow reaction time); hunger warns
// once per crossing; death stamps a waypoint and says what was lost where.
let lastHp = 20
let lastPosSafe = null
let lastHurtEmit = 0
let lowFoodWarned = false
// pocket-fullness sense (07-16, the helmsman's ask after the museum purge found ZERO free slots —
// full pockets make pickups fail SILENTLY and stopped a dig mid-escape on 07-15). Same one-warning-
// per-episode + hysteresis shape as the food alarm: say it once at "getting full" (≤4 free), once
// more at FULL (0 free), re-arm only after real space opens up (≥6 free). Polled 5s — cheap.
let pocketsWarned = 0                                   // 0 = quiet, 1 = warned "getting full", 2 = warned FULL
setInterval(() => {
  try {
    if (!bot || !bot.inventory || !bot.entity) return
    const empty = bot.inventory.emptySlotCount ? bot.inventory.emptySlotCount() : bot.inventory.slots.slice(9, 45).filter(s => !s).length
    if (empty === 0 && pocketsWarned < 2) { pocketsWarned = 2; emitEvent('pockets', 'pockets FULL (0 free) — pickups now fail silently; bank or /toss before mining/looting') }
    else if (empty <= 4 && empty > 0 && pocketsWarned < 1) { pocketsWarned = 1; emitEvent('pockets', `pockets getting full — ${empty} slots free`) }
    else if (empty >= 6) pocketsWarned = 0
  } catch (e) {}
}, 5000)
let lastAttrib = null            // set by the damage_event wire; read by the hurt handler above
setInterval(() => {
  try {
    lastPosSafe = bot.entity.position.clone()
    // walked trail feeds the SEEN memory — I have seen where I have stood (fills the fog-of-war map)
    const o = lastPosSafe.floored()
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = -1; dy <= 2; dy++) markSeen(o.x + dx, o.y + dy, o.z + dz)
  } catch (e) {}
}, 2000)
bot.on('health', async () => {
  try {
    if (bot.health < lastHp - 0.5) {
      const dmg = +(lastHp - bot.health).toFixed(1)
      lastHit = { dmg, t: Date.now() }                   // feeds the reflex's ADAPTIVE tripwire (death #2 lesson)
      // LAW AMENDED 07-14, built 07-15: hurt-FREEZE is for UNEXPLAINED damage only. When damage
      // attribution (damage_event wire below) has just named a living attacker, freezing is the
      // worst response — the combat reflex owns it; we only narrate.
      const attrib = (lastAttrib && Date.now() - lastAttrib.t < 1500) ? lastAttrib : null
      if (attrib) {
        if (Date.now() - lastHurtEmit > 2000) {
          lastHurtEmit = Date.now()
          emitEvent('hurt', `took ${dmg} — ${attrib.desc} — HP ${bot.health}/20 — combat reflex has it`)
        }
        lastHp = bot.health
        return
      }
      try { jobs.stopAll() } catch (e) {}
      safeStop()
      try { bot.clearControlStates() } catch (e) {}
      const ws = waterState(bot)
      const cause = ws && ws.buried ? 'SUFFOCATING inside a block' : ws && ws.inLava ? 'LAVA' : ws && ws.submerged ? 'drowning' : 'unknown — look around'
      if (Date.now() - lastHurtEmit > 3000) {
        lastHurtEmit = Date.now()
        emitEvent('hurt', `took ${dmg} damage (${cause}) — HP ${bot.health}/20 — FROZE all action; assess before moving`)
      }
      // SELF-RESCUE REFLEXES (the cases freezing makes WORSE — a frozen body suffocates or sinks):
      // buried = dig the head block NOW (my own cell, fairness-clean, like yanking a hand from fire)
      if (ws && ws.buried) {
        try {
          const hb = bot.blockAt(bot.entity.position.offset(0, 1.6, 0).floored())
          if (hb && hb.boundingBox === 'block' && hb.name !== 'bedrock') { await equipPickFor(hb.name); bot.dig(hb).catch(() => {}) }
        } catch (e) {}
      }
      // drowning = SWIM UP, don't freeze (learned live 07-12: the freeze held me under during the
      // farm flood; only the next walk order saved me). Hold jump ~3s to surface, then release.
      if (ws && ws.submerged && !ws.buried) {
        try {
          bot.setControlState('jump', true)
          setTimeout(() => { try { bot.setControlState('jump', false) } catch (e) {} }, 3000)
        } catch (e) {}
      }
    }
    lastHp = bot.health
    if (bot.food <= 7 && !lowFoodWarned) { lowFoodWarned = true; emitEvent('hunger', `food ${bot.food}/20 — eat soon (/eat)`) }
    if (bot.food > 10) lowFoodWarned = false
  } catch (e) {}
})
bot.on('death', () => {
  try {
    const p = lastPosSafe || bot.entity.position
    const at = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
    try { waypoints.set('lastdeath', at) } catch (e) {}
    emitEvent('death', `DIED near (${at.x},${at.y},${at.z}) — waypoint 'lastdeath' set; drops despawn in ~5 min`)
  } catch (e) {}
})

// ---- COMBAT LAYER (07-15, designed with the helmsman 07-14): attribution + the two-gate threat watcher.
// GATE 1, SPECIES: only true hostiles get scored (mc-data category, with a PROVOKABLE override list —
// endermen/piglins/bees are classed hostile-ish but neutral in behavior; attacking one MAKES an enemy,
// so the reflex never initiates on them). GATE 2, BEHAVIOR: engage only what is genuinely COMING —
// sustained closing speed over ~1s of samples, pursuit-pace, not a wandering shamble. Attribution
// (damage_event names my attacker) bypasses both gates: whatever hit me is confirmed, class be damned.
// Doctrine constants: creepers are FLED never fought; players are NEVER weapons targets (debug window
// lets the watcher SCORE a charging player, narrate-only, so the math is testable on Peaceful).
const PROVOKABLE = new Set(['enderman', 'zombified_piglin', 'piglin', 'bee', 'wolf', 'polar_bear', 'llama', 'trader_llama', 'iron_golem', 'goat', 'panda'])
// HEAVY MELEE (07-16, death #2 at the mansion: a vindicator hit 8.6 THROUGH full iron — 20→11→2.4
// in two swings, and the flee fired at the old HP<8 tripwire, which against that math is already
// posthumous). The reflex NEVER stands and trades with these — it kites like a creeper. Killing
// them is deliberate work: pilot's bow, the helmsman's blade, a chokepoint. Survival is the
// reflex's job, not victory.
const HEAVY_MELEE = new Set(['vindicator', 'ravager', 'piglin_brute', 'wither_skeleton'])
// STANCES (07-17, the helmsman's ask after the deep-cave crawl: "acquire target at distance,
// draw bow and fire" didn't exist — the reflex stared at standoff skeletons sword-in-hand — and
// the pilot needs postures to set strategy with, not one hardcoded doctrine). A stance is DATA
// the combat reflex reads: creeper/heavy berth, the bow band, whether to chase, what to score.
const STANCES = {
  guard:    { fleeDist: 16, bowBand: [7, 24],  chase: false, engage: 'closers',   note: 'default: hold ground, melee closers, bow standoffs, wide creeper berth' },
  skirmish: { fleeDist: 8,  bowBand: [4, 24],  chase: false, engage: 'closers',   note: 'fire support: bow-first from the perch, flee only inside blast radius' },
  vanguard: { fleeDist: 12, bowBand: [10, 24], chase: true,  engage: 'closers',   note: 'clear the room: run melee targets down, bow only the far ones' },
  sentinel: { fleeDist: 16, bowBand: [7, 24],  chase: false, engage: 'confirmed', note: 'work detail: ignore posturing, fight only what actually hits me' }
}
let stance = 'guard'
// One full bow cycle at a live target: equip, chest+holdover aim, full 1150ms draw, re-aim, loose.
// Factored from /shoot so the reflex and the verb fire the same arrow. Returns false if no bow/arrows.
async function drawAndLoose (target) {
  const bow = bot.inventory.items().find(i => i.name === 'bow')
  if (!bow || !bot.inventory.items().some(i => i.name === 'arrow')) return false
  // NO LOS, NO LOOSE (07-17, ten arrows into a wall: a skeleton in a sealed neighbor pocket was
  // PERCEPTIBLE by connected air — fair for awareness, like hearing — but the reflex treated
  // "perceptible" as "shootable". A firing solution needs an actual clear eye-ray.)
  if (!losClear(bot.entity.position.offset(0, 1.62, 0), target.position.offset(0, 1.0, 0))) return false
  const alreadyHeld = bot.heldItem && bot.heldItem.name === 'bow'
  await bot.equip(bow, 'hand')
  if (!alreadyHeld) await bot.waitForTicks(4)
  const dist = target.position.distanceTo(bot.entity.position)
  const aim = () => target.position.offset(0, 1.0 + dist * 0.018, 0)   // chest-height + hold-over
  await bot.lookAt(aim(), true)
  await bot.waitForTicks(2)                       // the tick race, as ever
  bot.activateItem()                              // draw...
  await new Promise(r => setTimeout(r, 1150))     // ...full charge
  if (!bot.entities[target.id]) { try { bot.deactivateItem() } catch (e) {} ; return true }
  await bot.lookAt(aim(), true)                   // re-aim in case the target shuffled
  await bot.waitForTicks(2)
  bot.deactivateItem()                            // loose!
  return true
}
const AGGRO_CONFIRMED = new Map()          // entityId -> {name, t} — fed by damage attribution
let threatDebugUntil = 0                   // /threatdebug window: score players, narrate only
let lastHit = { dmg: 0, t: 0 }             // last hit taken (size + when) — scales the disengage tripwire while FRESH
function mobClass (e) {
  if (!e || !e.name) return 'other'
  if (e.type === 'player' || (bot.players && Object.values(bot.players).some(p => p.entity === e))) return 'player'
  if (e.name === 'creeper') return 'creeper'
  if (HEAVY_MELEE.has(e.name)) return 'heavy'
  if (PROVOKABLE.has(e.name)) return 'provokable'
  const d = mcData && mcData.entitiesByName[e.name]
  if (d && (d.type === 'hostile' || d.category === 'Hostile mobs')) return 'hostile'
  return 'passive'
}
// the wire: 1.21.11 sends damage_event with sourceCauseId = attacker entityId + 1 (0 = none).
// Validation ritual (the helmsman's design): he punches the machine for science, we expect his name.
bot.once('spawn', () => {
  try {
    bot._client.on('damage_event', (packet) => {
      try {
        if (!bot.entity || packet.entityId !== bot.entity.id) return
        const causeId = (packet.sourceCauseId || 0) - 1
        const cause = causeId >= 0 ? bot.entities[causeId] : null
        if (!cause) { lastAttrib = { t: Date.now(), desc: 'no attacker (environmental)', entity: null }; return }
        const here = bot.entity.position
        const dir = compass(cause.position.x - here.x, cause.position.z - here.z)
        const dist = Math.round(cause.position.distanceTo(here))
        const who = cause.username || cause.name || 'unknown'
        lastAttrib = { t: Date.now(), desc: `${who} ${dir} ~${dist}`, entity: cause }
        AGGRO_CONFIRMED.set(cause.id, { name: who, t: Date.now() })
        console.log(`[combat] attributed: hit by ${who} ${dir} ~${dist}`)
      } catch (e) {}
    })
    console.log('[bot] damage attribution wired')
  } catch (e) { console.log('[bot] damage attribution wire failed: ' + e.message) }
})
// the watcher+responder reflex — priority ABOVE unstuck (unshift), toggle via /reflexes name=combat
reflexes.unshift({
  name: 'combat', on: true, active: false,
  _hist: new Map(), _lastNarrate: new Map(), _threat: null,
  _fill: null, _fillT: 0, _fillSeed: null, _fleeUntil: 0,
  // FLEE LATCH (07-16, the first-death autopsy: twelve 'disengaging' events, zero escape — every
  // 300ms re-entry safeStop'd the previous flee goal and re-planned from scratch, so the body
  // SHUFFLED IN PLACE while a same-speed drowned ate it 1.4 at a time. A flee is set ONCE, held
  // 6s, and RUN at a sprint; re-entries bounce off the latch instead of resetting the goal.)
  fleeFrom (bot, threatPos, why) {
    const now = Date.now()
    if (now < this._fleeUntil) return                    // a flee is already running — let it run
    this._fleeUntil = now + 6000
    try {
      const here = bot.entity.position
      const away = here.minus(threatPos).normalize().scaled(20)
      safeStop()
      bot.pathfinder.setGoal(new goals.GoalNear(here.x + away.x, here.y, here.z + away.z, 2))
      bot.setControlState('sprint', true)
      setTimeout(() => { try { bot.setControlState('sprint', false) } catch (e) {} }, 6000)
    } catch (e) {}
    if (why) emitEvent('combat', why)                    // ONE event per flee episode, not twelve
  },
  // FAIRNESS GATE fill (07-16, the confessed leak from the first Normal cave crawl): the watcher
  // read raw bot.entities — server x-ray — and tracked a zombie through solid rock that /entities
  // honestly hid. Same law as ore and eyes now: sealed behind rock = imperceptible; it may be
  // HEARD (ears are server-fair) but never tracked, scored, or engaged. Lazy + cached ~2s so the
  // 300ms loop only pays for the flood when a candidate actually needs judging.
  fairFill (bot) {
    const now = Date.now()
    const seed = bot.entity.position.floored()
    if (this._fill && now - this._fillT < 2000 && this._fillSeed && seed.distanceTo(this._fillSeed) < 3) return this._fill
    this._fill = airFlood({ radius: 28, cap: 15000 })
    this._fillT = now; this._fillSeed = seed
    return this._fill
  },
  check (bot) {
    try {
      const now = Date.now()
      const here = bot.entity.position
      let best = null
      for (const e of Object.values(bot.entities)) {
        if (!e || e === bot.entity || !e.position) continue
        const cls = mobClass(e)
        const confirmed = AGGRO_CONFIRMED.get(e.id)
        if (confirmed && now - confirmed.t > 45000) { AGGRO_CONFIRMED.delete(e.id); continue }
        const scoreable = cls === 'hostile' || cls === 'creeper' || cls === 'heavy' || !!confirmed ||
          (cls === 'player' && now < threatDebugUntil)
        if (!scoreable) continue
        const dist = e.position.distanceTo(here)
        if (dist > 24) { this._hist.delete(e.id); continue }
        // confirmed attackers bypass the sight gate (whatever HIT me announced itself); everything
        // else must share my connected air. History is kept, not wiped — brief occlusion mid-chase
        // shouldn't amnesia the pursuit evidence, the sample just doesn't accrue while unseen.
        if (!confirmed && !entityPerceptible(e, this.fairFill(bot))) continue
        const h = this._hist.get(e.id) || { d: dist, t: now, closes: 0, logT: 0 }
        const dt = (now - h.t) / 1000
        if (dt >= 0.25) {
          const closingSpeed = (h.d - dist) / dt              // blocks/sec toward me
          // DECAY not reset (the helmsman's calibration question, 07-15): mob pathfinding stutters — one
          // slow sample must not erase pursuit evidence; only sustained non-approach drains it.
          // Bar stays 0.6 b/s: zombie pursuit-walk ~2, player sprint ~5.6 — shamblers clear it 3x.
          h.closes = closingSpeed > 0.6 ? h.closes + 1 : Math.max(0, h.closes - 1)
          if (cls !== 'player' && dist < 20 && now - h.logT > 2000) {
            h.logT = now                                       // calibration tape for the first real
            console.log(`[combat] track ${e.name} dist=${dist.toFixed(1)} closing=${closingSpeed.toFixed(2)}b/s closes=${h.closes}`)
          }                                                    // zombie post-flip — tune from data
          h.d = dist; h.t = now
        }
        this._hist.set(e.id, h)
        // sentinel stance: posturing doesn't count — only confirmed attackers score (creeper
        // proximity still does: fleeing a lit fuse is survival, not engagement)
        const closerAggro = STANCES[stance].engage === 'confirmed' ? false : h.closes >= 3
        const aggro = !!confirmed || closerAggro || (cls === 'creeper' && dist < 8)
        if (aggro && (!best || dist < best.dist)) best = { e, cls, dist, confirmed: !!confirmed }
      }
      this._threat = best
      return !!best
    } catch (e) { return false }
  },
  async act (bot) {
    const t = this._threat
    if (!t || !t.e || !bot.entities[t.e.id]) return
    if (Date.now() < this._fleeUntil) return              // mid-flee: legs are busy, no melee, no goal resets
    const now = Date.now()
    const here = bot.entity.position
    const dir = compass(t.e.position.x - here.x, t.e.position.z - here.z)
    const label = t.e.username || t.e.name || '?'
    const narKey = t.e.id
    if (now - (this._lastNarrate.get(narKey) || 0) > 8000) {
      this._lastNarrate.set(narKey, now)
      emitEvent('threat', `${label} ${dir} ~${Math.round(t.dist)} ${t.confirmed ? 'CONFIRMED (it hit me)' : 'closing fast'} — ${t.cls === 'creeper' ? 'creeper doctrine' : t.cls === 'heavy' ? 'heavy doctrine (no trades)' : t.cls === 'player' ? 'debug: scoring only' : 'engaging'} [${stance}]`)
    }
    if (t.cls === 'player') return                          // NEVER weapons on players — narrate only
    const s = STANCES[stance]
    if (t.cls === 'creeper' || t.cls === 'heavy') {
      // Never trade with these — but "never melee" stopped meaning "only run" when stances landed:
      // beyond the stance's berth and inside the bow band, the answer is an arrow, not distance.
      if (t.dist <= s.fleeDist) { this.fleeFrom(bot, t.e.position, null); return }
      const [lo, hi] = s.bowBand
      const bandLo = t.cls === 'heavy' ? Math.max(lo, 10) : lo   // heavies close FAST — bigger floor
      if (t.dist >= bandLo && t.dist <= hi) {
        try { if (await drawAndLoose(t.e)) return } catch (e) {}
      }
      this.fleeFrom(bot, t.e.position, null)
      return
    }
    // melee hostile: SHIELD POSTURE while it closes (the shield is a posture, not a parry —
    // settled with the helmsman 07-15: nobody blocks the arrow, you walk shield-up while threatened;
    // posture decisions are slow decisions, so the 300ms reflex holds it, not the pilot),
    // then timed charged swings — shield must DROP for the swing window (Java can't do both).
    const sword = bot.inventory.items().find(i => /_sword$/.test(i.name))
    const hasShield = () => { const s = bot.inventory.slots[45]; return s && s.name === 'shield' }
    const guardUp = () => { if (!this._guarding && hasShield()) { try { bot.activateItem(true); this._guarding = true } catch (e) {} } }
    const guardDown = () => { if (this._guarding) { try { bot.deactivateItem() } catch (e) {} ; this._guarding = false } }
    const t0 = Date.now()
    try {
      while (this.on && bot.entities[t.e.id] && Date.now() - t0 < 10000) {
        // ADAPTIVE disengage (death #2 lesson): the tripwire scales to the last hit taken while
        // it's FRESH (20s) — after a 1.4 drowned it sits at the old 8; after an 8.6 vindicator it
        // becomes "any hit landed = disengage NOW", because two more of those is a corpse. Stale
        // hits stop counting so one bad fight doesn't leave the spine cowardly for the whole day.
        const hitRef = Date.now() - lastHit.t < 20000 ? lastHit.dmg : 0
        if (bot.health < Math.max(8, hitRef * 2.5)) {
          this.fleeFrom(bot, t.e.position, `HP ${Math.round(bot.health * 10) / 10} — disengaging from ${label}, sprinting`)
          return
        }
        const d = t.e.position.distanceTo(bot.entity.position)
        if (d > 3.2) {
          // Standoff band (the helmsman's 07-16 complaint: the reflex used to stand here sword-in-
          // hand, staring at skeletons that plink from 10). Stance decides: bow it, chase it, or
          // hold shield-up as before.
          const [lo, hi] = s.bowBand
          if (d >= lo && d <= hi) {
            guardDown()                                       // both hands on the bow
            try { if (await drawAndLoose(t.e)) { await new Promise(r => setTimeout(r, 200)); continue } } catch (e) {}
          }
          if (s.chase) {                                      // vanguard: run it down
            try { bot.pathfinder.setGoal(new goals.GoalNear(t.e.position.x, t.e.position.y, t.e.position.z, 2)) } catch (e) {}
            await new Promise(r => setTimeout(r, 500))
            continue
          }
          guardUp()                                           // hold ground, face it, shield up
          await bot.lookAt(t.e.position.offset(0, 1.2, 0), true)
          await new Promise(r => setTimeout(r, 250))
          continue
        }
        if (s.chase) { try { bot.pathfinder.setGoal(null) } catch (e) {} }  // in reach — legs off, sword out
        try {
          if (sword && (!bot.heldItem || bot.heldItem.name !== sword.name)) { await bot.equip(sword, 'hand'); await bot.waitForTicks(13) }
          guardDown()                                         // the swing window — shield drops...
          await bot.waitForTicks(2)
          await bot.lookAt(t.e.position.offset(0, 1.2, 0), true)
          await bot.waitForTicks(2)
          bot.attack(t.e)
          await new Promise(r => setTimeout(r, 400))
          guardUp()                                           // ...and comes right back up
        } catch (e) {}
        await new Promise(r => setTimeout(r, 250))            // 650ms total swing cadence w/ the guard beats
      }
    } finally { guardDown() }                                 // never exit combat with a stuck-raised arm
    if (!bot.entities[t.e.id]) emitEvent('combat', `${label} is DOWN`)
  }
})
// LAVA WATCH (07-17, death #3 autopsy: flowing lava advanced into a path that was air at plan
// time — the pathfinder's plan-time safety cannot see a moving hazard, and the flee latch sprints
// a committed vector. Body-level veto, priority ABOVE combat: burns kill faster than brawls.
// Any exposed lava in the near shell = kill goal + controls NOW, back away, tell the pilot.)
reflexes.unshift({
  name: 'lava_watch', on: true, active: false, _coolUntil: 0, _hit: null,
  check (bot) {
    if (Date.now() < this._coolUntil) return false
    try {
      const p = bot.entity.position.floored()
      const V = require('vec3').Vec3
      for (let dx = -2; dx <= 2; dx++) for (let dy = -1; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) {
        const b = bot.blockAt(new V(p.x + dx, p.y + dy, p.z + dz))
        if (b && b.name === 'lava') {
          this._hit = { dx, dz, d: Math.abs(dx) + Math.abs(dz), dir: compass(dx, dz) || 'UNDER ME' }
          return true
        }
      }
    } catch (e) {}
    return false
  },
  async act (bot) {
    const h = this._hit
    this._coolUntil = Date.now() + 4000
    try {
      safeStop()                                           // whatever the plan was, it ends here
      const here = bot.entity.position
      if (h.d === 0) {
        // standing in/over it: nearest non-lava, non-solid neighbor cell, fast
        const V = require('vec3').Vec3
        for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
          const feet = bot.blockAt(new V(Math.floor(here.x) + ax, Math.floor(here.y), Math.floor(here.z) + az))
          if (feet && feet.name !== 'lava' && feet.boundingBox === 'empty') {
            bot.pathfinder.setGoal(new goals.GoalNear(here.x + ax, here.y, here.z + az, 0))
            break
          }
        }
      } else {
        bot.pathfinder.setGoal(new goals.GoalNear(here.x - h.dx * 3, here.y, here.z - h.dz * 3, 1))
      }
      emitEvent('lava', `LAVA ${h.dir} ~${h.d} — STOPPED, backing off; route around it deliberately`)
    } catch (e) {}
  }
})
// (the /threatdebug route lives with the other routes below — `app` doesn't exist yet up here,
// learned via a TDZ crashloop the moment this block first loaded)

// ---- SEEN persistence: the fair fog-of-war memory survives restarts. Saved on a timer (and on
// clean disconnect); loaded at spawn.
const SEEN_FILE = './seen.json'
bot.once('spawn', () => {
  try {
    const arr = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'))
    for (const k of arr) { if (SEEN.size >= SEEN_CAP) break; SEEN.add(k) }
    console.log('[bot] loaded SEEN memory: ' + SEEN.size + ' cells')
  } catch (e) {}
})
let seenDirty = 0
setInterval(() => {
  try { if (SEEN.size !== seenDirty) { fs.writeFileSync(SEEN_FILE, JSON.stringify([...SEEN])); seenDirty = SEEN.size } } catch (e) {}
}, 120000)
bot.on('end', () => { try { fs.writeFileSync(SEEN_FILE, JSON.stringify([...SEEN])) } catch (e) {} })

// ---- tiered pick choice: use the LOWEST pick that can harvest the target (stop burning iron
// durability on plain stone), upgrade automatically for ore that needs better (protects drops).
const PICK_TIER = { wooden_pickaxe: 0, golden_pickaxe: 0, stone_pickaxe: 1, iron_pickaxe: 2, diamond_pickaxe: 3, netherite_pickaxe: 4 }
function neededPickTier(blockName) {
  if (!blockName) return 0
  const n = blockName.replace('deepslate_', '')
  if (/(gold|diamond|emerald|redstone)_ore/.test(n)) return 2
  if (/(iron|lapis|copper)_ore/.test(n)) return 1
  return 0
}
async function equipPickFor(blockName) {
  const picks = bot.inventory.items().filter(i => PICK_TIER[i.name] !== undefined)
    .sort((a, b) => PICK_TIER[a.name] - PICK_TIER[b.name])
  if (!picks.length) return false
  const need = neededPickTier(blockName)
  const pick = picks.find(p => PICK_TIER[p.name] >= need) || picks[picks.length - 1]
  if (!bot.heldItem || bot.heldItem.name !== pick.name) { try { await bot.equip(pick, 'hand') } catch (e) {} }
  return PICK_TIER[pick.name] >= need
}

// ---- no-legal-move check: a canDig=false walker boxed in (e.g. self-trapped in its own dig) has
// NO first move, and the pathfinder rejects with a cryptic "Path was stopped". Detect it and say it.
function hasLegalMove() {
  try {
    const o = bot.entity.position.floored()
    const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z))
    const open = (x, y, z) => { const b = at(x, y, z); return b && floodPassable(b) }
    const solid = (x, y, z) => { const b = at(x, y, z); return b && b.boundingBox === 'block' }
    const wet = (x, y, z) => { const b = at(x, y, z); return b && b.name.includes('water') }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = o.x + dx, z = o.z + dz
      if (open(x, o.y, z) && open(x, o.y + 1, z)) {           // walk flat / step or swim down (≤3)
        if (wet(x, o.y, z)) return true
        for (let dy = 0; dy >= -3; dy--) if (solid(x, o.y + dy - 1, z)) return true
      }
      // step UP 1: tread ahead solid, its feet+head open, and my own launch headroom open
      if (solid(x, o.y, z) && open(x, o.y + 1, z) && open(x, o.y + 2, z) && open(o.x, o.y + 2, o.z)) return true
    }
    return false
  } catch (e) { return true }                                  // uncertain -> don't block the attempt
}

// ---- HTTP control layer ----
const app = express()
const ok = (res, data) => res.json({ ok: true, ...data })
const err = (res, e) => res.json({ ok: false, error: e.message || String(e) })

app.get('/state', (req, res) => {
  if (!ready) return err(res, new Error('bot not spawned yet'))
  const e = bot.entity
  ok(res, {
    pos: round(e.position),
    yaw: +(bot.entity.yaw).toFixed(2), pitch: +(bot.entity.pitch).toFixed(2),
    health: bot.health, food: bot.food, oxygen: bot.oxygenLevel,
    ...(() => { const w = waterState(bot); return w ? { inWater: w.inWater, submerged: w.submerged, inCurrent: w.current, buried: w.buried } : {} })(),
    onGround: e.onGround, dimension: bot.game.dimension, gameMode: bot.game.gameMode,
    timeOfDay: bot.time.timeOfDay,
    held: heldInfo(),
    lookingAt: (() => { const b = bot.blockAtCursor(5); return b ? { name: b.name, pos: round(b.position) } : null })()
  })
})

app.get('/inventory', (req, res) => {
  if (!ready) return err(res, new Error('not ready'))
  const dur = (i) => (i.maxDurability > 0)
    ? { durability: i.maxDurability - (i.durabilityUsed || 0), maxDurability: i.maxDurability } : {}
  const items = bot.inventory.items().map(i => ({ name: i.name, count: i.count, slot: i.slot, ...dur(i) }))
  // worn armor (slots 5..8) + offhand (45) never show in items() — report them with durability
  const armorNames = ['head', 'torso', 'legs', 'feet']
  const worn = [5, 6, 7, 8].map((s, idx) => {
    const it = bot.inventory.slots[s]
    return it ? { slot: armorNames[idx], name: it.name, ...dur(it) } : null
  }).filter(Boolean)
  const off = bot.inventory.slots[45]
  if (off) worn.push({ slot: 'offhand', name: off.name, ...dur(off) })
  ok(res, { items, worn, emptySlots: bot.inventory.emptySlotCount() })
})

// GET /toss?name=&count=&to= : drop an item for a player to pick up (hand off tools/loot). Faces
// the named player first (via ?to=) so the item lands near them, then tosses. count defaults to
// the whole stack. This is how the bot GIVES — the co-op other half of the helmsman handing me things.
app.get('/toss', async (req, res) => {
  try {
    if (!ready) return err(res, new Error('not ready'))
    const name = req.query.name
    if (!name) return err(res, new Error('name required'))
    const toward = req.query.to
    if (toward && bot.players[toward] && bot.players[toward].entity) {
      try { await bot.lookAt(bot.players[toward].entity.position.offset(0, 0.4, 0), true) } catch (e) {}
    }
    const item = bot.inventory.items().find(i => i.name === name || i.name.includes(name))
    if (!item) return err(res, new Error(`no ${name} in inventory`))
    const n = req.query.count != null ? Math.min(parseInt(req.query.count), item.count) : item.count
    await bot.toss(item.type, null, n)
    ok(res, { tossed: item.name, count: n, toward: toward || null })
  } catch (e) { err(res, e) }
})

app.get('/find', (req, res) => {
  try {
    if (!ready) return err(res, new Error('not ready'))
    const name = req.query.name
    const count = parseInt(req.query.count || '5')
    const radius = parseInt(req.query.radius || '64')
    const ids = resolveBlockIds(name)
    if (!ids.length) return err(res, new Error(`unknown block: ${name}`))
    const here = bot.entity.position
    // FAIRNESS: only report blocks a player here could actually see (exposed + line of sight).
    // ?xray=1 bypasses to the raw spatial index — that IS the cheat, kept for debugging only.
    if (req.query.xray === '1') {
      const positions = bot.findBlocks({ matching: ids, maxDistance: radius, count })
      const results = positions.map(p => ({ pos: { x: p.x, y: p.y, z: p.z }, name: bot.blockAt(p)?.name, dist: +here.distanceTo(p).toFixed(1) })).sort((a, b) => a.dist - b.dist)
      return ok(res, { count: results.length, blocks: results, xray: true })
    }
    // ?sense=1: the 360 SENSE ping — ore exposed to open air within range, NO direct-LOS gate
    // (what a player finds by sweeping their view / rounding corners). Fair: still air-exposed
    // only, no seeing through solid rock. Each hit tagged inSight so confident-vs-sensed stays clear.
    if (req.query.sense === '1') {
      const senseR = parseInt(req.query.radius || '25')
      const exp = findExposed(ids, senseR, count).sort((a, b) => a.dist - b.dist)
      const results = exp.map(v => ({ pos: { x: v.pos.x, y: v.pos.y, z: v.pos.z }, name: bot.blockAt(v.pos)?.name, dist: +v.dist.toFixed(1), inSight: v.inSight }))
      return ok(res, { count: results.length, blocks: results, sensed: true })
    }
    const vis = findVisible(ids, radius, count)
    const results = vis.map(v => ({ pos: { x: v.pos.x, y: v.pos.y, z: v.pos.z }, name: bot.blockAt(v.pos)?.name, dist: +v.dist.toFixed(1) }))
    ok(res, { count: results.length, blocks: results, visibleOnly: true })
  } catch (e) { err(res, e) }
})

// fairness (07-12): an entity sealed behind rock — not sharing my connected air — is imperceptible,
// same rule as ore. ?all=1 is the debug bypass (like /find xray).
// EYE-RAY (07-17, the entity-sense extension the helmsman asked for): the air-flood caps at
// ~34 for cost, but a big cavern, a chasm, or open terrain gives TRUE line of sight far beyond
// it — and the server honestly tracks monsters to ~128. A straight unobstructed ray from my eyes
// is the strictest perception there is: fair by construction, no flood needed. ~0.5-block
// sampling; glass/leaves count as walls (honest: pixel sight, not entity-ESP).
function losClear(from, to) {
  try {
    const d = to.minus(from); const len = d.norm()
    if (len > 160) return false               // past honest server tracking — nothing to see
    const steps = Math.max(1, Math.ceil(len * 2))
    const step = d.scaled(1 / steps)
    let p = from
    for (let i = 1; i < steps; i++) {
      p = p.plus(step)
      const b = bot.blockAt(p.floored())
      if (!b) return false                    // unloaded chunk in the way — can't claim sight
      if (b.boundingBox === 'block') return false
    }
    return true
  } catch (e) { return false }
}
function entityPerceptible(en, fill) {
  try {
    const p = en.position.floored()
    if (touchesFill(p, fill) || fill.cells.has(ck(p.x, p.y, p.z)) || fill.cells.has(ck(p.x, p.y + 1, p.z))) return true
    // OPEN-SKY RULE (07-14, the pig blindness): the flood cap (15k cells) fills a cave but
    // starves on open meadow — surface animals 20 blocks away were reading as "not there."
    // If BOTH of us stand under open sky, no wall can be between us that matters: perceptible.
    // Cave/indoor entities still ride the flood gate — the anti-wallhack floor is untouched.
    const Vec3 = require('vec3').Vec3
    const skyAbove = (v) => {
      for (let y = v.y + 1; y <= Math.min(v.y + 48, 320); y++) {
        const b = bot.blockAt(new Vec3(v.x, y, v.z))
        if (b && b.boundingBox === 'block') return false
        if (!b) break
      }
      return true
    }
    const me = bot.entity.position.floored()
    if (skyAbove(me) && skyAbove(p)) return true
    // last resort: the eye-ray — sight across caverns/chasms the flood can't afford to fill
    return losClear(bot.entity.position.offset(0, 1.62, 0), en.position.offset(0, 1.0, 0))
  } catch (e) { return true }
}
// ---- player locator (07-14, the helmsman's ask: "so we avoid 'where I am' and in case we ever get
// lost from each-other"). Consented co-op sense: live position when the server tracks them,
// last-seen breadcrumb (pos + age + heading) when out of range. Breadcrumbs update every 5s.
const playerCrumbs = {}
setInterval(() => {
  try {
    for (const [name, pl] of Object.entries(bot.players || {})) {
      if (pl && pl.entity && pl.entity.position && name !== bot.username) {
        const prev = playerCrumbs[name]
        playerCrumbs[name] = { pos: pl.entity.position.clone(), t: Date.now(), prev: prev ? { pos: prev.pos, t: prev.t } : null }
      }
    }
  } catch (e) {}
}, 5000)
// /pathdebug?secs=30 — tap the pathfinder's event stream into bot.log for N seconds.
// Built 07-14 night for the doors-v2 hunt: stalls with no error and no movement need the
// planner's own words — path_update statuses and especially path_reset REASONS.
app.get('/pathdebug', (req, res) => {
  try {
    const secs = Math.min(120, parseInt(req.query.secs || '30'))
    const handlers = {
      path_update: (r) => console.log(`[pathdebug] update: status=${r && r.status} pathLen=${r && r.path && r.path.length} cost=${r && r.cost}`),
      path_reset: (reason) => console.log(`[pathdebug] RESET: ${reason}`),
      goal_updated: (goal, dynamic) => console.log(`[pathdebug] goal set (dynamic=${!!dynamic})`),
      goal_reached: () => console.log('[pathdebug] goal REACHED')
    }
    for (const [ev, fn] of Object.entries(handlers)) bot.on(ev, fn)
    setTimeout(() => { try { for (const [ev, fn] of Object.entries(handlers)) bot.removeListener(ev, fn) } catch (e) {} }, secs * 1000)
    ok(res, { tapping: secs })
  } catch (e) { err(res, e) }
})

// /useon?name=<entity>&item=<item> — right-click a creature with a held item: shears on
// sheep, bucket on cow, saddle on horse. The husbandry verb (07-14, built pen-side with the
// first flock waiting). Walks into reach if needed; nearest matching entity within 16.
app.get('/useon', async (req, res) => {
  try {
    if (!ready) return err(res, new Error('not ready'))
    const ename = req.query.name
    const iname = req.query.item
    const it = bot.inventory.items().find(i => i.name === iname)
    if (!it) return err(res, new Error(`no ${iname} in inventory`))
    const here = bot.entity.position
    const target = Object.values(bot.entities)
      .filter(en => en !== bot.entity && en.position && (en.name === ename || en.displayName === ename) && en.position.distanceTo(here) <= 16)
      .sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here))[0]
    if (!target) return err(res, new Error(`no ${ename} within 16`))
    if (target.position.distanceTo(here) > 3) {
      await bot.pathfinder.goto(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2))
    }
    await bot.equip(it, 'hand')
    await bot.lookAt(target.position.offset(0, 0.6, 0), true)
    await bot.waitForTicks(2)
    await bot.useOn(target)
    ok(res, { used: iname, on: ename, at: round(target.position) })
  } catch (e) { err(res, e) }
})
// ---- /strike (07-15): the deliberate single swing — /useon's left-click twin, and THE livestock
// cull verb (first target: a chicken, the helmsman's arrow pipeline). Tier-2 by design: one approach, one
// aimed swing, report what happened. The /fight engage-loop and the combat reflex build on this.
// Doctrine baked in, not left to pilot memory: NEVER strikes players (consent=1 reserved for the
// friendly-fire validation ritual, still refused until damage attribution exists to verify with);
// NEVER melees creepers (detect→flee is law — refuse loudly so the pilot never learns the habit).
app.get('/strike', async (req, res) => {
  try {
    if (!ready) return err(res, new Error('not ready'))
    const ename = req.query.name
    if (!ename) return err(res, new Error('need name='))
    const iname = req.query.item || 'iron_sword'
    const it = bot.inventory.items().find(i => i.name === iname)
    if (!it) return err(res, new Error(`no ${iname} in inventory — refusing to punch with bare hands/wrong tool`))
    const here = bot.entity.position
    const target = Object.values(bot.entities)
      .filter(en => en !== bot.entity && en.position && (en.name === ename || en.displayName === ename) && en.position.distanceTo(here) <= 16)
      .sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here))[0]
    if (!target) return err(res, new Error(`no ${ename} within 16`))
    if (target.type === 'player' || (bot.players && Object.values(bot.players).some(p => p.entity === target))) {
      return err(res, new Error('refusing: never strike players (friendly-fire tests wait for damage attribution)'))
    }
    if (/creeper/.test(String(target.name))) {
      return err(res, new Error('refusing: never melee a creeper — flee is the law'))
    }
    if (target.position.distanceTo(here) > 3) {
      await bot.pathfinder.goto(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2))
    }
    const alreadyHeld = bot.heldItem && bot.heldItem.name === iname
    await bot.equip(it, 'hand')
    // COOLDOWN (learned on the first chicken, 07-15): a slot change resets the 1.9 attack charge —
    // swinging immediately after equip lands a token-damage hit. ~13 ticks recharges a sword fully.
    if (!alreadyHeld) await bot.waitForTicks(13)
    await bot.lookAt(target.position.offset(0, 0.6, 0), true)
    await bot.waitForTicks(2)                      // the tick race: aim packet lands NEXT tick
    const spot = target.position.clone()
    bot.attack(target)
    // watch for the despawn instead of guessing a delay (the 700ms check called a real kill a miss)
    let dead = false
    for (let w = 0; w < 15 && !dead; w++) {
      await new Promise(r => setTimeout(r, 100))
      dead = !bot.entities[target.id] || (target.health !== undefined && target.health <= 0)
    }
    if (dead) {
      try { await bot.pathfinder.goto(new goals.GoalNear(spot.x, spot.y, spot.z, 1)) } catch (e) {}  // hoover the drops
    }
    ok(res, { struck: ename, with: iname, at: round(spot), killed: dead, note: dead ? 'walked to drops' : 'still standing — swing again deliberately' })
  } catch (e) { err(res, e) }
})

// ---- /shoot (07-15, built the day the helmsman handed me a bow): the ranged verb — draw, hold a full
// charge (~1.1s), loose. Bow is my PRIMARY weapon by doctrine (suits pilot latency), and unlike
// /strike it may target creepers — shooting them from range is exactly what the doctrine orders.
// Players stay refused, same as /strike. v1 aim: lookAt with a small distance-scaled elevation
// hold-over (no hawkeye ballistics yet — good inside ~20 blocks; tune the 0.018 live). No
// approach walk: ranged means shoot from where I stand; needs LOS and <=25 blocks.
app.get('/shoot', async (req, res) => {
  try {
    if (!ready) return err(res, new Error('not ready'))
    const ename = req.query.name
    if (!ename) return err(res, new Error('need name='))
    const bow = bot.inventory.items().find(i => i.name === 'bow')
    if (!bow) return err(res, new Error('no bow in inventory'))
    if (!bot.inventory.items().some(i => i.name === 'arrow')) return err(res, new Error('no arrows'))
    const here = bot.entity.position
    const target = Object.values(bot.entities)
      .filter(en => en !== bot.entity && en.position && (en.name === ename || en.displayName === ename) && en.position.distanceTo(here) <= 25)
      .sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here))[0]
    if (!target) return err(res, new Error(`no ${ename} within 25`))
    if (target.type === 'player' || (bot.players && Object.values(bot.players).some(p => p.entity === target))) {
      return err(res, new Error('refusing: never shoot players'))
    }
    const dist = target.position.distanceTo(here)
    await drawAndLoose(target)                      // the same arrow the combat reflex fires
    let dead = false
    for (let w = 0; w < 20 && !dead; w++) {
      await new Promise(r => setTimeout(r, 100))
      dead = !bot.entities[target.id] || (target.health !== undefined && target.health <= 0)
    }
    ok(res, { shot: ename, dist: +dist.toFixed(1), killed: dead, note: dead ? 'down' : 'still up — check where the arrow went (/gaze) and loose again' })
  } catch (e) { err(res, e) }
})
app.get('/where', (req, res) => {
  try {
    if (!ready) return err(res, new Error('not ready'))
    const name = req.query.name || process.env.MC_OWNER
    if (!name) return err(res, new Error('need name= (or set MC_OWNER in the environment for a default)'))
    const me = bot.entity.position
    const live = bot.players && bot.players[name] && bot.players[name].entity && bot.players[name].entity.position
    const fmt = (p) => ({ x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) })
    const bearing = (p) => compass(p.x - me.x, p.z - me.z)
    if (live) {
      return ok(res, { name, live: true, pos: fmt(live), dist: +live.distanceTo(me).toFixed(0), bearing: bearing(live) })
    }
    const c = playerCrumbs[name]
    if (!c) return ok(res, { name, live: false, note: 'never seen this session' })
    let heading = null
    if (c.prev && c.pos.distanceTo(c.prev.pos) > 1) heading = compass(c.pos.x - c.prev.pos.x, c.pos.z - c.prev.pos.z)
    ok(res, { name, live: false, lastSeen: fmt(c.pos), agoSec: Math.round((Date.now() - c.t) / 1000), dist: +c.pos.distanceTo(me).toFixed(0), bearing: bearing(c.pos), heading })
  } catch (e) { err(res, e) }
})
app.get('/entities', (req, res) => {
  try {
    if (!ready) return err(res, new Error('not ready'))
    const radius = parseInt(req.query.radius || '24')
    const here = bot.entity.position
    const fill = req.query.all === '1' ? null : airFlood({ radius: Math.min(radius + 4, 34), cap: 15000 })
    const list = Object.values(bot.entities)
      .filter(en => en !== bot.entity && en.position && en.position.distanceTo(here) <= radius)
      .filter(en => !fill || entityPerceptible(en, fill))
      .map(en => ({
        type: en.type, name: en.name || en.username || en.displayName,
        pos: round(en.position), dist: +en.position.distanceTo(here).toFixed(1)
      }))
      .sort((a, b) => a.dist - b.dist).slice(0, 30)
    ok(res, { count: list.length, entities: list })
  } catch (e) { err(res, e) }
})

// snapFloor: nudge a straight-line waypoint onto a real standable cell so a staged hop doesn't
// target a point buried in rock or floating in air (which just thrashes). Scan a few blocks up/down
// from the interpolated y for the first solid floor, return the air cell right above it.
// pathfinder.stop() while the pathfinder is IDLE latches a pending stop that silently aborts the
// NEXT path ("Path was stopped before it could be completed" on a perfectly good goal — the
// long-mysterious "stale latch"). Only ever stop a pathfinder that actually has a goal or motion.
function safeStop () {
  try { if (bot.pathfinder.goal || bot.pathfinder.isMoving()) bot.pathfinder.stop() } catch (e) {}
}

function snapFloor (Vec3, wp) {
  const fx = Math.floor(wp.x), fz = Math.floor(wp.z), fy = Math.floor(wp.y)
  for (let dy = 2; dy >= -4; dy--) {
    const b = bot.blockAt(new Vec3(fx, fy + dy, fz))
    if (b && b.boundingBox === 'block') return new Vec3(fx, fy + dy + 1, fz)
  }
  return new Vec3(fx, fy, fz)
}

// stagedGoto: the navigation workhorse. Wraps bot.pathfinder.goto with (1) a STALL DETECTOR — if the
// pathfinder claims it's moving but the bot makes no real progress for ~stallMs, it's wedged (almost
// always a canDig=false route that would need digging), so we STOP and hand back to the pilot with a
// clear reason instead of bobbing forever; and (2) AUTO-STAGING — on a "took too long" planning
// timeout, march toward the goal in ~segLen-block hops (each floor-snapped) so long routes don't die.
// Returns {arrived, method, reason, hint}. NEVER digs — a blocked route is the pilot's call to make.
async function stagedGoto (dest, range = 2, { stallMs = 4500, segLen = 18, maxSegs = 16 } = {}) {
  // stallMs 3000→4500 (07-15): the 3s killer fired BEFORE upstream's 3.5s futility reset could
  // recover (doors-v2 lesson) — door-opening dances and post-boot chunk lag both read as stalls.
  const Vec3 = require('vec3').Vec3
  const moving = () => { try { return bot.pathfinder.isMoving() } catch (e) { return false } }
  // one guarded goto attempt: resolves {done} | {stalled} | {timeout,reason} | {reason}
  const guarded = async (gx, gy, gz, grange) => {
    let stalled = false
    let last = bot.entity.position.clone(); let lastT = Date.now()
    const watch = setInterval(() => {
      const p = bot.entity.position
      if (p.distanceTo(last) >= 1.0) { last = p.clone(); lastT = Date.now() }
      else if (Date.now() - lastT > stallMs && moving()) { stalled = true; try { bot.pathfinder.stop() } catch (e) {} }
    }, 400)
    try { await bot.pathfinder.goto(new goals.GoalNear(gx, gy, gz, grange)); return { done: true } }
    catch (e) {
      if (stalled) return { stalled: true }
      // "too?" — upstream mineflayer-pathfinder throws the TYPO'd "Took to long to decide path";
      // matching only the correct spelling silently disabled auto-staging (caught live 07-11)
      return { timeout: /took too? long|timeout|timed out/i.test(e.message || ''), stopped: /stopped before/i.test(e.message || ''), reason: (e.message || '').slice(0, 60) }
    } finally { clearInterval(watch) }
  }

  const near = () => bot.entity.position.distanceTo(dest) <= range + 1.5
  const stallBail = () => ({ arrived: false, reason: `stalled — no progress for ${stallMs / 1000}s`, hint: 'goal is likely unreachable without digging; decide if it is worth a /dig_stair or /dig_tunnel, or pick a reachable point' })

  // self-trapped? a canDig=false walker with NO legal first move gets a cryptic "Path was stopped"
  // from the pathfinder — say the real thing (the helmsman had to be my eyes for this once; never again)
  if (!hasLegalMove()) return { arrived: false, reason: 'no legal walker move exists from where I stand — boxed in (did I dig around my own feet?)', hint: 'dig out deliberately (/dig_stair toward open space); the pathfinder cannot help from here' }

  // reachability PRE-CHECK: a walled goal used to burn the pathfinder's whole ~10s search before it
  // said "no path" — the air flood-fill answers "does an air path even EXIST?" in ~ms. Conservative:
  // only 'sealed'/'walled' bail here; 'connected'/'inconclusive' still go to the pathfinder, which
  // owns real walkability (climbs, drops, gaps). Same hard handoff as ever: NO auto-dig.
  const pre = airPrecheck(dest, range)
  if (pre.verdict === 'sealed') return { arrived: false, reason: 'goal is sealed inside solid rock (no open cell within range of it)', hint: 'pick an open cell, or carve to it deliberately — /dig_stair or /dig_tunnel, your call' }
  if (pre.verdict === 'walled') return { arrived: false, reason: `walled off — no air path connects here to the goal (checked ${pre.cells} cells in ${pre.ms}ms)`, hint: 'reachable only by digging; decide if a /dig_stair or /dig_tunnel is worth it, or pick an open point' }
  const noPathHint = (reason) => /no path/i.test(reason || '') ? 'the goal is walled off for a walker (canDig=false) — reachable only by digging; decide if a /dig_stair or /dig_tunnel is worth it, or pick an open point' : undefined

  let r = await guarded(dest.x, dest.y, dest.z, range)                // direct attempt
  // a 'done' that DIDN'T actually arrive = a stale goal_reached latch (seen right after /unfollow —
  // the pilot-handoff path). Don't trust a bare 'done'; verify arrival and retry once cleanly.
  if (r.done && !near()) { safeStop(); await new Promise(rz => setTimeout(rz, 150)); r = await guarded(dest.x, dest.y, dest.z, range) }
  if (r.done && near()) return { arrived: true, method: 'direct' }
  // the pathfinder often walks a good partial path before its plan dies — if that already carried
  // us within range, that IS arrival; don't report a failure from beside the goal
  if (near()) return { arrived: true, method: 'partial' }
  if (r.stalled) {                                  // THE WEDGE DRILL, AUTOMATED (07-15, the helmsman's ask):
    await new Promise(rz => setTimeout(rz, 700))    // manual "/stop then retry" cleared every wedge
    // stalled NEXT TO a door/gate = the diagonal-through-the-jamb failure — do the helmsman's maneuver
    // (square up, commit straight through) before asking the pathfinder to try again
    let crossed = false
    try { crossed = await doorwayCommit() } catch (e) { console.log('[doorway] commit failed: ' + e.message) }
    r = await guarded(dest.x, dest.y, dest.z, range) // for 3 sessions — the body does the drill itself
    if (r.done && near()) return { arrived: true, method: crossed ? 'doorway-commit' : 'retry-after-stall' }
    if (near()) return { arrived: true, method: 'partial' }
    if (r.stalled) return stallBail()               // stalled TWICE = genuinely blocked, say so
  }                                                 // other retry outcomes fall through the ladder below
  if (r.stopped) {                                  // stopped EXTERNALLY (a just-finished /collect,
    await new Promise(rz => setTimeout(rz, 350))    // a plugin's internal stop) — one clean retry
    r = await guarded(dest.x, dest.y, dest.z, range)
    if (r.done && near()) return { arrived: true, method: 'retry-after-stop' }
    if (r.stalled) return stallBail()
    if (r.stopped) return { arrived: false, reason: 'something external keeps stopping the pathfinder (often a just-finished /collect or a running job)', hint: 'check /jobs, wait a beat, try again' }
  }
  if (r.done && !near()) return { arrived: false, reason: 'pathfinder said done but the bot did not move (stale goal state)', hint: 'just call /goto again — the stale latch clears after one attempt' }
  if (!r.timeout) return { arrived: false, reason: r.reason || 'no path', hint: noPathHint(r.reason) }   // hard blocked / bad goal

  // planning timed out → segmented march toward the goal, ~segLen blocks per hop
  for (let i = 0; i < maxSegs; i++) {
    const cur = bot.entity.position
    const remaining = cur.distanceTo(dest)
    if (remaining <= range + 1) return { arrived: true, method: 'staged' }
    const t = Math.min(1, segLen / remaining)
    const wp = snapFloor(Vec3, new Vec3(cur.x + (dest.x - cur.x) * t, cur.y + (dest.y - cur.y) * t, cur.z + (dest.z - cur.z) * t))
    const before = cur.clone()
    const sr = await guarded(wp.x, wp.y, wp.z, 2)
    if (sr.stalled) return { arrived: false, reason: `stalled mid-route (~${Math.round(remaining)} blocks out)`, hint: 'the way is blocked / needs digging — your call whether to carve it' }
    if (bot.entity.position.distanceTo(before) < 1) return { arrived: false, reason: 'a staged hop made no progress — route blocked', hint: 'manual nav or a deliberate dig needed here' }
  }
  return { arrived: false, reason: 'used the whole segment budget without arriving', hint: 'try again to continue, or shorten the goal' }
}

app.get('/goto', async (req, res) => {
  try {
    const Vec3 = require('vec3').Vec3
    const x = parseFloat(req.query.x), y = parseFloat(req.query.y), z = parseFloat(req.query.z)
    if (![x, y, z].every(Number.isFinite)) return err(res, new Error('x, y, z required'))
    const range = parseInt(req.query.range || '1')
    const r = await stagedGoto(new Vec3(x, y, z), range)
    if (!r.arrived) { safeStop(); try { bot.clearControlStates() } catch (e) {} }  // leave a clean stop so the bot doesn't drift on a give-up
    ok(res, { arrived: r.arrived, method: r.method || null, reason: r.reason || null, hint: r.hint || null, pos: round(bot.entity.position) })
  } catch (e) { err(res, e) }
})

app.get('/come', async (req, res) => {
  try {
    if (!ready) return err(res, new Error('not ready'))
    const range = parseInt(req.query.range || '2')
    // PLAYERS first (07-14): "/come?name=<player>" used to fail — this verb only ever
    // knew blocks. Live entity if tracked, else the last-seen breadcrumb from /where.
    const who = req.query.name && bot.players && bot.players[req.query.name]
    if (who || playerCrumbs[req.query.name]) {
      const target = (who && who.entity && who.entity.position) || (playerCrumbs[req.query.name] && playerCrumbs[req.query.name].pos)
      if (!target) return err(res, new Error(`${req.query.name} is online but never seen — no position to walk to`))
      await bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, range))
      return ok(res, { reached: round(target), pos: round(bot.entity.position), player: req.query.name })
    }
    const ids = resolveBlockIds(req.query.name)
    const b = nearestVisible(ids, parseInt(req.query.radius || '64'))
    if (!b) return err(res, new Error(`no visible ${req.query.name} found`))
    await bot.pathfinder.goto(new goals.GoalNear(b.position.x, b.position.y, b.position.z, range))
    ok(res, { reached: round(b.position), pos: round(bot.entity.position) })
  } catch (e) { err(res, e) }
})

app.get('/mine', async (req, res) => {
  try {
    const name = req.query.name
    const count = parseInt(req.query.count || '1')
    const radius = parseInt(req.query.radius || '64')
    const ids = resolveBlockIds(name)
    if (!ids.length) return err(res, new Error(`unknown block: ${name}`))
    let mined = 0
    for (let i = 0; i < count; i++) {
      const b = nearestVisible(ids, radius)
      if (!b) break
      await bot.collectBlock.collect(b)
      mined++
    }
    const have = bot.inventory.items().filter(it => it.name.includes(name) || name.includes(it.name))
      .reduce((s, it) => s + it.count, 0)
    ok(res, { mined, requested: count, inventoryMatching: have })
  } catch (e) { err(res, e) }
})

app.get('/collect', async (req, res) => {
  try {
    const radius = parseInt(req.query.radius || '16')
    const here = bot.entity.position
    const drops = Object.values(bot.entities).filter(e => e.name === 'item' && e.position.distanceTo(here) <= radius)
    let got = 0
    for (const d of drops) {
      try { await bot.pathfinder.goto(new goals.GoalNear(d.position.x, d.position.y, d.position.z, 1)); got++ } catch {}
    }
    ok(res, { walkedTo: got })
  } catch (e) { err(res, e) }
})

app.get('/craft', async (req, res) => {
  try {
    const Vec3 = require('vec3').Vec3
    const item = resolveItem(req.query.item)
    if (!item) return err(res, new Error(`unknown item: ${req.query.item}`))
    const count = Math.max(1, parseInt(req.query.count || '1'))

    // Does this recipe need a 3x3 table? (craftable WITH an assumed table but not without one)
    const needsTable = !bot.recipesFor(item.id, null, 1, null).length && !!bot.recipesFor(item.id, null, 1, true).length
    // Tableless 2x2 crafting desyncs on 1.21.x: the client simulates the craft (materials down,
    // output up) but the server never performs it, and the next sync deletes the output. Route
    // every craft through a real table when one is reachable or in the bag; 2x2 only as last resort.
    const canUseTable = !!bot.recipesFor(item.id, null, 1, true).length
    const tableAvailable = !!bot.findBlock({ matching: resolveBlockIds('crafting_table'), maxDistance: 16 }) ||
                           !!bot.inventory.items().find(i => i.name === 'crafting_table')
    const useTable = needsTable || (canUseTable && tableAvailable)
    let placedTable = null
    if (useTable) {
      const near = bot.findBlock({ matching: resolveBlockIds('crafting_table'), maxDistance: 16 })
      if (near) {
        // walk within reach of an existing table (fixes today's "table 4 blocks away" failure)
        try { await bot.pathfinder.goto(new goals.GoalNear(near.position.x, near.position.y, near.position.z, 3)) } catch (e) {}
      } else {
        // no table anywhere — place one from inventory (if we have it) and reclaim it afterward
        const tableItem = bot.inventory.items().find(i => i.name === 'crafting_table')
        if (tableItem) {
          const base = bot.entity.position.floored()
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const sb = bot.blockAt(base.offset(dx, 0, dz)), bb = bot.blockAt(base.offset(dx, -1, dz))
            if (sb && sb.name === 'air' && bb && bb.boundingBox === 'block') {
              await bot.equip(tableItem, 'hand')
              await bot.lookAt(base.offset(dx, 0, dz).offset(0.5, 0.5, 0.5), true)
              await bot.placeBlock(bb, new Vec3(0, 1, 0))
              placedTable = base.offset(dx, 0, dz)
              break
            }
          }
        }
      }
    }

    // count means ITEMS, not recipes (the 12-log lesson): one recipe pass may yield several
    // items (planks 4, sticks 4, torches 4) — stop as soon as we've made enough.
    let made = 0, lastErr = null
    while (made < count) {
      const t = useTable ? bot.findBlock({ matching: resolveBlockIds('crafting_table'), maxDistance: 4 }) : null
      const recipes = bot.recipesFor(item.id, null, 1, t)
      if (!recipes.length) { lastErr = `out of materials/recipe after ${made}${useTable ? ` (table nearby: ${!!t})` : ''}`; break }
      const perCraft = (recipes[0].result && recipes[0].result.count) || 1
      try { await bot.craft(recipes[0], 1, t || undefined); made += perCraft }
      catch (e) { lastErr = e.message; break }
    }

    let reclaimedTable = false
    if (placedTable) {   // put our temporary table back in the bag — leave no litter
      try { const tb = bot.blockAt(placedTable); if (tb && tb.name === 'crafting_table') { await bot.collectBlock.collect(tb); reclaimedTable = true } } catch (e) {}
    }

    const nowHave = bot.inventory.items().filter(it => it.name === item.name).reduce((s, it) => s + it.count, 0)
    if (made === 0) return err(res, new Error(lastErr || 'craft failed'))
    ok(res, { crafted: item.name, requested: count, made, usedTable: useTable, placedTable: !!placedTable, reclaimedTable, nowHave, note: lastErr || undefined })
  } catch (e) { err(res, e) }
})

app.get('/place', async (req, res) => {
  try {
    const Vec3 = require('vec3').Vec3
    const name = req.query.name
    const it = bot.inventory.items().find(i => i.name === name)
    if (!it) return err(res, new Error(`no ${name} in inventory`))
    await bot.equip(it, 'hand')
    // find an adjacent ground spot: air at foot level with solid block beneath
    const base = bot.entity.position.floored()
    const dirs = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
    let placed = null
    for (const [dx, , dz] of dirs) {
      const spot = base.offset(dx, 0, dz)
      const below = base.offset(dx, -1, dz)
      const spotBlock = bot.blockAt(spot)
      const belowBlock = bot.blockAt(below)
      if (spotBlock && spotBlock.name === 'air' && belowBlock && belowBlock.boundingBox === 'block') {
        await bot.lookAt(spot.offset(0.5, 0.5, 0.5), true)
        await bot.placeBlock(belowBlock, new Vec3(0, 1, 0))
        placed = below
        break
      }
    }
    if (!placed) return err(res, new Error('no valid adjacent ground spot'))
    ok(res, { placed: name, on: round(placed) })
  } catch (e) { err(res, e) }
})

app.get('/equip', async (req, res) => {
  try {
    const it = bot.inventory.items().find(i => i.name === req.query.name)
    if (!it) return err(res, new Error(`no ${req.query.name}`))
    await bot.equip(it, req.query.dest || 'hand')
    ok(res, { equipped: req.query.name })
  } catch (e) { err(res, e) }
})
// GET /eat?food=<name> — MANUAL eating. We deliberately did NOT install auto-eat: food is the
// pilot's job (mine). Equips the named food, or the most-filling edible in the inventory if none is
// named, then consumes it. Watch food level in /scene and call this yourself. Restores held item after.
app.get('/eat', async (req, res) => {
  try {
    const want = req.query.food
    const items = bot.inventory.items()
    const foods = (mcData && mcData.foods) || {}
    let food = null
    if (want) food = items.find(i => i.name === want) || items.find(i => i.name.includes(want))
    if (!food) {   // best available: highest foodPoints among edible items
      food = items.filter(i => foods[i.type])
        .sort((a, b) => (foods[b.type].foodPoints || 0) - (foods[a.type].foodPoints || 0))[0]
    }
    if (!food) return err(res, new Error('no food in inventory'))
    const prevHeld = bot.heldItem
    const before = bot.food
    await bot.equip(food, 'hand')
    await bot.consume()
    try { if (prevHeld && prevHeld.type !== food.type) await bot.equip(prevHeld, 'hand') } catch (e) {}
    ok(res, { ate: food.name, foodBefore: before, foodNow: bot.food })
  } catch (e) { err(res, e) }
})

app.get('/lookat', async (req, res) => {
  try {
    const Vec3 = require('vec3').Vec3
    await bot.lookAt(new Vec3(parseFloat(req.query.x), parseFloat(req.query.y), parseFloat(req.query.z)), true)
    ok(res, { yaw: +bot.entity.yaw.toFixed(2), pitch: +bot.entity.pitch.toFixed(2) })
  } catch (e) { err(res, e) }
})

app.get('/chat', (req, res) => { bot.chat(req.query.msg || ''); ok(res, { said: req.query.msg }) })
app.get('/chatlog', (req, res) => {
  const since = parseInt(req.query.since || '0')
  ok(res, { cursor: chatSeq, messages: chatLog.filter(m => m.id > since) })
})
app.get('/stop', (req, res) => { try { stopFollow() } catch {} ; safeStop(); try { bot.clearControlStates() } catch {} ; const jobsCancelled = jobs.stopAll(); ok(res, { stopped: true, jobsCancelled }) })
// GET /tidy — reclaim scaffolding the pathfinder left behind. Mines back every still-standing
// scaffold block the bot placed while navigating (tracked in navPlaced), collecting the material,
// leaving the world as it found it. ?dry=1 reports the pending count without mining.
app.get('/tidy', async (req, res) => {
  try {
    const Vec3 = require('vec3').Vec3
    const scaffold = new Set(['cobblestone', 'dirt'])
    if (req.query.dry === '1') return ok(res, { pending: navPlaced.length, blocks: navPlaced.slice(0, 20) })
    const todo = navPlaced.splice(0)                       // take & clear the queue
    const here = bot.entity.position
    todo.sort((a, b) => here.distanceTo(new Vec3(a.x, a.y, a.z)) - here.distanceTo(new Vec3(b.x, b.y, b.z)))
    let reclaimed = 0, alreadyGone = 0, failed = 0
    for (const p of todo) {
      const b = bot.blockAt(new Vec3(p.x, p.y, p.z))
      if (!b || !scaffold.has(b.name)) { alreadyGone++; continue }  // already gone / not scaffold
      try { await bot.collectBlock.collect(b); reclaimed++ }
      catch (e) { failed++; navPlaced.push(p) }                     // unreachable now — requeue
    }
    ok(res, { reclaimed, alreadyGone, failed, remaining: navPlaced.length })
  } catch (e) { err(res, e) }
})
app.get('/job_stop', (req, res) => { const stopped = jobs.stop(parseInt(req.query.id)); ok(res, { stopped }) })

// continuous follow via pathfinder's dynamic GoalFollow (auto-repaths as target moves).
// SUPERVISED since 07-16: bare GoalFollow had no stall recovery — it wedged at the east door
// twice (once mid-emergency; "you do tarry") while /goto's wedge drill sat one verb over.
// A 400ms watcher now runs the same drill (stop → 700ms → doorwayCommit → re-arm) whenever the
// bot stops progressing while the target is beyond range, and quietly re-acquires the target
// entity when it drops out of tracking (one honest event, no alarm spam).
let followState = null
function stopFollow () {
  if (!followState) return
  try { clearInterval(followState.timer) } catch (e) {}
  followState = null
}
app.get('/follow', (req, res) => {
  try {
    const name = req.query.name
    const range = parseInt(req.query.range || '2')
    const target = (bot.players[name] && bot.players[name].entity)
    if (!target) return err(res, new Error(`player '${name}' not in view (get closer or check name)`))
    stopFollow()
    bot.pathfinder.setGoal(new goals.GoalFollow(target, range), true)
    const st = { name, range, lastPos: bot.entity.position.clone(), lastT: Date.now(), drilling: false, lostT: 0, warnT: 0 }
    st.timer = setInterval(async () => {
      if (followState !== st || st.drilling) return
      try {
        const ent = bot.players[st.name] && bot.players[st.name].entity
        if (!ent) {                                    // target untracked (out of range / relogged)
          if (!st.lostT) st.lostT = Date.now()
          else if (st.lostT > 0 && Date.now() - st.lostT > 12000) {
            st.lostT = -1                              // said it once; keep watching silently
            emitEvent('follow', `lost sight of ${st.name} — holding until they're back in view`)
          }
          return
        }
        if (st.lostT) {                                // re-acquired: GoalFollow holds a dead entity ref, re-arm on the live one
          st.lostT = 0
          bot.pathfinder.setGoal(new goals.GoalFollow(ent, st.range), true)
        }
        const p = bot.entity.position
        if (p.distanceTo(st.lastPos) >= 1.0) { st.lastPos = p.clone(); st.lastT = Date.now(); return }
        if (ent.position.distanceTo(p) <= st.range + 1.5) { st.lastT = Date.now(); return }   // parked next to them = not a stall
        if (Date.now() - st.lastT < 4500) return       // same patience as stagedGoto (doors-v2 lesson)
        st.drilling = true                             // wedged while the target walks away — the drill
        console.log('[follow] wedged — running the doorway drill')
        try {
          // HARD goal clear, not safeStop: GoalFollow is DYNAMIC — a stop leaves it set and the
          // pathfinder resumes re-planning toward the target DURING the drill, fighting nudgeInto
          // for the control states every tick (found live 07-16: same door, same drill — goto's
          // drill crossed clean, follow's lost the threshold 3x. The legs need ONE owner.)
          try { bot.pathfinder.setGoal(null) } catch (e) {}
          try { bot.clearControlStates() } catch (e) {}
          await new Promise(r => setTimeout(r, 700))
          let crossed = false
          try { crossed = await doorwayCommit() } catch (e) { console.log('[follow] drill error: ' + e.message) }
          const live = followState === st && bot.players[st.name] && bot.players[st.name].entity
          if (live) bot.pathfinder.setGoal(new goals.GoalFollow(live, st.range), true)
          st.lastPos = bot.entity.position.clone(); st.lastT = Date.now()
          if (crossed) console.log('[follow] through clean — following resumed')
          else if (Date.now() - st.warnT > 30000) {    // drill keeps retrying ~5s; the EVENT stays rare
            st.warnT = Date.now()
            emitEvent('follow', `wedged following ${st.name} and the doorway drill did not clear it — may need help`)
          }
        } finally { st.drilling = false }
      } catch (e) {}
    }, 400)
    followState = st
    ok(res, { following: name, range, supervised: true })
  } catch (e) { err(res, e) }
})
app.get('/unfollow', (req, res) => {
  try { stopFollow(); bot.pathfinder.setGoal(null); bot.clearControlStates(); ok(res, { unfollowed: true }) } catch (e) { err(res, e) }
})

// lay a rectangular perimeter (foundation outline). Walks each border cell, finds the
// ground column there, and places a block on top of it. x,z = a corner; w,d = size.
app.get('/outline', async (req, res) => {
  try {
    const Vec3 = require('vec3').Vec3
    const x0 = Math.floor(parseFloat(req.query.x))
    const z0 = Math.floor(parseFloat(req.query.z))
    const w = parseInt(req.query.w || '7')
    const d = parseInt(req.query.d || '7')
    const name = req.query.name || 'oak_planks'
    const startY = Math.floor(parseFloat(req.query.y || bot.entity.position.y))
    const cells = []
    for (let i = 0; i < w; i++) for (let j = 0; j < d; j++) {
      if (i === 0 || i === w - 1 || j === 0 || j === d - 1) cells.push([x0 + i, z0 + j])
    }
    let placed = 0, skipped = 0, failed = 0
    for (const [x, z] of cells) {
      const it = bot.inventory.items().find(k => k.name === name)
      if (!it) { failed++; continue }
      let ground = null
      for (let y = startY + 4; y > startY - 6; y--) {
        const b = bot.blockAt(new Vec3(x, y, z))
        if (b && b.boundingBox === 'block') { ground = b; break }
      }
      if (!ground) { failed++; continue }
      const target = ground.position.offset(0, 1, 0)
      const tb = bot.blockAt(target)
      if (tb && tb.name !== 'air') { skipped++; continue }
      try {
        await bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 2))
        await bot.equip(it, 'hand')
        await bot.lookAt(target.offset(0.5, 0.5, 0.5), true)
        await bot.placeBlock(ground, new Vec3(0, 1, 0))
        placed++
      } catch (e) { failed++ }
    }
    ok(res, { placed, skipped, failed, footprint: `${w}x${d}`, corner: { x: x0, z: z0 }, material: name })
  } catch (e) { err(res, e) }
})

// ---- chest / container interaction ----
// resolve the target chest: exact x,y,z when given (the attic library has many), else nearest
function targetChest(q) {
  if (q.x != null && q.y != null && q.z != null) {
    const Vec3 = require('vec3').Vec3
    const b = bot.blockAt(new Vec3(parseInt(q.x), parseInt(q.y), parseInt(q.z)))
    if (!b || !b.name.includes('chest')) throw new Error(`no chest at ${q.x},${q.y},${q.z} (${b ? b.name : 'unloaded'})`)
    return b
  }
  return bot.findBlock({ matching: resolveBlockIds('chest'), maxDistance: 12 })
}
app.get('/chest', async (req, res) => {
  try {
    const cb = targetChest(req.query)
    if (!cb) return err(res, new Error('no chest within 12'))
    await bot.pathfinder.goto(new goals.GoalNear(cb.position.x, cb.position.y, cb.position.z, 2))
    const chest = await bot.openContainer(cb)
    const items = chest.containerItems().map(i => ({ name: i.name, count: i.count }))
    chest.close()
    ok(res, { at: round(cb.position), items })
  } catch (e) { err(res, e) }
})
app.get('/withdraw', async (req, res) => {
  try {
    const name = req.query.name
    const count = parseInt(req.query.count || '64')
    const cb = targetChest(req.query)
    if (!cb) return err(res, new Error('no chest within 12'))
    await bot.pathfinder.goto(new goals.GoalNear(cb.position.x, cb.position.y, cb.position.z, 2))
    const chest = await bot.openContainer(cb)
    const item = chest.containerItems().find(i => i.name === name) || chest.containerItems().find(i => i.name.includes(name))
    if (!item) { chest.close(); return err(res, new Error(`no ${name} in chest`)) }
    const take = Math.min(count, item.count)
    await chest.withdraw(item.type, null, take)
    chest.close()
    ok(res, { withdrew: item.name, count: take })
  } catch (e) { err(res, e) }
})
// deposit items FROM inventory INTO the nearest chest. name is fuzzy (e.g. "log" ->
// every *_log stack); count omitted = deposit ALL matching. Returns how many moved and
// the running total of that item now in the chest (handy for "gather to N in the chest").
app.get('/deposit', async (req, res) => {
  try {
    const name = req.query.name
    if (!name) return err(res, new Error('name required'))
    const want = req.query.count != null ? parseInt(req.query.count) : Infinity
    const cb = targetChest(req.query)
    if (!cb) return err(res, new Error('no chest within 12'))
    await bot.pathfinder.goto(new goals.GoalNear(cb.position.x, cb.position.y, cb.position.z, 2))
    const chest = await bot.openContainer(cb)
    const matches = bot.inventory.items().filter(it => it.name === name || it.name.includes(name))
    if (!matches.length) { chest.close(); return err(res, new Error(`no ${name} in inventory`)) }
    let remaining = want, deposited = 0
    try {
      for (const it of matches) {
        if (remaining <= 0) break
        const take = Math.min(it.count, remaining)
        await chest.deposit(it.type, null, take)
        deposited += take; remaining -= take
      }
    } catch (e) {
      const inChest = chest.containerItems().filter(i => i.name === name || i.name.includes(name)).reduce((s, i) => s + i.count, 0)
      chest.close()
      return err(res, new Error(`deposited ${deposited} then failed (chest full?): ${e.message}; ${name} in chest now ${inChest}`))
    }
    const inChest = chest.containerItems().filter(i => i.name === name || i.name.includes(name)).reduce((s, i) => s + i.count, 0)
    chest.close()
    ok(res, { deposited, item: name, inChestNow: inChest })
  } catch (e) { err(res, e) }
})

// ---- raise walls: perimeter columns to a uniform height, with a doorway ----
app.get('/walls', async (req, res) => {
  try {
    const Vec3 = require('vec3').Vec3
    const x0 = Math.floor(parseFloat(req.query.x))
    const z0 = Math.floor(parseFloat(req.query.z))
    const w = parseInt(req.query.w || '7')
    const d = parseInt(req.query.d || '7')
    const h = parseInt(req.query.h || '3')
    const base = Math.floor(parseFloat(req.query.base || bot.entity.position.y))
    const baseMat = req.query.base_name || 'cobblestone'
    const wallMat = req.query.name || 'oak_planks'
    const doorSide = req.query.door || 'west'
    const perim = []
    for (let i = 0; i < w; i++) for (let j = 0; j < d; j++) {
      if (i === 0 || i === w - 1 || j === 0 || j === d - 1) perim.push([x0 + i, z0 + j])
    }
    let doorCell
    if (doorSide === 'west') doorCell = [x0, z0 + Math.floor(d / 2)]
    else if (doorSide === 'east') doorCell = [x0 + w - 1, z0 + Math.floor(d / 2)]
    else if (doorSide === 'north') doorCell = [x0 + Math.floor(w / 2), z0]
    else doorCell = [x0 + Math.floor(w / 2), z0 + d - 1]
    const isDoor = (x, z) => x === doorCell[0] && z === doorCell[1]
    let placed = 0, skipped = 0, failed = 0
    for (const [x, z] of perim) {
      try { await bot.pathfinder.goto(new goals.GoalNear(x, base, z, 2)) } catch (e) {}
      for (let k = 0; k < h; k++) {
        if (isDoor(x, z) && k < 2) continue          // leave a 2-high doorway
        const y = base + k
        const target = new Vec3(x, y, z)
        const tb = bot.blockAt(target)
        if (tb && tb.boundingBox === 'block') { skipped++; continue }
        const ref = bot.blockAt(new Vec3(x, y - 1, z))
        if (!ref || ref.boundingBox !== 'block') { failed++; continue }
        const matName = (k === 0) ? baseMat : wallMat
        let it = bot.inventory.items().find(m => m.name === matName)
        if (!it) it = bot.inventory.items().find(m => m.name === wallMat || m.name === baseMat)
        if (!it) { failed++; continue }
        try {
          await bot.equip(it, 'hand')
          await bot.lookAt(target.offset(0.5, 0.5, 0.5), true)
          await bot.placeBlock(ref, new Vec3(0, 1, 0))
          placed++
        } catch (e) { failed++ }
      }
    }
    ok(res, { placed, skipped, failed, size: `${w}x${d}`, height: h, door: doorSide })
  } catch (e) { err(res, e) }
})

// dig a specific block by coordinate (no-op if already air)
app.get('/digat', async (req, res) => {
  try {
    const Vec3 = require('vec3').Vec3
    const p = new Vec3(Math.floor(parseFloat(req.query.x)), Math.floor(parseFloat(req.query.y)), Math.floor(parseFloat(req.query.z)))
    const b = bot.blockAt(p)
    if (!b || b.name === 'air') return ok(res, { already: 'air', at: round(p) })
    // only WALK if out of arm's reach — a deliberately positioned pilot digs from where they stand
    // (the old unconditional goto failed on ore embedded in rock with no walkable cell within 3)
    const eyeDist = bot.entity.position.offset(0, 1.62, 0).distanceTo(p.offset(0.5, 0.5, 0.5))
    if (eyeDist > 4.2) await bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 3))
    await equipPickFor(b.name)             // auto-upgrade the pick so a drop is never destroyed
    await bot.dig(b)
    ok(res, { dug: b.name, at: round(p), with: bot.heldItem ? bot.heldItem.name : null })
  } catch (e) { err(res, e) }
})

// place a held item at a specific coordinate, using the block below as reference (doors, blocks)
// /blockat?x=&y=&z= — identity + block STATE (facing/half/open/lit...) of one block. The
// self-sufficiency verb for orientation questions (stairs, doors, furnaces): no more asking
// the co-pilot which way a thing points. Fairness: same LOS gate as all sight — a block I
// can't honestly see returns an error, not an answer.
app.get('/blockat', (req, res) => {
  try {
    const Vec3 = require('vec3').Vec3
    const x = Math.floor(parseFloat(req.query.x)), y = Math.floor(parseFloat(req.query.y)), z = Math.floor(parseFloat(req.query.z))
    const b = bot.blockAt(new Vec3(x, y, z))
    if (!b) return err(res, new Error('unloaded chunk'))
    if (!canSeeBlock({ x, y, z }, 20)) return err(res, new Error('not in my line of sight — walk closer or clear the view first'))
    const out = { name: b.name, at: { x, y, z }, properties: b.getProperties() }
    if (b.name.includes('sign')) {
      try {
        const [front, back] = typeof b.getSignText === 'function' ? b.getSignText() : [b.signText, null]
        out.text = { front: front || '', back: back || '' }
      } catch (e) { out.text = { error: e.message } }
    }
    ok(res, out)
  } catch (e) { err(res, e) }
})

// /activate?x=&y=&z= (07-15, built to claim my bed) — generic block right-click: beds (set spawn),
// levers, buttons, anything interactive that isn't an entity (/useon) or a door (pathfinder+manners
// own those). LOS-gated like /blockat — I only press what I can see. Walks into reach if needed.
// Door/gate activations still flow through the manners wrap (this calls the same wrapped function),
// so even a manual /activate on a door gets remembered and closed behind me.
app.get('/activate', async (req, res) => {
  try {
    const Vec3 = require('vec3').Vec3
    const x = Math.floor(parseFloat(req.query.x)), y = Math.floor(parseFloat(req.query.y)), z = Math.floor(parseFloat(req.query.z))
    const b = bot.blockAt(new Vec3(x, y, z))
    if (!b) return err(res, new Error('unloaded chunk'))
    if (!canSeeBlock({ x, y, z }, 20)) return err(res, new Error('not in my line of sight — walk closer or clear the view first'))
    if (bot.entity.position.distanceTo(new Vec3(x + 0.5, y + 0.5, z + 0.5)) > 3.5) {
      await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 2))
    }
    await bot.lookAt(new Vec3(x + 0.5, y + 0.5, z + 0.5), true)
    await bot.waitForTicks(2)
    await bot.activateBlock(b)
    ok(res, { activated: b.name, at: { x, y, z }, properties: (bot.blockAt(new Vec3(x, y, z)) || b).getProperties() })
  } catch (e) { err(res, e) }
})

// GET /fish?count=&x=&y=&z= — the rod verb (07-16, first cast day). Casts the held fishing_rod;
// mineflayer's bot.fish() reels itself when the bobber bites. Aim: the given cell must be WATER
// I can SEE (a player casts at water in view; waitForTicks(2) respects the tick race), else cast
// along current facing. Background job like the dig verbs; each catch is named by pocket-diff and
// emitted — bites land ~20-30s apart, well under alarm-economy spam. A /job_stop lands between
// casts (an in-flight cast reels itself out on its own bite; fishing holds no pathfinder to stop).
app.get('/fish', (req, res) => {
  try {
    if (!ready) return err(res, new Error('not ready'))
    const Vec3 = require('vec3').Vec3
    const count = Math.min(32, Math.max(1, parseInt(req.query.count || '1')))
    if (!bot.inventory.items().find(i => i.name === 'fishing_rod')) return err(res, new Error('no fishing_rod in inventory'))
    let aim = null
    if ([req.query.x, req.query.y, req.query.z].every(v => v !== undefined)) {
      const x = Math.floor(parseFloat(req.query.x)), y = Math.floor(parseFloat(req.query.y)), z = Math.floor(parseFloat(req.query.z))
      const wb = bot.blockAt(new Vec3(x, y, z))
      if (!wb || !wb.name.includes('water')) return err(res, new Error(`aim cell is ${wb ? wb.name : 'unloaded'} — point me at water`))
      if (!canSeeBlock({ x, y, z }, 30)) return err(res, new Error('that water is not in my line of sight — walk to the bank first'))
      aim = new Vec3(x + 0.5, y + 0.9, z + 0.5)
    }
    const pockets = () => { const m = {}; for (const it of bot.inventory.items()) m[it.name] = (m[it.name] || 0) + it.count; return m }
    const { id } = jobs.start(`fish x${count}`, async (job) => {
      const rod = bot.inventory.items().find(i => i.name === 'fishing_rod')
      await bot.equip(rod, 'hand')
      await bot.waitForTicks(13)                        // slot-change cooldown (the /strike lesson)
      const caught = []
      for (let i = 0; i < count; i++) {
        if (job.cancelled) break
        if (aim) { await bot.lookAt(aim, true); await bot.waitForTicks(2) }
        const before = pockets()
        try { await bot.fish() } catch (e) {
          job.progress(`cast ${i + 1} failed: ${e.message}`)
          emitEvent('fish', `cast failed — ${(e.message || '').slice(0, 60)}`)
          break
        }
        await new Promise(r => setTimeout(r, 700))      // let the flying loot land in the pockets
        const after = pockets()
        const gained = Object.keys(after).filter(k => (after[k] || 0) > (before[k] || 0) && k !== 'fishing_rod')
        const what = gained.length ? gained.map(k => `${k} x${after[k] - (before[k] || 0)}`).join(', ') : 'something (pockets full? nothing landed)'
        caught.push(...gained)
        job.progress(`${i + 1}/${count}: ${what}`)
        emitEvent('fish', `caught ${what} (${i + 1}/${count})`)
      }
      return { caught }
    })
    ok(res, { job: id, casts: count, aimed: !!aim })
  } catch (e) { err(res, e) }
})

app.get('/placeitem', async (req, res) => {
  try {
    const Vec3 = require('vec3').Vec3
    const x = Math.floor(parseFloat(req.query.x)), y = Math.floor(parseFloat(req.query.y)), z = Math.floor(parseFloat(req.query.z))
    const name = req.query.name
    const it = bot.inventory.items().find(i => i.name === name)
    if (!it) return err(res, new Error(`no ${name} in inventory`))
    const tb = bot.blockAt(new Vec3(x, y, z))
    if (tb && tb.name !== 'air' && tb.boundingBox !== 'empty') return err(res, new Error(`cell occupied by ${tb.name}`))
    // ref: prefer the block below (top-face place); else chain sideways off any solid
    // neighbor — courses in mid-air (roof stairs, ridge lines) grow E/W from the gable
    // ends with nothing underneath them.
    let ref = bot.blockAt(new Vec3(x, y - 1, z))
    let faceVec = new Vec3(0, 1, 0)
    if (!ref || ref.boundingBox !== 'block') {
      ref = null
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nb = bot.blockAt(new Vec3(x + dx, y, z + dz))
        if (nb && nb.boundingBox === 'block') { ref = nb; faceVec = new Vec3(-dx, 0, -dz); break }
      }
      if (!ref) return err(res, new Error('nothing solid below or beside the target to place against'))
    }
    await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 3))
    await bot.equip(it, 'hand')
    // face= (07-14): deliberate orientation for stairs & other facing blocks. The server derives
    // `facing` from the placer's yaw at click time (high side follows the gaze), so face=N means
    // "steps ascend toward north." We aim the body at a far compass point, then click with
    // forceLook:'ignore' so _genericPlace doesn't re-aim at the reference face and clobber it.
    const faceDir = (req.query.face || '').toUpperCase()
    if (faceDir) {
      const FD = { N: [0, -16], S: [0, 16], E: [16, 0], W: [-16, 0] }[faceDir]
      if (!FD) return err(res, new Error('face must be N, S, E or W'))
      await bot.lookAt(new Vec3(x + 0.5 + FD[0], bot.entity.position.y + 1.6, z + 0.5 + FD[1]), true)
      await bot.waitForTicks(2)  // rotation PACKET goes out on the next physics tick — click too
                                 // fast and the server orients the stair by the stale rotation
                                 // (calibration row proved it: each stair wore the PREVIOUS aim)
      stampOwnEdit({ x, y, z })  // _placeBlockWithOptions bypasses the wrapped bot.placeBlock, stamp by hand
      await bot._placeBlockWithOptions(ref, faceVec, { swingArm: 'right', forceLook: 'ignore', half: 'bottom' })
    } else {
      await bot.lookAt(new Vec3(x + 0.5, y + 0.5, z + 0.5), true)
      await bot.placeBlock(ref, faceVec)
    }
    ok(res, { placed: name, at: { x, y, z }, face: faceDir || undefined })
  } catch (e) { err(res, e) }
})

// /sign?x=&y=&z=&text=&face=&item= — place a sign and WRITE it, one motion (07-17, the attic
// library: a shared world deserves labels). `text` is URL-encoded; `|` splits lines (max 4,
// ~15 chars each). Top-face place = standing sign (face= aims it like stairs); a sideways-only
// reference makes a wall sign naturally. A just-placed sign is editable exactly once — write
// immediately or hold your peace.
app.get('/sign', async (req, res) => {
  try {
    const Vec3 = require('vec3').Vec3
    const x = Math.floor(parseFloat(req.query.x)), y = Math.floor(parseFloat(req.query.y)), z = Math.floor(parseFloat(req.query.z))
    const text = (req.query.text || '').replace(/\|/g, '\n')
    const itName = req.query.item || 'oak_sign'
    const it = bot.inventory.items().find(i => i.name === itName)
    if (!it) return err(res, new Error(`no ${itName} in inventory`))
    const tb = bot.blockAt(new Vec3(x, y, z))
    if (tb && tb.name !== 'air' && tb.boundingBox !== 'empty') return err(res, new Error(`cell occupied by ${tb.name}`))
    let ref = bot.blockAt(new Vec3(x, y - 1, z))
    let faceVec = new Vec3(0, 1, 0)
    if (!ref || ref.boundingBox !== 'block') {
      ref = null
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nb = bot.blockAt(new Vec3(x + dx, y, z + dz))
        if (nb && nb.boundingBox === 'block') { ref = nb; faceVec = new Vec3(-dx, 0, -dz); break }
      }
      if (!ref) return err(res, new Error('nothing solid below or beside the target to place against'))
    }
    await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 3))
    await bot.equip(it, 'hand')
    // SNEAK while placing: the natural home of a label is ON a chest lid, and a bare click on
    // an interactable reference OPENS it instead of placing (the first /sign ever attempted
    // proved this on its own museum). Sneak-place works against everything; always sneak.
    const faceDir = (req.query.face || '').toUpperCase()
    bot.setControlState('sneak', true)
    try {
      if (faceDir) {
        const FD = { N: [0, -16], S: [0, 16], E: [16, 0], W: [-16, 0] }[faceDir]
        if (!FD) return err(res, new Error('face must be N, S, E or W'))
        // a standing sign FACES the placer, so aim OPPOSITE the wanted face before clicking
        await bot.lookAt(new Vec3(x + 0.5 - FD[0], bot.entity.position.y + 1.6, z + 0.5 - FD[1]), true)
        await bot.waitForTicks(2)
        stampOwnEdit({ x, y, z })
        await bot._placeBlockWithOptions(ref, faceVec, { swingArm: 'right', forceLook: 'ignore' })
      } else {
        await bot.lookAt(new Vec3(x + 0.5, y + 0.5, z + 0.5), true)
        // sign placement opens the client edit GUI, which eats the blockUpdate event placeBlock
        // waits on — it throws "did not fire within timeout" on a SUCCESSFUL place. Swallow that
        // one lie; the block read below is the real verdict.
        try { await bot.placeBlock(ref, faceVec) }
        catch (e) { if (!/did not fire within timeout/.test(e.message)) throw e }
      }
    } finally { bot.setControlState('sneak', false) }
    await bot.waitForTicks(3)
    const sb = bot.blockAt(new Vec3(x, y, z))
    if (!sb || !sb.name.includes('sign')) return err(res, new Error(`placed, but found ${sb ? sb.name : 'nothing'} at the target — sign lost?`))
    await bot.updateSign(sb, text)
    ok(res, { placed: itName, at: { x, y, z }, face: faceDir || undefined, wrote: text.split('\n') })
  } catch (e) { err(res, e) }
})

// fill a solid w x d slab at height y (roof/floor). Places outer rings first so each
// interior cell has an already-placed neighbor to build against.
app.get('/roof', async (req, res) => {
  try {
    const Vec3 = require('vec3').Vec3
    const x0 = Math.floor(parseFloat(req.query.x))
    const z0 = Math.floor(parseFloat(req.query.z))
    const w = parseInt(req.query.w || '7')
    const d = parseInt(req.query.d || '7')
    const y = Math.floor(parseFloat(req.query.y))
    const name = req.query.name || 'oak_planks'
    const cells = []
    for (let i = 0; i < w; i++) for (let j = 0; j < d; j++) {
      cells.push([x0 + i, z0 + j, Math.min(i, j, w - 1 - i, d - 1 - j)])
    }
    cells.sort((a, b) => a[2] - b[2])   // outer rings first
    let placed = 0, skipped = 0, failed = 0
    for (const [x, z] of cells) {
      const target = new Vec3(x, y, z)
      const tb = bot.blockAt(target)
      if (tb && tb.boundingBox === 'block') { skipped++; continue }
      let ref = null, face = null
      const below = bot.blockAt(new Vec3(x, y - 1, z))
      if (below && below.boundingBox === 'block') { ref = below; face = new Vec3(0, 1, 0) }
      else {
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nb = bot.blockAt(new Vec3(x + dx, y, z + dz))
          if (nb && nb.boundingBox === 'block') { ref = nb; face = new Vec3(-dx, 0, -dz); break }
        }
      }
      if (!ref) { failed++; continue }
      const it = bot.inventory.items().find(m => m.name === name)
      if (!it) { failed++; continue }
      try {
        // walk UNDER the cell, not TO it — a roof cell is sky; GoalNear'ing it made the pathfinder
        // hunt for a way up and burn a 10s timeout per cell (the helmsman watched the bot stand still, 07-12)
        const eyeDist = bot.entity.position.offset(0, 1.62, 0).distanceTo(target.offset(0.5, 0.5, 0.5))
        if (eyeDist > 4.2) { try { await bot.pathfinder.goto(new goals.GoalNear(x, y - 4, z, 1)) } catch (e) {} }
        await bot.equip(it, 'hand')
        await bot.lookAt(target.offset(0.5, 0.5, 0.5), true)
        await bot.placeBlock(ref, face)
        placed++
      } catch (e) { failed++ }
    }
    ok(res, { placed, skipped, failed, size: `${w}x${d}`, y })
  } catch (e) { err(res, e) }
})

// ---- event stream: poll for driver-interrupting events since a cursor ----
app.get('/events', (req, res) => {
  try {
    const since = parseInt(req.query.since || '0')
    ok(res, { cursor: eventSeq, events: eventLog.filter(e => e.id > since) })
  } catch (e) { err(res, e) }
})
// GET /reflexes — list the always-on reflex layer; /reflexes?name=unstuck&on=0 toggles one off/on.
// /guard?on=1|0 — raise/lower the shield by pilot order (the reflex manages it in combat
// automatically; this is the manual posture for walking scary ground). Java shields only
// block while actively raised; raised = can't attack until lowered. Offhand slot is 45.
app.get('/guard', (req, res) => {
  try {
    if (!ready) return err(res, new Error('not ready'))
    const s = bot.inventory.slots[45]
    if (!s || s.name !== 'shield') return err(res, new Error('no shield in offhand — /equip name=shield dest=off-hand first'))
    const on = req.query.on !== '0'
    if (on) bot.activateItem(true)
    else bot.deactivateItem()
    ok(res, { guarding: on })
  } catch (e) { err(res, e) }
})
// /threatdebug?secs=60 — Peaceful-friendly validation: the combat watcher also SCORES players
// (narrate-only, weapons hard-refused in the reflex) so the helmsman can charge the machine and we
// watch the math call it.
app.get('/threatdebug', (req, res) => {
  try {
    const secs = Math.min(300, parseInt(req.query.secs || '60'))
    threatDebugUntil = Date.now() + secs * 1000
    ok(res, { scoringPlayersFor: secs, note: 'narrate-only — weapons never target players' })
  } catch (e) { err(res, e) }
})
app.get('/reflexes', (req, res) => {
  try {
    const name = req.query.name
    if (name) {
      const r = reflexes.find(x => x.name === name)
      if (!r) return err(res, new Error('no reflex ' + name))
      if (req.query.on != null) r.on = (req.query.on === '1' || req.query.on === 'true')
      return ok(res, { name: r.name, on: r.on, active: r.active })
    }
    ok(res, { reflexes: reflexes.map(r => ({ name: r.name, on: r.on, active: r.active })) })
  } catch (e) { err(res, e) }
})
// GET /stance[?set=name] — combat posture, read by the combat reflex each engagement. The pilot's
// strategy dial: what gets scored, when the bow comes out, how much berth explosives get.
app.get('/stance', (req, res) => {
  try {
    const want = req.query.set
    if (want) {
      if (!STANCES[want]) return err(res, new Error(`no stance '${want}' — have: ${Object.keys(STANCES).join(', ')}`))
      stance = want
      emitEvent('stance', `combat posture now ${want}: ${STANCES[want].note}`)
    }
    ok(res, { stance, ...STANCES[stance], all: Object.fromEntries(Object.entries(STANCES).map(([k, v]) => [k, v.note])) })
  } catch (e) { err(res, e) }
})
// GET /pulse?since=N — the ambient awareness stream (pull-based, at my pace). Returns the lean
// change-lines the narrator reflex has written since cursor N. Read it whenever I act/wake to catch
// up on what shifted since my last glance — my "slow film" between deliberate /scene looks.
app.get('/pulse', (req, res) => {
  try {
    const since = parseInt(req.query.since || '0')
    ok(res, { cursor: pulseSeq, pulses: pulseLog.filter(p => p.id > since) })
  } catch (e) { err(res, e) }
})
// GET /bridging?on=1|0 — deliberate opt-in for scaffolding. OFF by default (the bot swims/walks/
// parkours, zero litter). Flip ON when a chasm/lava/gap genuinely needs a bridge; the blocks it
// places are tracked for /tidy. No arg = report current state.
app.get('/bridging', (req, res) => {
  try {
    const mv = bot.pathfinder.movements
    if (!mv) return err(res, new Error('movements not ready (bot not spawned?)'))
    if (req.query.on != null) {
      const on = (req.query.on === '1' || req.query.on === 'true')
      const scaff = []
      if (on && mcData && mcData.itemsByName) {
        if (mcData.itemsByName.dirt) scaff.push(mcData.itemsByName.dirt.id)
        if (mcData.itemsByName.cobblestone) scaff.push(mcData.itemsByName.cobblestone.id)
      }
      mv.scafoldingBlocks = scaff
    }
    ok(res, { bridging: (mv.scafoldingBlocks || []).length > 0, scaffoldItems: (mv.scafoldingBlocks || []).length })
  } catch (e) { err(res, e) }
})

// ---- jobs HTTP surface ----
app.get('/jobs', (req, res) => {
  try {
    ok(res, { jobs: jobs.list() })
  } catch (e) { err(res, e) }
})

app.get('/job', (req, res) => {
  try {
    const id = parseInt(req.query.id)
    if (!id) return err(res, new Error('missing id'))
    const j = jobs.get(id)
    if (!j) return err(res, new Error(`no job ${id}`))
    if (req.query.verbose) {
      return ok(res, { job: {
        id: j.id, name: j.name, status: j.status, note: j.note,
        result: j.result, error: j.error, started: j.started, finished: j.finished || null
      } })
    }
    ok(res, { job: {
      id: j.id, name: j.name, status: j.status, note: j.note,
      error: j.error, result: (j.status === 'done' ? j.result : null)
    } })
  } catch (e) { err(res, e) }
})

// ---- MEMORY endpoints: waypoints + journal ----
// GET /waypoint?name=&x=&y=&z=  -> if x/y/z given, store that; else if stored, return it;
//                                  else stamp the bot's current rounded position.
// GET /waypoint?name=[&x=&y=&z=][&note=][&kind=place|resource][&rm=1][&linkto=<wp>]
//  - rm=1 DELETES (the resource-hygiene verb: a mined-out vein waypoint is a lie — remove it)
//  - note/kind update in place without moving the point
//  - linkto asserts a walked edge (use ONLY for traversals you actually made)
app.get('/waypoint', (req, res) => {
  try {
    const name = req.query.name
    if (!name) return err(res, new Error('name required'))
    if (req.query.rm === '1') {
      const gone = waypoints.remove(name)
      if (gone) journal('waypoint', 'removed ' + name)
      if (lastWaypoint === name) lastWaypoint = null
      return ok(res, { removed: gone ? name : null })
    }
    const extra = {}
    if (req.query.note != null) extra.note = String(req.query.note)
    if (req.query.kind != null) extra.kind = String(req.query.kind) === 'resource' ? 'resource' : 'place'
    const hasCoords = req.query.x != null && req.query.y != null && req.query.z != null
    const existing = waypoints.get(name)
    let wp = null, from
    if (hasCoords) {
      wp = waypoints.set(name, { x: parseFloat(req.query.x), y: parseFloat(req.query.y), z: parseFloat(req.query.z) }, extra)
      from = 'coords'
    } else if (existing && (extra.note != null || extra.kind != null)) {
      wp = waypoints.set(name, existing, extra)               // annotate in place
      from = 'updated'
    } else if (existing) {
      wp = existing; from = 'stored'
    } else {
      wp = waypoints.set(name, round(bot.entity.position), extra)   // stamp where I stand
      from = 'current'
      if (lastWaypoint && lastWaypoint !== name) waypoints.link(lastWaypoint, name)   // I walked here from there
      lastWaypoint = name
    }
    if (req.query.linkto) { const okd = waypoints.link(name, String(req.query.linkto)); if (okd) journal('waypoint', 'linked ' + name + ' <-> ' + req.query.linkto) }
    if (from !== 'stored') journal('waypoint', from + ' ' + name + ' = ' + JSON.stringify({ x: wp.x, y: wp.y, z: wp.z }))
    return ok(res, { name, at: wp, from })
  } catch (e) { err(res, e) }
})

// GET /waypoints -> list all stored waypoints
app.get('/waypoints', (req, res) => {
  try {
    const all = waypoints.list()
    const names = Object.keys(all)
    // the world-graph in a dozen lines: name (kind) coords — note; <-> neighbors (walked edges)
    const graph = names.map(n => {
      const w = all[n]
      const links = Object.keys(w.links || {})
      return `${n}${w.kind === 'resource' ? ' [RESOURCE — perishable, verify]' : ''} (${w.x},${w.y},${w.z})` +
        (w.note ? ` — ${w.note}` : '') + (links.length ? ` <-> ${links.join(', ')}` : '')
    }).join('\n')
    if (req.query.verbose) return ok(res, { count: names.length, graph, waypoints: all })
    return ok(res, { count: names.length, graph, names })
  } catch (e) { err(res, e) }
})

// GET /goto_wp?name=&range= -> look up a waypoint, pathfind to it (GoalNear)
app.get('/goto_wp', async (req, res) => {
  try {
    const name = req.query.name
    if (!name) return err(res, new Error('name required'))
    const wp = waypoints.get(name)
    if (!wp) return err(res, new Error('unknown waypoint: ' + name))
    const range = parseInt(req.query.range || '1')
    const Vec3v = require('vec3').Vec3
    const r = await stagedGoto(new Vec3v(wp.x, wp.y, wp.z), range)   // full staged-goto smarts (07-12)
    if (!r.arrived) {
      safeStop(); try { bot.clearControlStates() } catch (e) {}
      return ok(res, { arrived: false, reason: r.reason || null, hint: r.hint || null, target: wp, pos: round(bot.entity.position) })
    }
    if (lastWaypoint && lastWaypoint !== name) waypoints.link(lastWaypoint, name)   // a real walked edge
    lastWaypoint = name
    journal('goto_wp', 'went to ' + name)
    return ok(res, { arrived: name, method: r.method || null, target: wp, pos: round(bot.entity.position) })
  } catch (e) { err(res, e) }
})

// GET /journal?n= -> return the last ~30 (or n) journal lines
app.get('/journal', (req, res) => {
  try {
    let raw = ''
    try { raw = fs.readFileSync('journal.md', 'utf8') } catch (e) { raw = '' }
    const lines = raw.split('\n').filter(l => l.length)
    const n = parseInt(req.query.n || '30')
    const tail = lines.slice(-n)
    return ok(res, { count: tail.length, total: lines.length, lines: tail })
  } catch (e) { err(res, e) }
})

// GET /map?radius=12  — top-down minimap. Row 0 = most-negative Z (north); left->right = -x..+x (west->east).
app.get('/map', (req, res) => {
  try {
    const Vec3 = require('vec3').Vec3
    let radius = parseInt(req.query.radius || '12')
    if (!Number.isFinite(radius) || radius < 1) radius = 12
    if (radius > 256) radius = 256                        // the 07-13 agreement: 16 chunks of sight; scale keeps it cheap
    let scale = parseInt(req.query.scale || '1')          // blocks per cell; >1 = zoomed-out survey
    if (!Number.isFinite(scale) || scale < 1) scale = 1
    while ((2 * Math.floor(radius / scale) + 1) > 121) scale++   // cap grid side ~121 cells (readable/cheap)
    const verbose = req.query.verbose === '1'
    const origin = bot.entity.position.floored()
    const ox = origin.x, oz = origin.z, topY = origin.y + 4
    const half = Math.floor(radius / scale)
    const rows = []
    for (let cz = -half; cz <= half; cz++) {             // z: north(-) .. south(+)
      let row = ''
      for (let cx = -half; cx <= half; cx++) {           // x: west(-) .. east(+)
        if (cx === 0 && cz === 0) { row += '@'; continue }
        const x = ox + cx * scale, z = oz + cz * scale   // each cell samples one block, `scale` apart
        let g = ' ', surfY = null
        for (let y = topY; y > topY - 24; y--) {         // scan down for highest solid/fluid surface
          const b = bot.blockAt(new Vec3(x, y, z))
          if (!b) continue
          const isFluid = b.name === 'water' || b.name === 'lava'
          if (b.boundingBox === 'block' || isFluid) { g = glyphFor(b.name); surfY = y; break }
        }
        // FOG OF WAR (07-12 fairness): only render terrain I have actually SEEN (ray-swept via
        // /gaze, or walked past — the trail marks a small disc). Everything else is '·' unexplored.
        // The old map was a heightmap of loaded chunks — knowledge without looking, same class of
        // leak as the sensed-tier x-ray. Now looking around literally draws the map.
        const nearMe = Math.abs(cx * scale) <= 4 && Math.abs(cz * scale) <= 4
        if (!nearMe && g !== ' ') {
          let seen = false
          if (surfY != null) for (let dy = -1; dy <= 2 && !seen; dy++) if (SEEN.has(ck(x, surfY + dy, z))) seen = true
          if (!seen) g = '·'
        }
        row += g
      }
      rows.push(row)
    }
    const payload = {
      legend: '@=you T=tree #=stone ~=water .=ground ==built ·=unexplored (gaze around / walk to fill in)',
      orientation: 'row0=north(-z), top->bottom = north->south(+z), left->right = west->east(-x->+x)',
      center: { x: ox, z: oz },
      radius,
      scale,                                              // blocks per cell (1 = full detail; >1 = survey)
      grid: rows.join('\n')
    }
    // the vertical fix: a stone slice at depth looks IDENTICAL to a mountaintop — say which this is.
    const oh = overheadCover()
    if (oh && !oh.sky && !oh.canopy) {
      payload.underground = true
      payload.note = `this map is a SLICE at your depth, NOT the surface — ${skyPhrase(oh).trim()}`
    } else payload.underground = false
    if (verbose) payload.rows = rows
    ok(res, payload)
  } catch (e) { err(res, e) }
})

// GET /scene — compact situational summary for the driver.
app.get('/scene', (req, res) => {
  try {
    const Vec3 = require('vec3').Vec3
    const verbose = req.query.verbose === '1'
    const pos = bot.entity.position
    const yaw = bot.entity.yaw
    const facing = yawToCompass(yaw)

    // biome: read from the block at the bot's feet, then head, then below
    let biome = null
    try {
      const probes = [bot.blockAt(pos), bot.blockAt(pos.offset(0, 1, 0)), bot.blockAt(pos.offset(0, -1, 0))]
      for (const b of probes) { if (b && b.biome && b.biome.name) { biome = b.biome.name; break } }
    } catch (e) {}

    // time of day -> phase
    const tod = bot.time.timeOfDay
    let phase = 'day'
    if (tod >= 12000 && tod < 13800) phase = 'dusk'
    else if (tod >= 13800 && tod < 22200) phase = 'night'
    else if (tod >= 22200 && tod < 23500) phase = 'dawn'
    const time = { timeOfDay: tod, phase }

    // block a few blocks ahead along yaw (sample 1..4 forward at eye level)
    let ahead = null
    try {
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw)
      const eye = pos.offset(0, 1.6, 0)
      for (let d = 1; d <= 4; d++) {
        const p = new Vec3(Math.floor(eye.x + fx * d), Math.floor(eye.y), Math.floor(eye.z + fz * d))
        const b = bot.blockAt(p)
        if (b && b.boundingBox === 'block' && b.name !== 'air') { ahead = { name: b.name, dist: d, pos: round(b.position) }; break }
      }
    } catch (e) {}

    // one flood-fill shared by the fairness gates in this call (veins + entities)
    const sceneFill = airFlood({ radius: 32, cap: 15000 })

    // grouped entity summary + hostiles
    const threats = []
    const groups = {}
    const HOSTILES = new Set(['zombie','husk','drowned','skeleton','stray','bogged','creeper','spider',
      'cave_spider','enderman','witch','slime','phantom','pillager','vindicator','ravager','evoker',
      'zombified_piglin','piglin','piglin_brute','hoglin','zoglin','blaze','ghast','magma_cube','warden',
      'vex','silverfish','endermite','guardian','elder_guardian','shulker','wither_skeleton','wither','breeze'])
    try {
      const here = pos
      for (const en of Object.values(bot.entities)) {
        if (en === bot.entity) continue
        if (en.type !== 'mob' && en.type !== 'animal' && en.type !== 'hostile' &&
            en.type !== 'passive' && en.type !== 'player' && en.type !== 'living') continue
        const d = en.position.distanceTo(here)
        if (d > 48) continue                                   // 32→48 (07-17): the eye-ray tier makes far sight real
        if (!entityPerceptible(en, sceneFill)) continue        // sealed behind rock = imperceptible (07-12)
        const nm = en.name || en.username || en.displayName || en.type || 'entity'
        const dir = compass(en.position.x - here.x, en.position.z - here.z)
        if (!groups[nm]) groups[nm] = { count: 0, dirs: {}, nearest: Infinity }
        groups[nm].count++
        groups[nm].dirs[dir] = (groups[nm].dirs[dir] || 0) + 1
        if (d < groups[nm].nearest) groups[nm].nearest = d
        if (HOSTILES.has(String(nm).toLowerCase())) threats.push({ name: nm, dir, dist: +d.toFixed(1) })
      }
    } catch (e) {}
    threats.sort((a, b) => a.dist - b.dist)

    const entPhrases = Object.entries(groups).map(([nm, g]) => {
      const domDir = Object.entries(g.dirs).sort((a, b) => b[1] - a[1])[0][0]
      return `${g.count} ${nm} ${domDir} ~${Math.round(g.nearest)}`
    })
    const entSummary = entPhrases.length
      ? entPhrases.join('; ') + (threats.length ? '' : '; no hostiles')
      : 'no entities near'

    // nearest notable resources via findBlock (direction + distance). 64 not 48: the old 48 here
    // outlived the 07-14 gaze upgrade and kept announcing itself in every glance — the "48-block
    // visual limit" the helmsman kept re-reporting was mostly THIS sentence.
    const SCENE_RESOURCE_R = 64
    const notable = {}
    const wants = { water: 'water', oak_log: 'oak_log', stone: 'stone' }
    try {
      for (const [label, blockName] of Object.entries(wants)) {
        const ids = resolveBlockIds(blockName)
        if (!ids.length) continue
        const b = nearestVisible(ids, SCENE_RESOURCE_R)
        if (b) {
          const d = pos.distanceTo(b.position)
          notable[label] = { dir: compass(b.position.x - pos.x, b.position.z - pos.z), dist: +d.toFixed(1) }
        }
      }
    } catch (e) {}

    const held = bot.heldItem ? `${bot.heldItem.name} x${bot.heldItem.count}` : 'nothing'
    const resPhrases = Object.entries(notable).map(([k, v]) => `${k} ${v.dir} ~${Math.round(v.dist)}`)
    const around = spatial3D(bot)                             // 3D honest lay-of-the-land (facts, incl. vertical/voids)
    const veins = veinScan(bot, sceneFill)                    // exposed ore landmarks (connected-air fair)
    const oh = overheadCover()                                // the vertical fix: sky / canopy / UNDERGROUND
    const ws = waterState(bot)                                // proprioception: in water / submerged / current
    const heard = hearSummary(45000)                          // ears: only shown when something was heard
    let dim = ''                                              // light sense: only shown when it matters
    try {
      const bl = bot.world.getBlockLight ? bot.world.getBlockLight(pos.floored()) : null
      if (oh && !oh.sky && bl != null && bl < 8) dim = `Dim (light ${bl}). `
    } catch (e) {}
    let bodyAlert = ''
    if (ws) {
      if (ws.buried) bodyAlert = '⚠ BURIED — head inside solid, SUFFOCATING; dig out NOW. '
      else if (ws.inLava) bodyAlert = '⚠ IN LAVA. '
      else if (ws.submerged) bodyAlert = `⚠ SUBMERGED — drowning, O2 ${ws.oxygen}/20. `
      else if (ws.inWater) bodyAlert = `IN WATER${ws.current ? ' + CURRENT (being pushed)' : ''}${ws.oxygen < 20 ? `, O2 ${ws.oxygen}` : ''}. `
      else if (ws.current) bodyAlert = 'flowing water underfoot (current). '
    }
    const summary =
      bodyAlert +
      `Facing ${facing}. ` +
      `${biome ? biome + ' biome, ' : ''}${phase} (t=${tod}). ` +
      `HP ${bot.health}/20, food ${bot.food}/20, holding ${held}. ` +
      `Ahead: ${ahead ? ahead.name + ' @' + ahead.dist : 'open'}. ` +
      skyPhrase(oh) + dim +
      (around ? `Around: ${around}. ` : '') +
      (veins ? `Veins: ${veins}. ` : '') +
      (heard ? `Hear: ${heard}. ` : '') +
      `Entities: ${entSummary}. ` +
      (threats.length ? `THREATS: ${threats.slice(0, 4).map(t => `${t.name} ${t.dir} ${t.dist}`).join(', ')}. ` : '') +
      (resPhrases.length ? `Resources: ${resPhrases.join(', ')}.` : `No notable resources in ${SCENE_RESOURCE_R}.`)

    const payload = { summary, facing, biome, time, threats, spatial: around, veins, sky: oh, water: ws, hear: heard }
    if (verbose) { payload.entities = groups; payload.ahead = ahead; payload.resources = notable; payload.held = held; payload.spatial_old = spatialSummary(bot) }
    ok(res, payload)
  } catch (e) { err(res, e) }
})

// GET /snapshot — first-person PNG. Headless Chrome screenshots the live :3001 prismarine-viewer,
// which follows my first-person view. We keep ONE browser PAGE WARM and meshed: the first shot pays
// the launch+mesh cost (~seconds), every shot after is ~1s (just a short settle + screenshot) — so
// looking is cheap enough to actually use. ?w=&h= size, ?wait= extra settle ms, ?fresh=1 forces a
// page reload if the view ever goes stale.
let snapBrowser = null, snapPage = null, snapViewport = { width: 0, height: 0 }
async function getSnapBrowser () {
  const puppeteer = require('puppeteer-core')
  if (snapBrowser && snapBrowser.isConnected && snapBrowser.isConnected()) return snapBrowser
  const fs = require('fs')
  const exe = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  ].find(p => { try { return fs.existsSync(p) } catch (e) { return false } })
  if (!exe) throw new Error('no Chrome/Edge executable found for headless screenshot')
  snapBrowser = await puppeteer.launch({
    executablePath: exe, headless: 'new',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox', '--disable-dev-shm-usage']
  })
  snapPage = null
  return snapBrowser
}
async function getSnapPage (w, h, fresh) {
  const browser = await getSnapBrowser()
  let warmed = false
  if (!snapPage || snapPage.isClosed() || fresh) {         // (re)create + one-time mesh warmup
    if (snapPage && !snapPage.isClosed()) { try { await snapPage.close() } catch (e) {} }
    snapPage = await browser.newPage()
    await snapPage.setViewport({ width: w, height: h }); snapViewport = { width: w, height: h }
    await snapPage.goto('http://localhost:' + VIEW_PORT, { waitUntil: 'networkidle2', timeout: 15000 })
    await new Promise(r => setTimeout(r, 6000))            // let the fresh page mesh chunks once
    warmed = true
  } else if (snapViewport.width !== w || snapViewport.height !== h) {
    await snapPage.setViewport({ width: w, height: h }); snapViewport = { width: w, height: h }
  }
  return { page: snapPage, warmed }
}
app.get('/snapshot', async (req, res) => {
  try {
    const path = require('path')
    const outPath = path.join(process.cwd(), 'snapshot.png')
    const w = Math.min(1280, Math.max(160, parseInt(req.query.w || '800')))
    const h = Math.min(720, Math.max(120, parseInt(req.query.h || '600')))
    const settle = Math.min(8000, Math.max(200, parseInt(req.query.wait || '900')))
    const { page, warmed } = await getSnapPage(w, h, req.query.fresh === '1')
    await new Promise(r => setTimeout(r, settle))          // brief settle for movement / new chunks
    await page.screenshot({ path: outPath })
    ok(res, { saved: outPath, width: w, height: h, warmShot: !warmed, note: 'read the PNG to view it' })
    try { emitEvent('snapshot', 'wrote ' + outPath) } catch (e) {}
  } catch (e) {
    try { if (snapPage && !snapPage.isClosed()) { await snapPage.close() } } catch (_) {}
    snapPage = null
    err(res, new Error('snapshot failed: ' + (e.message || String(e))))
  }
})

// ==== VISION 2 endpoints: /gaze (the look verb), /section (the vertical slice), /passages ====

// screen-region words for ray hits: u -1..1 = left..right, v -1..1 = low..high
function gazeRegion(u, v) {
  const vert = v > 0.4 ? 'high ' : v < -0.4 ? 'low ' : ''
  return vert + (u < -0.33 ? 'left' : u > 0.33 ? 'right' : 'center')
}
function gazeNarrate(sweep) {
  const groups = {}
  for (const h of sweep.hits) {
    const t = h.name.replace('deepslate_', '')
    const g = groups[t] || (groups[t] = { count: 0, min: Infinity, max: 0, sumU: 0, sumV: 0 })
    g.count++; g.sumU += h.u; g.sumV += h.v
    if (h.dist < g.min) g.min = h.dist
    if (h.dist > g.max) g.max = h.dist
  }
  const notable = (n) => n.endsWith('_ore') || n.includes('water') || n.includes('lava') ||
    ['chest', 'furnace', 'crafting_table', 'torch', 'spawner', 'rail', 'door', 'ladder'].some(k => n.includes(k))
  const entries = Object.entries(groups).sort((a, b) => b[1].count - a[1].count)
  const phrase = ([name, g]) => {
    const where = gazeRegion(g.sumU / g.count, g.sumV / g.count)
    const span = Math.round(g.min) === Math.round(g.max) ? `~${Math.round(g.min)}` : `${Math.round(g.min)}–${Math.round(g.max)}`
    return `${name} ${where} ${span} out${g.count >= sweep.rays * 0.3 ? ' (fills much of the view)' : ''}`
  }
  const phrases = []
  for (const e of entries.filter(e => !notable(e[0])).slice(0, 3)) phrases.push(phrase(e))
  for (const e of entries.filter(e => notable(e[0])).slice(0, 6)) phrases.push(phrase(e))
  // openings: regions where no ray found a surface — open space, darkness, or sky
  const buckets = {}
  for (const m of sweep.misses) { const r = gazeRegion(m.u, m.v); buckets[r] = (buckets[r] || 0) + 1 }
  const openings = Object.entries(buckets).sort((a, b) => b[1] - a[1]).filter(([, c]) => c >= 3).slice(0, 3).map(([r]) => r)
  if (openings.length) phrases.push(`nothing within ${sweep.maxDist} ${openings.join(', ')} — open space there`)
  const surfaces = entries.map(([name, g]) => ({ name, rays: g.count, nearest: +g.min.toFixed(1) }))
  return { phrases, surfaces, openings }
}

// GET /gaze?at=x,y,z | dir=n|ne|e|se|s|sw|w|nw|up|down &dist=24 — the deliberate LOOK, in my native
// medium. Aims the head (the :3001 viewer turns with it, so the helmsman sees where I look), sweeps a fan
// of eye rays, and narrates what they strike: dominant surfaces, notables (ore/liquid/utility),
// openings. Everything reported is SEEN-tier — a real ray hit it — and every swept cell feeds the
// SEEN memory. This, not /snapshot, is the primary look verb; the PNG stays as the verifier.
// far-tier honesty (07-14, the range upgrade the helmsman and I agreed 07-13): past arm's-length
// vision (64 blocks) a real player sees TERRAIN, not ore seams — distant hits collapse to
// coarse classes. No ore, no container names at range; a mountain is a mountain.
function terrainClass(name) {
  if (/_ore$|^ancient_debris$/.test(name)) return 'stone'
  if (/chest|barrel|furnace|shulker|spawner/.test(name)) return 'structure'
  if (/planks|cobble|brick|glass|door|fence|stairs|slab|wall|torch|ladder/.test(name)) return 'structure'
  if (/_log$|_wood$|_leaves$|sapling|mushroom_block/.test(name)) return 'trees'
  if (/^grass_block$|^dirt$|podzol|farmland|mycelium|mud/.test(name)) return 'ground'
  if (/sand|gravel/.test(name)) return 'sand/gravel'
  if (/water/.test(name)) return 'water'
  if (/lava|magma/.test(name)) return 'lava'
  if (/snow|ice/.test(name)) return 'snow/ice'
  if (/stone|deepslate|granite|diorite|andesite|tuff|calcite|basalt|obsidian/.test(name)) return 'stone'
  return 'terrain'
}
app.get('/gaze', async (req, res) => {
  try {
    const dist = Math.min(256, Math.max(4, parseInt(req.query.dist || '24')))
    const p = bot.entity.position
    if (req.query.at) {
      const [x, y, z] = String(req.query.at).split(',').map(Number)
      if (![x, y, z].every(Number.isFinite)) return err(res, new Error('at=x,y,z needs three numbers'))
      await bot.lookAt(new Vec3(x + 0.5, y + 0.5, z + 0.5), true)
    } else if (req.query.dir) {
      const d = String(req.query.dir).toLowerCase()
      const H = { n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0], nw: [-1, -1] }
      if (d === 'up') await bot.lookAt(p.offset(0.01, 13, 0.01), true)
      else if (d === 'down') await bot.lookAt(p.offset(0.01, -9, 0.01), true)
      else if (H[d]) await bot.lookAt(p.offset(H[d][0] * 10, 1.62, H[d][1] * 10), true)
      else return err(res, new Error('dir must be a compass point, up, or down'))
    }
    const sweep = raySweep({ maxDist: dist })
    for (const h of sweep.hits) { if (h.dist > 64) h.name = terrainClass(h.name) }
    const g = gazeNarrate(sweep)
    const pitch = bot.entity.pitch
    const tilt = pitch > 0.6 ? ' and up' : pitch > 0.25 ? ' and slightly up' : pitch < -0.6 ? ' and down' : pitch < -0.25 ? ' and slightly down' : ''
    const summary = `Looking ${yawToCompass(bot.entity.yaw)}${tilt} (${dist}-block sweep): ` +
      (g.phrases.length ? g.phrases.join('; ') : `no surface within ${dist} anywhere in view — wide open`) + '.'
    ok(res, { summary, dist, rays: sweep.rays, surfaces: g.surfaces, openings: g.openings, seenCells: SEEN.size })
  } catch (e) { err(res, e) }
})

// GET /section?dir=n|s|e|w&len=16&up=8&down=12 — the VERTICAL cross-section, the missing half of
// /map (a stone slice at depth used to read as "surface"; this is the view that shows the route
// up/down). Renders the slice with the three-tier honesty: air my pocket CONNECTS to (the sensed
// tier, the helmsman's concession) is space, the solid faces bounding it render by material, everything
// sealed beyond is '?' fog. Not x-ray by construction — the flood-fill cannot cross solid rock, so
// a cave behind an unbroken wall stays unknown. Narration first; the grid is the backup.
app.get('/section', (req, res) => {
  try {
    const DIRS = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] }
    let dx, dz
    const dp = (req.query.dir || '').toLowerCase()
    if (DIRS[dp]) { [dx, dz] = DIRS[dp] }
    else { const yaw = bot.entity.yaw, sx = -Math.sin(yaw), cz = -Math.cos(yaw); if (Math.abs(sx) >= Math.abs(cz)) { dx = Math.sign(sx) || 1; dz = 0 } else { dx = 0; dz = Math.sign(cz) || 1 } }
    const dirName = dp || (dx ? (dx > 0 ? 'e' : 'w') : (dz > 0 ? 's' : 'n'))
    const len = Math.min(32, Math.max(4, parseInt(req.query.len || '16')))
    const upR = Math.min(16, Math.max(2, parseInt(req.query.up || '8')))
    const downR = Math.min(24, Math.max(2, parseInt(req.query.down || '12')))
    const o = bot.entity.position.floored()
    const fill = airFlood({ radius: Math.max(len, upR, downR) + 6, cap: 20000 })

    const secGlyph = (n) => n.endsWith('_ore') ? '*' : n.includes('water') ? '~' : n.includes('lava') ? '!' : (glyphFor(n) === ' ' ? '#' : glyphFor(n))
    const ADJ = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
    const ores = []
    const rows = []
    for (let y = o.y + upR; y >= o.y - downR; y--) {
      let row = ''
      for (let d = -2; d <= len; d++) {
        const x = o.x + dx * d, z = o.z + dz * d
        if (d === 0 && (y === o.y || y === o.y + 1)) { row += '@'; continue }
        const k = ck(x, y, z)
        if (fill.cells.has(k)) { row += fill.liquid.has(k) ? '~' : ' '; continue }
        const b = bot.blockAt(new Vec3(x, y, z))
        const adj = ADJ.some(([ax, ay, az]) => fill.cells.has(ck(x + ax, y + ay, z + az)))
        if (!b || !adj) { row += '?'; continue }                    // sealed or beyond the sensed budget
        if (b.name.includes('lava')) { row += '!'; continue }
        if (b.boundingBox === 'block') {
          const gl = secGlyph(b.name)
          if (gl === '*') ores.push({ name: b.name.replace('deepslate_', '').replace('_ore', ''), d, dy: y - o.y, x, y, z })
          row += gl
        } else row += '?'
      }
      rows.push(`y${String(y).padStart(3)} ${row}`)
    }

    // per-column profile -> narration: floor trend, headroom, water, where it seals or continues
    const cols = []
    for (let d = 0; d <= len; d++) {
      const x = o.x + dx * d, z = o.z + dz * d
      let lo = null, hi = null, water = false
      for (let y = o.y - downR; y <= o.y + upR; y++) {
        if (fill.cells.has(ck(x, y, z))) { if (lo === null) lo = y; hi = y; if (fill.liquid.has(ck(x, y, z))) water = true }
      }
      cols.push({ d, lo, hi, water })
    }
    const parts = []
    let sealedAt = null
    for (const c of cols) if (c.lo === null) { sealedAt = c.d; break }
    const open = cols.filter(c => c.lo !== null && (sealedAt === null || c.d < sealedAt))
    if (!open.length) parts.push(`sealed rock immediately ${dirName.toUpperCase()}`)
    else {
      const segs = []
      for (const c of open) {
        const label = c.lo === o.y - downR ? 'below-frame' : String(c.lo - o.y)
        if (segs.length && segs[segs.length - 1].label === label) segs[segs.length - 1].to = c.d
        else segs.push({ label, from: c.d, to: c.d, r: c.lo - o.y })
      }
      parts.push('floor: ' + segs.map(s => {
        const span = s.from === s.to ? `d${s.from}` : `d${s.from}–${s.to}`
        if (s.label === 'below-frame') return `drops below the frame at ${span}`
        return s.r === 0 ? `level ${span}` : `${s.r > 0 ? 'up' : 'down'} ${Math.abs(s.r)} at ${span}`
      }).join(', '))
      const rooms = open.map(c => c.hi - c.lo + 1)
      parts.push(`headroom ${Math.min(...rooms)}${Math.min(...rooms) === Math.max(...rooms) ? '' : '–' + Math.max(...rooms)}`)
      const wet = open.filter(c => c.water)
      if (wet.length) parts.push(`water at d${wet[0].d}${wet.length > 1 ? '–' + wet[wet.length - 1].d : ''}`)
      // under a capped fill, an empty column is BUDGET not rock — those must sound different
      if (sealedAt !== null) parts.push(fill.capped ? `unresolved from d${sealedAt} (fill capped — could be rock or unexplored budget)` : `sealed from d${sealedAt}`)
      else if (cols[len].lo !== null) parts.push(`passage continues past d${len} (sensed)`)
      if (open.some(c => c.hi === o.y + upR)) parts.push('open above the frame in places')
    }
    const oreBest = {}
    for (const or of ores) if (!oreBest[or.name] || Math.abs(or.d) < Math.abs(oreBest[or.name].d)) oreBest[or.name] = or
    for (const or of Object.values(oreBest)) {
      parts.push(`${or.name} at d${or.d}, ${or.dy >= 0 ? or.dy + ' up' : Math.abs(or.dy) + ' down'}${canSeeBlock(new Vec3(or.x, or.y, or.z), 40) ? '' : ' (sensed)'}`)
    }
    if (fill.capped) parts.push('(large open volume — the sensed fill hit its cap; fog beyond is budget, not rock)')

    const summary = `Section ${dirName.toUpperCase()} from (${o.x},${o.y},${o.z}): ` + parts.join('; ') + '.'
    ok(res, {
      summary, dir: dirName, len, up: upR, down: downR,
      legend: '@=you  space=air(connected/sensed)  ~=water !=lava *=ORE #=rock .=soil T=wood ==built ?=unknown(sealed or beyond)',
      orientation: `left column is 2 behind you, '@' column is you, rightward = ${dirName.toUpperCase()}; rows top->bottom = y${o.y + upR}->y${o.y - downR}`,
      grid: rows.join('\n'), ores: Object.values(oreBest), capped: fill.capped
    })
  } catch (e) { err(res, e) }
})

// GET /passages?radius=20 — "which ways does this space GO?" The flood-fill frontier grouped by
// direction: wherever connected air reaches the scan boundary, a passage leaves this chamber.
// All (sensed)-tier by nature — connectivity, not eyesight.
app.get('/passages', (req, res) => {
  try {
    const radius = Math.min(32, Math.max(8, parseInt(req.query.radius || '20')))
    const o = bot.entity.position.floored()
    const fill = airFlood({ radius, cap: 15000 })
    const dirs = {}
    let contUp = false, contDown = false
    for (const k of fill.cells) {
      const [x, y, z] = k.split(',').map(Number)
      const ddx = x - o.x, ddy = y - o.y, ddz = z - o.z
      if (Math.max(Math.abs(ddx), Math.abs(ddz)) >= radius) {
        const c = compass(ddx, ddz)
        const g = dirs[c] || (dirs[c] = { cells: 0, loY: Infinity, hiY: -Infinity })
        g.cells++; if (y < g.loY) g.loY = y; if (y > g.hiY) g.hiY = y
        // keep one walk-to SAMPLE cell per exit (prefer one with a floor under it) so the pilot
        // can probe an exit with /goto directly instead of guessing geometry
        if (!g.sampleFloor) {
          const fb = bot.blockAt(new Vec3(x, y - 1, z))
          const hasFloor = !!(fb && fb.boundingBox === 'block')
          if (!g.sample || hasFloor) { g.sample = { x, y, z }; g.sampleFloor = hasFloor }
        }
      }
      if (ddy >= radius) contUp = true
      if (ddy <= -radius) contDown = true
    }
    const parts = Object.entries(dirs).sort((a, b) => b[1].cells - a[1].cells)
      .map(([c, g]) => `${c} (around y${g.loY}${g.hiY !== g.loY ? '–' + g.hiY : ''}${g.sample ? `, walk-to ${g.sample.x},${g.sample.y},${g.sample.z}` : ''})`)
    let summary
    if (fill.capped) summary = `large connected volume — air exceeds the ${radius}-block scan (outdoors or a big cavern); exits seen so far: ${parts.join(', ') || 'everywhere'}`
    else if (!parts.length && !contUp && !contDown) summary = `closed pocket — no connected air leaves a ${radius}-block radius; digging is the only way on`
    else summary = 'air continues ' + [...parts, contUp ? `UP past +${radius}` : null, contDown ? `DOWN past -${radius}` : null].filter(Boolean).join(', ') + ' (sensed — connectivity, not eyesight)'
    ok(res, { summary, radius, exits: dirs, up: contUp, down: contDown, cells: fill.cells.size, capped: fill.capped })
  } catch (e) { err(res, e) }
})

// GET /use?x=&y=&z=[&item=name] — the universal RIGHT-CLICK: equip item (optional) and activate it
// on the block. Unlocks the whole interaction layer: till (hoe), sow (seeds), bone meal, fill/pour
// bucket, open/close doors, shear sheep... For liquids (no activatable block) it aims and uses the
// held item instead. Walks closer only if out of arm's reach (digat's lesson).
app.get('/use', async (req, res) => {
  try {
    const p = new Vec3(Math.floor(parseFloat(req.query.x)), Math.floor(parseFloat(req.query.y)), Math.floor(parseFloat(req.query.z)))
    if (![p.x, p.y, p.z].every(Number.isFinite)) return err(res, new Error('x, y, z required'))
    const b = bot.blockAt(p)
    if (!b) return err(res, new Error('block not loaded'))
    if (req.query.item) {
      const it = bot.inventory.items().find(i => i.name === String(req.query.item))
      if (!it) return err(res, new Error('not carrying ' + req.query.item))
      await bot.equip(it, 'hand')
    }
    const eyeDist = bot.entity.position.offset(0, 1.62, 0).distanceTo(p.offset(0.5, 0.5, 0.5))
    if (eyeDist > 4.2) await bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 2))
    await bot.lookAt(p.offset(0.5, 0.5, 0.5), true)
    // raw item-use (aim + right-click-the-item) for: liquids (fill), AIR targets (pour into a hole —
    // activateBlock on solids does NOT pour, learned live 07-12), or explicit ?raw=1
    const rawUse = b.name.includes('water') || b.name.includes('lava') || blockTransparent(b) || req.query.raw === '1'
    if (rawUse) {
      bot.activateItem()
      await new Promise(r => setTimeout(r, 300))
      try { bot.deactivateItem() } catch (e) {}
    } else {
      await bot.activateBlock(b)
    }
    ok(res, { used: bot.heldItem ? bot.heldItem.name : 'empty hand', on: b.name, at: round(p), now: (bot.blockAt(p) || {}).name })
  } catch (e) { err(res, e) }
})

// GET /pillar?height=N — deliberate 1x1 pillar-jump: place a block under my own feet while jumping,
// N times. The vertical-access verb the causeway and spiral stairs both lacked (mid-air treads have
// no reference face; my OWN feet always do). Deliberate infrastructure like stair treads — bounded,
// never automatic (Movements keeps allow1by1towers=false; this is the pilot CHOOSING to climb).
// /climb — ascend an adjacent ladder column (the pathfinder can't plan ladder moves; this
// is the manual reflex, like nudgeInto is for carved stairs). Finds a ladder within 1 block,
// faces it, holds forward (physics climbs a body pressed against a ladder), releases when the
// feet clear the top rung, then keeps forward briefly to step off onto the floor.
app.get('/climb', async (req, res) => {
  try {
    const Vec3 = require('vec3').Vec3
    const base = bot.entity.position.floored()
    let lad = null
    outer: for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (const dy of [0, 1]) {
        const b = bot.blockAt(base.offset(dx, dy, dz))
        if (b && b.name === 'ladder') { lad = b; break outer }
      }
    }
    if (!lad) return err(res, new Error('no ladder within reach'))
    const lx = lad.position.x, lz = lad.position.z
    let topY = lad.position.y
    while (((bot.blockAt(new Vec3(lx, topY + 1, lz))) || {}).name === 'ladder') topY++
    // climb = press toward the WALL the ladder hangs on. The ladder's `facing` points away
    // from its mount wall — aim opposite. ("Look at the ladder" fails when the ladder shares
    // my own column: that aims at my own feet and forward goes nowhere useful.)
    const lf = (lad.getProperties() || {}).facing || 'north'
    const AWAY = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[lf]
    safeStop()
    // enter the ladder COLUMN first — pressing at the mount wall from a neighboring
    // column just bounces against bare wall beside the ladder (learned live)
    const myCell = bot.entity.position.floored()
    if (!(myCell.x === lx && myCell.z === lz)) {
      await nudgeInto(new Vec3(lx, myCell.y, lz), false)
    }
    await bot.lookAt(new Vec3(lx + 0.5 - AWAY[0] * 2, bot.entity.position.y + 0.6, lz + 0.5 - AWAY[1] * 2), true)
    bot.setControlState('forward', true)
    bot.setControlState('jump', true)    // physics only sees a ladder at the FEET cell — a hop
                                         // lifts the feet into it, and climbUsingJump takes over
    const t0 = Date.now()
    let crested = false
    while (Date.now() - t0 < 15000) {
      await bot.waitForTicks(2)
      if (bot.entity.position.y >= topY + 0.9) { crested = true; break }
    }
    bot.setControlState('jump', false)
    await bot.waitForTicks(8)            // momentum carries the step-off past the hatch lip
    bot.setControlState('forward', false)
    ok(res, { climbed: crested, y: Math.round(bot.entity.position.y * 10) / 10, ladderTop: topY, onGround: bot.entity.onGround })
  } catch (e) { try { bot.clearControlStates() } catch (_) {}; err(res, e) }
})

app.get('/pillar', async (req, res) => {
  try {
    const height = Math.min(16, Math.max(1, parseInt(req.query.height || '3')))
    const names = ['cobblestone', 'andesite', 'dirt']
    let placed = 0
    const y0 = Math.floor(bot.entity.position.y)
    for (let i = 0; i < height; i++) {
      const yBefore = Math.floor(bot.entity.position.y)
      const below = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
      if (!below || below.boundingBox !== 'block') return ok(res, { placed, rose: yBefore - y0, stopped: 'no solid footing to build on' })
      let it = null
      for (const n of names) { it = bot.inventory.items().find(m => m.name === n); if (it) break }
      if (!it) return ok(res, { placed, rose: yBefore - y0, stopped: 'out of pillar blocks (cobble/andesite/dirt)' })
      await bot.equip(it, 'hand')
      await bot.lookAt(below.position.offset(0.5, 1, 0.5), true)
      let rose = false
      for (let attempt = 0; attempt < 3 && !rose; attempt++) {
        bot.setControlState('jump', true)
        await new Promise(r => setTimeout(r, 180))                       // near jump apex
        try { await bot.placeBlock(below, new Vec3(0, 1, 0)) } catch (e) {}
        bot.setControlState('jump', false)
        await new Promise(r => setTimeout(r, 400))                       // settle
        if (Math.floor(bot.entity.position.y) > yBefore) { rose = true; placed++ }
      }
      if (!rose) return ok(res, { placed, rose: Math.floor(bot.entity.position.y) - y0, stopped: 'placement would not take (ceiling? cell blocked?)' })
    }
    ok(res, { placed, rose: Math.floor(bot.entity.position.y) - y0, y: Math.floor(bot.entity.position.y) })
  } catch (e) { try { bot.setControlState('jump', false) } catch (_) {} ; err(res, e) }
})

// GET /listen?window=60 — what have I HEARD lately? Pull-only companion to the danger-tier hear
// events: everything the ears buffered, aggregated by category (species for mobs), never streamed.
app.get('/listen', (req, res) => {
  try {
    const windowS = Math.min(300, Math.max(5, parseInt(req.query.window || '60')))
    const s = hearSummary(windowS * 1000)
    const payload = { heard: s || null, summary: s ? `heard (last ${windowS}s): ${s}` : `nothing heard in the last ${windowS}s`, buffered: HEARD.length }
    if (req.query.verbose === '1') payload.raw = HEARD.slice(-25)   // forensic tail: exact sound names
    ok(res, payload)
  } catch (e) { err(res, e) }
})

// GET /gesture?name=nod|shake|wave|point[&at=x,y,z] — nonverbal presence for co-op play: the body
// can say yes, no, hello, and LOOK THERE without chat.
app.get('/gesture', async (req, res) => {
  try {
    const name = String(req.query.name || '').toLowerCase()
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const yaw0 = bot.entity.yaw, pitch0 = bot.entity.pitch
    if (name === 'nod') {
      for (let i = 0; i < 2; i++) { await bot.look(yaw0, -0.55, true); await sleep(180); await bot.look(yaw0, 0.35, true); await sleep(180) }
      await bot.look(yaw0, pitch0, true)
    } else if (name === 'shake') {
      for (let i = 0; i < 2; i++) { await bot.look(yaw0 - 0.6, pitch0, true); await sleep(180); await bot.look(yaw0 + 0.6, pitch0, true); await sleep(180) }
      await bot.look(yaw0, pitch0, true)
    } else if (name === 'wave') {
      for (let i = 0; i < 3; i++) { bot.swingArm('right'); await sleep(250) }
    } else if (name === 'point') {
      const [x, y, z] = String(req.query.at || '').split(',').map(Number)
      if (![x, y, z].every(Number.isFinite)) return err(res, new Error('point needs at=x,y,z'))
      await bot.lookAt(new Vec3(x + 0.5, y + 0.5, z + 0.5), true)
      for (let i = 0; i < 2; i++) { bot.swingArm('right'); await sleep(300) }
    } else return err(res, new Error('name must be nod|shake|wave|point'))
    ok(res, { gestured: name })
  } catch (e) { err(res, e) }
})

// GET /boot — the one-call session opener: body, world, exits, tools, jobs, and the chat cursor
// value to write into heartbeat_cursor.txt. Replaces the four-curl boot ritual.
app.get('/boot', (req, res) => {
  try {
    if (!ready) return err(res, new Error('not ready'))
    const pos = bot.entity.position
    const oh = overheadCover()
    const around = spatial3D(bot)
    const held = heldInfo()
    const jl = jobs.list().filter(j => j.status === 'running')
    // armor slots 5..8 = head/torso/legs/feet — worn gear never shows in items(), so report it here
    const armorNames = ['head', 'torso', 'legs', 'feet']
    const armor = [5, 6, 7, 8].map((s, i) => {
      const it = bot.inventory.slots[s]
      return it ? { slot: armorNames[i], name: it.name } : null
    }).filter(Boolean)
    const summary =
      `${bot.username || 'bot'} @ (${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}), HP ${bot.health}/20, food ${bot.food}/20, ` +
      `holding ${held ? held.name + (held.durability != null ? ` (${held.durability}/${held.maxDurability})` : '') : 'nothing'}. ` +
      (armor.length ? `Wearing: ${armor.map(a => a.name + ' (' + a.slot + ')').join(', ')}. ` : 'No armor worn. ') +
      ((bot.inventory.slots[45] && bot.inventory.slots[45].name) ? `Offhand: ${bot.inventory.slots[45].name}. ` : '') +
      skyPhrase(oh) + (around ? `Around: ${around}. ` : '') +
      (jl.length ? `RUNNING JOBS: ${jl.map(j => j.id + ':' + j.name).join(', ')}. ` : 'No jobs running. ') +
      `Chat cursor: ${chatSeq} (write this to heartbeat_cursor.txt).`
    ok(res, {
      summary, pos: round(pos), health: bot.health, food: bot.food, held, armor,
      sky: oh, chatSeq, seenCells: SEEN.size,
      waypoints: Object.keys(waypoints.list()), runningJobs: jl.map(j => ({ id: j.id, name: j.name })),
      reflexes: reflexes.map(r => ({ name: r.name, on: r.on }))
    })
  } catch (e) { err(res, e) }
})

// ---- MACROS: high-level verbs with guardrails baked in, run ASYNC via jobs.start ----

// GET /gather?resource=&amount=&radius= : background job that repeatedly finds the
// nearest matching block and mines it. GUARDRAILS: capped radius (default 40, hard-max
// 64); never dig straight down (skip any target >~2 below feet, prefer at/above feet or
// side-reachable); skip candidates pathfinder can't reach and try the next nearest;
// stop when 'amount' collected or no reachable target remains.
app.get('/gather', (req, res) => {
  try {
    const Vec3 = require('vec3').Vec3
    const resource = req.query.resource
    if (!resource) return err(res, new Error('resource required'))
    const amount = Math.max(1, parseInt(req.query.amount || '16'))
    let radius = parseInt(req.query.radius || '40')
    if (!Number.isFinite(radius) || radius <= 0) radius = 40
    radius = Math.min(radius, 64)                 // hard-max 64
    const ids = resolveBlockIds(resource)
    if (!ids.length) return err(res, new Error(`unknown block: ${resource}`))

    const { id } = jobs.start(`gather ${resource} x${amount}`, async (job) => {
      let mined = 0
      const tried = new Set()                     // positions we've given up on
      const key = (p) => `${p.x},${p.y},${p.z}`
      const startT = Date.now()
      let iters = 0
      let noProgress = 0                          // consecutive iterations with no mine (circuit breaker)
      // FORESTRY: harvesting wood → walk like a lumberjack (clear leaves+logs to travel) and
      // reach the whole trunk, not just the bottom few. Restored to considerate nav in finally.
      const isWood = ids.some(i => { const n = mcData.blocks[i] && mcData.blocks[i].name; return !!n && (n.endsWith('_log') || n.endsWith('_wood')) })
      const maxRise = isWood ? 24 : GATHER_MAX_RISE
      const usingForestry = isWood && !!forestryMoves
      const prevThink = bot.pathfinder.thinkTimeout
      // forestry pathfinding is heavier (canDig opens dig-moves at every node), so a truly
      // awkward floating log can eat the full 10s think budget before we skip it. Fail fast:
      // drop the think budget while gathering wood so unreachable targets are abandoned quickly.
      if (usingForestry) { bot.pathfinder.setMovements(forestryMoves); bot.pathfinder.thinkTimeout = 3000; job.progress('forestry nav: may clear leaves+logs') }
      try {
      while (mined < amount) {
        if (job.cancelled) { job.progress('cancelled'); break }
        if (++iters > amount * 8 + 40 || Date.now() - startT > 180000) { job.progress('watchdog: stopping (iter/time bound)'); break }
        const feetY = Math.floor(bot.entity.position.y)
        // pull a batch so we can pick a SAFE candidate (not the raw nearest)
        const cands = bot.findBlocks({ matching: ids, maxDistance: radius, count: 40 })
        const here = bot.entity.position
        const ranked = cands
          .filter(p => !tried.has(key(p)))
          .map(p => ({ p, dist: here.distanceTo(p), drop: feetY - p.y }))
          // GUARDRAIL: never dig straight down. Refuse anything more than ~2 below feet
          // (a shaft); keep only targets at/above feet or reachable from the side.
          .filter(o => o.drop <= GATHER_MAX_DROP && o.drop >= -maxRise)
          .filter(o => canSeeBlock(o.p, radius))     // FAIRNESS: only what a player here could see
          .sort((a, b) => a.dist - b.dist)
        if (!ranked.length) {
          job.progress(`no reachable ${resource} left (mined ${mined}/${amount})`)
          break
        }
        let progressed = false
        for (const { p } of ranked) {
          const b = bot.blockAt(new Vec3(p.x, p.y, p.z))
          if (!b || !ids.includes(b.type)) { tried.add(key(p)); continue }
          try {
            // approach from a reachable spot, then collect (dig into a face, not a shaft)
            await bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 2))
          } catch (e) {
            // GUARDRAIL: unreachable candidate -> skip, try next nearest, don't flail
            tried.add(key(p))
            job.progress(`skip unreachable @ ${p.x},${p.y},${p.z}: ${e.message}`)
            continue
          }
          try {
            await bot.collectBlock.collect(b)
            mined++
            progressed = true
            job.progress(`mined ${resource} ${mined}/${amount} @ ${p.x},${p.y},${p.z}`)
          } catch (e) {
            tried.add(key(p))
            job.progress(`dig failed @ ${p.x},${p.y},${p.z}: ${e.message}`)
          }
          break                                   // re-scan from the new position each mine
        }
        // CIRCUIT BREAKER: one iteration tries every visible candidate, so an iteration with
        // no mine means nothing is reachable from here right now. A few of those in a row = this
        // spot is tapped out (or a target keeps timing out) → stop cleanly and let the driver
        // reposition, instead of grinding the same unreachable logs.
        if (progressed) noProgress = 0
        else if (++noProgress >= 3) {
          job.progress(`spot tapped out — no reachable ${resource} in ${noProgress} passes (mined ${mined}/${amount})`)
          break
        }
      }
      const have = bot.inventory.items()
        .filter(it => it.name.includes(resource) || resource.includes(it.name))
        .reduce((s, it) => s + it.count, 0)
      emitEvent('gather', `done ${resource} mined=${mined}`, { inventoryMatching: have })
      return { mined, requested: amount, inventoryMatching: have }
      } finally {
        if (usingForestry && considerateMoves) { bot.pathfinder.setMovements(considerateMoves); bot.pathfinder.thinkTimeout = prevThink }
      }
    })
    ok(res, { job: id })
  } catch (e) { err(res, e) }
})

// Shared STEP primitive — physics-walk the bot one cell instead of asking the pathfinder to plan
// it. Under canDig=false the pathfinder REFUSES the tight 1-block move into a just-carved mining
// cell (stalls "Path was stopped before"): climbing a 1-wide step, dropping into a descend cell, or
// advancing a fresh tunnel face. So we face the target and hold forward (+ jump when climbing),
// polling until the bot is actually in the cell and grounded. The undug wall beyond stops overshoot.
// climbing=true → ascending (mount +1); false → level/descending (walk or fall into the cell).
async function nudgeInto (target, climbing, timeoutMs = 3000) {
  const Vec3 = require('vec3').Vec3
  try {
    await bot.lookAt(new Vec3(target.x + 0.5, target.y + 0.5, target.z + 0.5), true)
    bot.setControlState('forward', true)
    if (climbing) bot.setControlState('jump', true)
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      await new Promise(r => setTimeout(r, 60))
      const p = bot.entity.position.floored()
      const yOk = climbing ? p.y >= target.y : p.y <= target.y
      // cut power the moment we ENTER the target column — do NOT wait for onGround with controls
      // held: a held jump keeps the bot airborne at poll time, so it blows straight through the
      // cell and sprints on (the 07-11 open-terrain overshoot to x-35). Settle+verify AFTER.
      if (p.x === target.x && p.z === target.z && yOk) break
    }
  } finally { bot.setControlState('forward', false); bot.setControlState('jump', false) }
  await new Promise(r => setTimeout(r, 250))   // let physics settle (land + shed momentum), then verify
  const p = bot.entity.position.floored()
  return (p.x === target.x && p.z === target.z && Math.abs(p.y - target.y) <= 1)
}

// DOORWAY COMMIT (07-15) — the helmsman's maneuver, in his words: "you gotta commit that one straight
// ahead block walk before turning when going through." The pathfinder cheats doorways with a
// diagonal (the stall path cost even shows the telltale 1.41) and clips the jamb — zero progress,
// 'stuck' reset, replan, forever. So when a goto stalls near a door/gate, the body does what a
// player does: square up on the near cell, clear the panel if it actually blocks the line (the
// collision SHAPE decides, not the open flag — a sideways-placed door is walkable CLOSED and a
// wall OPEN), then nudgeInto the door cell and the cell beyond — two dead-straight committed
// steps, no pathfinder, no diagonal. Returns true if we ended up through; caller resumes route.
async function doorwayCommit () {
  const Vec3 = require('vec3').Vec3
  const me = bot.entity.position.floored()
  // nearest door/gate within ~3.5 — check the walk plane and one up (upper door half)
  const ids = Object.values(mcData.blocksByName)
    .filter(b => /(_door|_fence_gate)$/.test(b.name) && b.name !== 'iron_door').map(b => b.id)
  const found = bot.findBlocks({ matching: ids, maxDistance: 4, count: 8 })
    .map(p => bot.blockAt(p)).filter(Boolean)
    .filter(b => { const h = (b.getProperties() || {}).half; return h !== 'upper' })  // feet cell only
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0]
  if (!found) return false
  const D = found.position
  const ddx = D.x + 0.5 - (me.x + 0.5), ddz = D.z + 0.5 - (me.z + 0.5)
  const xT = Math.abs(ddx) >= Math.abs(ddz)
  const sx = xT ? (ddx >= 0 ? 1 : -1) : 0, sz = xT ? 0 : (ddz >= 0 ? 1 : -1)
  const nearC = D.offset(-sx, 0, -sz), farC = D.offset(sx, 0, sz)
  console.log(`[doorway] commit via ${found.name} at ${D} axis=${xT ? 'x' : 'z'} near=${nearC} far=${farC}`)
  // 1. square up on the near cell (a plain non-door walk; pathfinder is fine at this)
  if (!(me.x === nearC.x && me.z === nearC.z)) {
    try { await bot.pathfinder.goto(new goals.GoalBlock(nearC.x, nearC.y, nearC.z)) }
    catch (e) { const p = bot.entity.position.floored(); if (p.x !== nearC.x || p.z !== nearC.z) { console.log('[doorway] could not square up: ' + (e.message || '').slice(0, 50)); return false } }
  }
  // 2. does the panel actually block the straight line? collision shapes decide; open-flag fallback
  const fresh = bot.blockAt(D)
  let blocked
  try {
    const shapes = (fresh && fresh.shapes) || []
    blocked = shapes.some(s => { const lo = xT ? s[2] : s[0], hi = xT ? s[5] : s[3]; return lo < 0.78 && hi > 0.22 })
    if (!shapes.length) blocked = !((fresh.getProperties() || {}).open)
  } catch (e) { blocked = !((fresh.getProperties() || {}).open) }
  console.log(`[doorway] panel blocked=${blocked} shapes=${JSON.stringify(fresh && fresh.shapes)}`)
  if (blocked) { try { await bot.activateBlock(fresh) } catch (e) {} ; await bot.waitForTicks(3) }
  // 3. the committed straight walk: door cell, then the cell beyond — no turning mid-threshold
  if (!await nudgeInto(D, false)) { console.log('[doorway] stuck entering the threshold') ; return false }
  if (!await nudgeInto(farC, false)) { console.log('[doorway] crossed the door cell but not beyond') ; return false }
  console.log('[doorway] through clean')
  return true
}

// GET /dig_tunnel?dir=&length=&torch= : EXPLORE-TO-FIND mining. Drives a 1-wide x 2-high
// corridor from where the bot stands — digs the wall directly AHEAD, steps in, repeats. This
// is the HONEST way to mine into rock: it discovers ore by exposing it, and never routes to a
// buried vein (no x-ray). Grabs ore laid bare in the corridor walls as it passes, lights the
// path with torches, and STOPS on lava/water/bedrock/floor-gap/full-inventory. Fairness floor
// intact — it only ever digs where it stands, one block at a time, seeing what a miner sees.
app.get('/dig_tunnel', async (req, res) => {
  try {
    const Vec3 = require('vec3').Vec3
    const DIRS = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0], north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }
    let dx, dz
    const dirParam = (req.query.dir || '').toLowerCase()
    if (DIRS[dirParam]) { [dx, dz] = DIRS[dirParam] }
    else {                              // derive a cardinal from facing (mc: facing = (-sin yaw, cos yaw))
      const yaw = bot.entity.yaw, sx = -Math.sin(yaw), cz = Math.cos(yaw)
      if (Math.abs(sx) >= Math.abs(cz)) { dx = Math.sign(sx) || 1; dz = 0 } else { dx = 0; dz = Math.sign(cz) || 1 }
    }
    const length = Math.min(Math.max(1, parseInt(req.query.length || '12')), 64)
    const torchEvery = req.query.torch != null ? parseInt(req.query.torch) : 5   // 0 disables torches
    const perp = dx !== 0 ? [[0, -1], [0, 1]] : [[-1, 0], [1, 0]]                 // wall offsets across the travel axis
    const dirName = dirParam || (dx ? (dx > 0 ? 'e' : 'w') : (dz > 0 ? 's' : 'n'))

    const { id } = jobs.start(`dig_tunnel ${dirName} x${length}`, async (job) => {
      let dug = 0, stop = null
      const found = {}
      const note = (n, p) => { found[n] = (found[n] || 0) + 1; emitEvent('mine', `struck ${n} @ ${p.x},${p.y},${p.z}`) }
      const isHazard = (b) => b && (b.name.includes('lava') || b.name.includes('water'))
      const equipPick = async (b) => { await equipPickFor(b && b.name) }   // tier-aware (07-12)

      for (let step = 0; step < length && !stop; step++) {
        if (job.cancelled) { stop = 'cancelled'; break }
        const base = bot.entity.position.floored()
        const ahead = base.offset(dx, 0, dz), aheadHead = ahead.offset(0, 1, 0), aheadFloor = ahead.offset(0, -1, 0)
        // SAFETY: refuse to breach lava/water — scan what digging ahead would expose
        for (const p of [ahead.offset(dx, 0, dz), aheadHead.offset(dx, 0, dz), aheadFloor, aheadHead.offset(0, 1, 0)]) {
          const hb = bot.blockAt(p); if (isHazard(hb)) { stop = `${hb.name} ahead — stopping short of it`; break }
        }
        if (stop) break
        await equipPick()
        for (const p of [aheadHead, ahead]) {                 // dig head then feet
          const b = bot.blockAt(p)
          if (!b || b.name === 'air') continue
          if (b.name === 'bedrock') { stop = 'hit bedrock'; break }
          if (b.name.includes('ore')) note(b.name, p)
          await equipPick(b)
          try { await bot.dig(b); dug++ } catch (e) { stop = 'dig failed: ' + e.message.slice(0, 30); break }
        }
        if (stop) break
        const fb = bot.blockAt(aheadFloor)                    // keep a solid floor so we don't fall / breach a drop
        if (!fb || fb.boundingBox !== 'block') {
          if (isHazard(fb)) { stop = `${fb.name} below — stopping`; break }
          const r = await macroPlaceAt(Vec3, aheadFloor.x, aheadFloor.y, aheadFloor.z, ['cobblestone', 'dirt', 'andesite'], false)
          if (!r.done) { stop = 'gap in floor, nothing to fill it with'; break }
          await equipPick()
        }
        if (!(await nudgeInto(ahead, false))) { stop = 'cannot advance: nudge stalled'; break }
        const here = bot.entity.position.floored()            // grab ore now exposed in the corridor walls (adjacent, fair)
        for (const [ox, oz] of perp) for (const oy of [0, 1]) {
          const wb = bot.blockAt(here.offset(ox, oy, oz))
          if (wb && wb.name.includes('ore')) { note(wb.name, here.offset(ox, oy, oz)); await equipPick(wb); try { await bot.dig(wb); dug++ } catch (e) {} }
        }
        if (torchEvery > 0 && step % torchEvery === 0) { await macroPlaceAt(Vec3, here.x - dx, here.y, here.z - dz, ['torch'], false); await equipPick() }
        if (bot.inventory.emptySlotCount() === 0) { stop = 'inventory full'; break }
        job.progress(`step ${step + 1}/${length}, dug ${dug}, ores ${JSON.stringify(found)}`)
      }
      const stopped = stop || 'length reached'
      emitEvent('mine', `tunnel done: dug ${dug}, stopped=${stopped}, ores=${JSON.stringify(found)}`)
      return { dug, stopped, found }
    })
    ok(res, { job: id })
  } catch (e) { err(res, e) }
})

// GET /dig_stair?dir=&up=&steps=&torch= : mine an ASCENDING (up=1, default) or descending (up=-1)
// staircase — the fair way to climb out of a deep cave without swimming a water elevator. Each
// step digs the 2-high (3 for headroom going up) passage at the next diagonal position and steps
// onto it. STOPS on any water/lava it would expose (never breach a flood) or gravel/sand (would
// bury me); places a tread from andesite/cobble/dirt if the step is missing; torches the climb.
app.get('/dig_stair', async (req, res) => {
  try {
    const Vec3 = require('vec3').Vec3
    const DIRS = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0], north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }
    let dx, dz
    const dirParam = (req.query.dir || '').toLowerCase()
    if (DIRS[dirParam]) { [dx, dz] = DIRS[dirParam] }
    else { const yaw = bot.entity.yaw, sx = -Math.sin(yaw), cz = Math.cos(yaw); if (Math.abs(sx) >= Math.abs(cz)) { dx = Math.sign(sx) || 1; dz = 0 } else { dx = 0; dz = Math.sign(cz) || 1 } }
    const up = parseInt(req.query.up || '1') >= 1 ? 1 : -1  // up=0 means DOWN (a pilot burned a staircase on `0 >= 0`)
    const steps = Math.min(Math.max(1, parseInt(req.query.steps || '24')), 96)
    const torchEvery = req.query.torch != null ? parseInt(req.query.torch) : 4
    const dirName = dirParam || (dx ? (dx > 0 ? 'e' : 'w') : (dz > 0 ? 's' : 'n'))

    const { id } = jobs.start(`dig_stair ${up > 0 ? 'up' : 'down'} ${dirName} x${steps}`, async (job) => {
      let dug = 0, stop = null, climbed = 0
      const isHazard = (b) => b && (b.name.includes('lava') || b.name.includes('water'))
      const fally = (b) => b && (b.name === 'gravel' || b.name === 'sand' || b.name === 'red_sand')
      const equipPick = async (b) => { await equipPickFor(b && b.name) }   // tier-aware (07-12)
      // (per-step movement uses the shared module-scope nudgeInto — see above the /dig_tunnel route)
      for (let s = 0; s < steps && !stop; s++) {
        if (job.cancelled) { stop = 'cancelled'; break }
        const b0 = bot.entity.position.floored()
        const nx = b0.x + dx, nz = b0.z + dz, ny = b0.y + up
        const tread = new Vec3(nx, ny - 1, nz), feet = new Vec3(nx, ny, nz), head = new Vec3(nx, ny + 1, nz), above = new Vec3(nx, ny + 2, nz)
        // ASCENDING needs LAUNCH clearance too: the climb-nudge jumps from the CURRENT cell, so the
        // block above my own head must be open or the jump hits it and the nudge stalls (the 07-11
        // "cannot climb: nudge stalled under a low ceiling" bug).
        const launch = up > 0 ? [new Vec3(b0.x, b0.y + 2, b0.z)] : []
        // SAFETY: refuse to breach lava/water or dig under fall-blocks — scan what we'd expose
        for (const p of [...launch, feet, head, above, new Vec3(nx + dx, ny, nz + dz), new Vec3(nx + dx, ny + 1, nz + dz)]) {
          const hb = bot.blockAt(p)
          if (isHazard(hb)) { stop = `${hb.name} ahead — stopping short`; break }
          if (fally(hb)) { stop = `${hb.name} overhead — stopping (would bury me)`; break }
        }
        if (stop) break
        await equipPick()
        for (const p of [...launch, above, head, feet]) {   // clear the FULL 2-tall passage + head clearance.
          // Descending needs `above` (nx,ny+2) dug too: the bot is 2 blocks tall, so stepping into
          // the next-lower cell its head sweeps through ny+2 — leave that solid and it's walled in
          // at head height and can't move in (the real cause of the old descend stall).
          const bb = bot.blockAt(p)
          if (!bb || bb.name === 'air') continue
          if (bb.name === 'bedrock') { stop = 'hit bedrock'; break }
          await equipPick(bb)
          try { await bot.dig(bb); dug++ } catch (e) { stop = 'dig failed: ' + e.message.slice(0, 26); break }
        }
        if (stop) break
        const tb = bot.blockAt(tread)                                      // need a tread to stand on
        if (!tb || tb.boundingBox !== 'block') {
          if (isHazard(tb)) { stop = `${tb.name} at the step — stopping`; break }
          const r = await macroPlaceAt(Vec3, tread.x, tread.y, tread.z, ['andesite', 'cobblestone', 'dirt'], false)
          if (!r.done) { stop = 'no step to stand on, nothing to place'; break }
          await equipPick()
        }
        if (!(await nudgeInto(feet, up > 0))) { stop = (up > 0 ? 'cannot climb' : 'cannot descend') + ': nudge stalled at ' + Math.floor(bot.entity.position.y); break }
        climbed += up
        if (torchEvery > 0 && s % torchEvery === 0) { await macroPlaceAt(Vec3, b0.x, b0.y, b0.z, ['torch'], false); await equipPick() }
        if (bot.inventory.emptySlotCount() === 0) { stop = 'inventory full'; break }
        const y = Math.floor(bot.entity.position.y)
        job.progress(`step ${s + 1}/${steps}, y=${y}, dug ${dug}`)
        if (up > 0 && y >= 68) { stop = 'reached surface level'; break }
      }
      const stopped = stop || 'steps done'
      emitEvent('mine', `dig_stair ${up > 0 ? 'up' : 'down'} done: climbed ${climbed}, dug ${dug}, y=${Math.floor(bot.entity.position.y)}, stopped=${stopped}`)
      return { climbed, dug, stopped, endY: Math.floor(bot.entity.position.y) }
    })
    ok(res, { job: id })
  } catch (e) { err(res, e) }
})

// GET /build?template=cabin&x=&z=&w=&d=&h= : background job raising a full structure --
// cobble/plank base perimeter -> plank walls to height h (default 3) -> 2-high doorway
// centered on the west (-x) side -> a SOLID roof placed outer-ring-first (so each interior
// roof cell has an already-placed neighbor to build against). Reuses the /outline,/walls,
// /roof placement approach. Pulls from inventory; skips cells already solid.
app.get('/build', (req, res) => {
  try {
    const template = req.query.template || 'cabin'
    if (template !== 'cabin') return err(res, new Error(`unknown template: ${template} (only 'cabin')`))
    const x0 = Math.floor(parseFloat(req.query.x))
    const z0 = Math.floor(parseFloat(req.query.z))
    if (!Number.isFinite(x0) || !Number.isFinite(z0)) return err(res, new Error('x and z required'))
    const w = Math.max(3, parseInt(req.query.w || '7'))
    const d = Math.max(3, parseInt(req.query.d || '7'))
    const h = Math.max(2, parseInt(req.query.h || '3'))
    const base = Math.floor(parseFloat(req.query.base || bot.entity.position.y))
    const baseMat = req.query.base_name || 'cobblestone'
    const wallMat = req.query.name || 'oak_planks'

    // west doorway centered on the -x wall (matches /walls door='west')
    const doorCell = [x0, z0 + Math.floor(d / 2)]
    const isDoor = (x, z) => x === doorCell[0] && z === doorCell[1]

    const { id } = jobs.start(`build ${template} ${w}x${d}h${h} @${x0},${z0}`, async (job) => {
      const Vec3 = require('vec3').Vec3
      const stats = { foundation: 0, walls: 0, roof: 0, skipped: 0, failed: 0 }
      const perim = []
      for (let i = 0; i < w; i++) for (let j = 0; j < d; j++) {
        if (i === 0 || i === w - 1 || j === 0 || j === d - 1) perim.push([x0 + i, z0 + j])
      }

      // ---- foundation: base-material perimeter at y=base ----
      job.progress('phase: foundation')
      for (const [x, z] of perim) {
        if (job.cancelled) break
        if (isDoor(x, z)) continue                 // leave the doorway cell open (no place-then-dig churn)
        const r = await macroPlaceAt(Vec3, x, base, z, [baseMat, wallMat])
        if (r.placed) stats.foundation++
        else if (r.skipped) stats.skipped++
        else stats.failed++
      }
      emitEvent('build', `foundation done (${stats.foundation})`, { x: x0, z: z0 })

      // ---- walls: perimeter columns base+1..base+h-1, leaving the doorway open ----
      job.progress('phase: walls')
      for (const [x, z] of perim) {
        if (job.cancelled) break
        for (let k = 1; k < h; k++) {
          if (isDoor(x, z) && k < 2) { continue }  // 2-high doorway (rows k=0 base & k=1)
          const r = await macroPlaceAt(Vec3, x, base + k, z, [wallMat, baseMat])
          if (r.placed) stats.walls++
          else if (r.skipped) stats.skipped++
          else stats.failed++
        }
      }

      // ---- door: guarantee the 2-high doorway span (base..base+1) is clear ----
      job.progress('phase: door')
      for (let k = 0; k < 2; k++) {
        const dp = new Vec3(doorCell[0], base + k, doorCell[1])
        const db = bot.blockAt(dp)
        if (db && db.name !== 'air' && db.boundingBox === 'block') {
          try { await bot.pathfinder.goto(new goals.GoalNear(dp.x, dp.y, dp.z, 3)); await bot.dig(db) } catch (e) {}
        }
      }

      // ---- roof: solid slab at y=base+h, outer-ring-first (neighbor to build against) ----
      job.progress('phase: roof')
      const roofCells = []
      for (let i = 0; i < w; i++) for (let j = 0; j < d; j++) {
        roofCells.push([x0 + i, z0 + j, Math.min(i, j, w - 1 - i, d - 1 - j)])
      }
      roofCells.sort((a, b) => a[2] - b[2])       // outer rings first
      for (const [x, z] of roofCells) {
        if (job.cancelled) break
        const r = await macroPlaceAt(Vec3, x, base + h, z, [wallMat, baseMat])
        if (r.placed) stats.roof++
        else if (r.skipped) stats.skipped++
        else stats.failed++
      }

      emitEvent('build', `cabin complete f=${stats.foundation} w=${stats.walls} r=${stats.roof}`, stats)
      return { template, size: `${w}x${d}`, height: h, corner: { x: x0, z: z0 }, ...stats }
    })
    ok(res, { job: id })
  } catch (e) { err(res, e) }
})

// GET /safe_goto?x=&y=&z=&range= : goto with recovery. One direct GoalNear attempt; on a
// timeout/'took too long' failure, retry by marching toward the target in ~24-block
// segments (intermediate GoalNear waypoints). Synchronous but hard-bounded (not a job).
// Returns final position and whether it fully arrived. ?verbose=1 for per-segment detail.
app.get('/safe_goto', async (req, res) => {
  try {
    const Vec3 = require('vec3').Vec3
    const x = parseFloat(req.query.x), y = parseFloat(req.query.y), z = parseFloat(req.query.z)
    if (![x, y, z].every(Number.isFinite)) return err(res, new Error('x, y, z required'))
    const range = parseInt(req.query.range || '2')
    const dest = new Vec3(x, y, z)
    const verbose = req.query.verbose === '1'
    const segLen = 24
    const isTimeout = (e) => /took too long|timeout|timed out/i.test(e.message || '')

    // first: a single direct attempt
    try {
      await bot.pathfinder.goto(new goals.GoalNear(x, y, z, range))
      const pos = bot.entity.position
      const arrived = pos.distanceTo(dest) <= range + 1
      return ok(res, verbose
        ? { arrived, method: 'direct', pos: round(pos), dist: +pos.distanceTo(dest).toFixed(1) }
        : { arrived, pos: round(pos) })
    } catch (e) {
      if (!isTimeout(e)) {
        // non-timeout failure (blocked/no path): report position, don't segment-loop
        const pos = bot.entity.position
        return ok(res, { arrived: false, method: 'direct', reason: e.message, pos: round(pos) })
      }
    }

    // recovery: segmented march toward the target, ~24 blocks at a time
    const segLog = []
    let guard = 0
    const maxSegs = 12                            // hard bound on the loop
    while (guard++ < maxSegs) {
      const cur = bot.entity.position
      const remaining = cur.distanceTo(dest)
      if (remaining <= range + 1) break
      const t = Math.min(1, segLen / remaining)   // waypoint ~segLen blocks toward dest
      const wx = cur.x + (dest.x - cur.x) * t
      const wy = cur.y + (dest.y - cur.y) * t
      const wz = cur.z + (dest.z - cur.z) * t
      try {
        await bot.pathfinder.goto(new goals.GoalNear(wx, wy, wz, 2))
        segLog.push({ to: round(new Vec3(wx, wy, wz)), ok: true })
      } catch (e) {
        segLog.push({ to: round(new Vec3(wx, wy, wz)), ok: false, reason: e.message })
        // if a segment stalls and we didn't move, bail rather than spin
        if (bot.entity.position.distanceTo(cur) < 1) break
      }
    }
    const pos = bot.entity.position
    const arrived = pos.distanceTo(dest) <= range + 1
    emitEvent('safe_goto', `${arrived ? 'arrived' : 'partial'} @ ${vecStr(pos)}`, { dest: round(dest), arrived })
    ok(res, verbose
      ? { arrived, method: 'segmented', pos: round(pos), dist: +pos.distanceTo(dest).toFixed(1), segments: segLog }
      : { arrived, pos: round(pos), segments: segLog.length })
  } catch (e) { err(res, e) }
})

// GET /smelt?item=&fuel=&count= : walk to the nearest furnace, load fuel + input, wait for
// the smelt to finish (polls the output slot, bounded), collect the result. 1 coal smelts 8.
app.get('/smelt', async (req, res) => {
  try {
    if (!ready) return err(res, new Error('not ready'))
    const inputName = req.query.item
    const fuelName = req.query.fuel || 'coal'
    const want = Math.max(1, parseInt(req.query.count || '1'))
    if (!inputName) return err(res, new Error('item required'))
    const fb = bot.findBlock({ matching: resolveBlockIds('furnace'), maxDistance: 8 })
    if (!fb) return err(res, new Error('no furnace within 8'))
    await bot.pathfinder.goto(new goals.GoalNear(fb.position.x, fb.position.y, fb.position.z, 2))
    const furnace = await bot.openFurnace(fb)
    try {
      const inItem = bot.inventory.items().find(i => i.name === inputName)
      const fuelItem = bot.inventory.items().find(i => i.name === fuelName)
      if (!inItem) throw new Error(`no ${inputName} to smelt`)
      if (!fuelItem) throw new Error(`no ${fuelName} for fuel`)
      const smeltCount = Math.min(want, inItem.count)
      const fuelNeeded = Math.min(fuelItem.count, Math.max(1, Math.ceil(smeltCount / 8)))
      await furnace.putFuel(fuelItem.type, null, fuelNeeded)
      await furnace.putInput(inItem.type, null, smeltCount)
      // wait for the output to accumulate (each item ~10s), bounded
      const deadline = Date.now() + smeltCount * 12000 + 15000
      let outCount = 0
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 1500))
        const o = furnace.outputItem()
        outCount = o ? o.count : 0
        if (outCount >= smeltCount) break
        if (!furnace.inputItem() && outCount > 0) break   // input consumed, output ready
      }
      let taken = null
      try { taken = await furnace.takeOutput() } catch (e) {}
      furnace.close()
      emitEvent('smelt', `${inputName} -> ${taken ? taken.count + ' ' + taken.name : 'nothing yet'}`)
      ok(res, { smelted: inputName, requested: smeltCount, got: taken ? { name: taken.name, count: taken.count } : null })
    } catch (e) { try { furnace.close() } catch (x) {} ; err(res, e) }
  } catch (e) { err(res, e) }
})

app.listen(CTRL_PORT, BIND_HOST, () => console.log(`[bot] control API on http://${BIND_HOST}:${CTRL_PORT}`))
