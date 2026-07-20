#!/usr/bin/env node
// Regenerate prismarine-viewer's entity registry from Mojang/bedrock-samples (2026-07-20).
//
// Why: upstream prismarine-viewer abandoned its entity layer in ~2020 — a ~94-mob registry in
// old-bedrock format, textures pinned to 1.16.4. Anything newer (allay, warden, camel, ...)
// throws "Unknown entity" and renders as a magenta box. This script parses the modern
// bedrock-samples geometry (.geo.json) + client-entity wiring (.entity.json) and emits entries
// in the registry format the viewer's Entity.js renderer already understands, then merges them
// over the old registry: prefer the fresh conversion, keep the old entry on any doubt.
//
// Renderer contract (viewer/lib/entity/Entity.js): box-UV only (uv = [u,v]); bones
// {name, parent, pivot, rotation|bind_pose_rotation, cubes}; cubes {origin, size, uv, inflate,
// rotation}. Cube rotation is applied about the MODEL ORIGIN, not the cube's bedrock pivot —
// we compensate exactly: feed origin' = origin − p + Rᵀ·p (renderer then produces R·(v−p)+p).
// R = Rx·Ry·Rz built from NEGATED degrees, verified numerically against THREE.Euler 'XYZ'.
//
// Usage: node tools/entity-registry/convert.js   (from the repo root or anywhere)
// Reads:  tools/entity-registry/bedrock-samples/resource_pack/{models/entity,entity}
//         node_modules/prismarine-viewer/viewer/lib/entity/entities.json   (the old registry)
//         node_modules/prismarine-viewer/public/textures/1.21.1/           (texture truth)
// Writes: tools/entity-registry/out/{converted.json, merged-entities.json, report.md}

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', '..')
const SAMPLES = path.join(__dirname, 'bedrock-samples', 'resource_pack')
const OLD_REGISTRY = path.join(ROOT, 'node_modules', 'prismarine-viewer', 'viewer', 'lib', 'entity', 'entities.json')
const TEX_ROOT = path.join(ROOT, 'node_modules', 'prismarine-viewer', 'public', 'textures', '1.21.1')
const OUT = path.join(__dirname, 'out')

// bedrock name → java name, where they differ
const NAME_MAP = {
  zombie_pigman: 'zombified_piglin',
  tropicalfish: 'tropical_fish',
  fish: 'cod',
  evocation_illager: 'evoker',
  evocation_fang: 'evoker_fangs',
  villager_v2: 'villager',
  zombie_villager_v2: 'zombie_villager',
  ender_crystal: 'end_crystal',
  eye_of_ender_signal: 'eye_of_ender',
  xp_bottle: 'experience_bottle',
  xp_orb: 'experience_orb',
  fireworks_rocket: 'firework_rocket',
  fishing_hook: 'fishing_bobber',
  thrown_trident: 'trident',
  wind_charge_projectile: 'wind_charge',
  breeze_wind_charge_projectile: 'breeze_wind_charge',
  moving_block: null, // bedrock-only tech entities & block entities: null = skip entirely
  shield: null,
  agent: null,
  npc: null,
  tripod_camera: null,
  elder_guardian_ghost: null,
  wither_skull_dangerous: null,
  chalkboard: null,
  bed: null,
  skull: null,
  decorated_pot: null,
  trial_spawner: null,
  sulfur_cube: null,
  chest_boat: null // java 1.21.2+ split boats per wood — handled by post-merge aliases
}

// java 1.21.2 split the boat entity per wood type; point them all at the boat model
const BOAT_WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak']

// ---------------------------------------------------------------- rotation math
function rotMatrix (rotDeg) { // matches THREE applyEuler(new Euler(-x,-y,-z,'XYZ')) — verified
  const [ax, ay, az] = rotDeg.map(d => -d * Math.PI / 180)
  const cx = Math.cos(ax); const sx = Math.sin(ax)
  const cy = Math.cos(ay); const sy = Math.sin(ay)
  const cz = Math.cos(az); const sz = Math.sin(az)
  return [
    [cy * cz, -cy * sz, sy],
    [cx * sz + sx * sy * cz, cx * cz - sx * sy * sz, -sx * cy],
    [sx * sz - cx * sy * cz, sx * cz + cx * sy * sz, cx * cy]
  ]
}
function applyT (R, v) { // R is orthonormal: transpose = inverse
  return [
    R[0][0] * v[0] + R[1][0] * v[1] + R[2][0] * v[2],
    R[0][1] * v[0] + R[1][1] * v[1] + R[2][1] * v[2],
    R[0][2] * v[0] + R[1][2] * v[1] + R[2][2] * v[2]
  ]
}

// ---------------------------------------------------------------- geometry index
// identifier → {texturewidth, textureheight, bones, parent?} across BOTH formats
function indexGeometries () {
  const index = {}
  const dir = path.join(SAMPLES, 'models', 'entity')
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    let j
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch (e) { continue }
    if (j['minecraft:geometry']) {
      for (const g of j['minecraft:geometry']) {
        const d = g.description || {}
        if (!d.identifier) continue
        index[d.identifier] = {
          texturewidth: d.texture_width, textureheight: d.texture_height,
          bones: g.bones || [], source: f
        }
      }
    } else {
      for (const key of Object.keys(j)) {
        if (!key.startsWith('geometry.')) continue
        const [id, parent] = key.split(':')
        index[id] = {
          texturewidth: j[key].texturewidth, textureheight: j[key].textureheight,
          bones: j[key].bones || [], parent, source: f
        }
      }
    }
  }
  return index
}

function resolveBones (id, index, seen = new Set()) { // legacy geometry.X:geometry.Y inheritance
  if (seen.has(id)) throw new Error('inheritance cycle at ' + id)
  seen.add(id)
  const g = index[id]
  if (!g) throw new Error('unresolved geometry ' + id)
  if (!g.parent) return g.bones
  const parentBones = resolveBones(g.parent, index, seen)
  const merged = [...parentBones]
  for (const b of g.bones) {
    const i = merged.findIndex(pb => pb.name === b.name)
    if (i >= 0) merged[i] = b; else merged.push(b)
  }
  return merged
}

// ---------------------------------------------------------------- cube/bone conversion
function convertBones (rawBones, flags) {
  const bones = []
  let cubeCount = 0
  // bedrock resolves bone parents case-insensitively (UMouth→head vs Head); the renderer
  // crashes on a miss, so resolve here — and drop refs that resolve nowhere
  const byLower = {}
  for (const rb of rawBones) byLower[rb.name.toLowerCase()] = rb.name
  for (const rb of rawBones) {
    const bone = { name: rb.name }
    if (rb.parent) {
      const exact = rawBones.some(b => b.name === rb.parent)
      const ci = byLower[rb.parent.toLowerCase()]
      if (exact) bone.parent = rb.parent
      else if (ci) { bone.parent = ci; flags.push('parent case-fixed ' + rb.name + '→' + ci) } else flags.push('orphan parent dropped ' + rb.name + '→' + rb.parent)
    }
    if (rb.pivot) bone.pivot = rb.pivot
    if (rb.bind_pose_rotation) bone.bind_pose_rotation = rb.bind_pose_rotation
    else if (rb.rotation) bone.rotation = rb.rotation
    if (rb.mirror) bone.mirror = rb.mirror
    if (rb.poly_mesh) { flags.push('poly_mesh bone ' + rb.name); return null }
    if (rb.cubes) {
      bone.cubes = []
      for (const rc of rb.cubes) {
        if (!rc.uv && rc.uv !== 0) { flags.push('cube without uv in ' + rb.name); return null }
        if (!Array.isArray(rc.uv)) { flags.push('per-face uv in ' + rb.name); return null }
        const cube = { origin: (rc.origin || [0, 0, 0]).slice(), size: rc.size, uv: rc.uv }
        if (rc.inflate) cube.inflate = rc.inflate
        if (rc.mirror) cube.mirror = rc.mirror
        if (rc.rotation) {
          cube.rotation = rc.rotation
          const p = rc.pivot
          if (p && (p[0] || p[1] || p[2])) { // renderer rotates about model origin — compensate
            const R = rotMatrix(rc.rotation)
            const rp = applyT(R, p) // Rᵀ·p = R⁻¹·p
            cube.origin = cube.origin.map((o, i) => o - p[i] + rp[i])
            flags.push('rotated cube compensated in ' + rb.name)
          }
        }
        bone.cubes.push(cube)
        cubeCount++
      }
    }
    bones.push(bone)
  }
  return { bones, cubeCount }
}

// ---------------------------------------------------------------- texture validation
function textureExists (texPath) { // registry paths look like 'textures/entity/allay/allay'
  return fs.existsSync(path.join(TEX_ROOT, texPath.replace(/^textures\//, '')) + '.png')
}
let texIndex = null
function findTextureByBasename (texPath) { // drift rescue: locate moved texture by basename
  if (!texIndex) {
    texIndex = {}
    const walk = (dir, rel) => {
      for (const f of fs.readdirSync(dir)) {
        const abs = path.join(dir, f)
        if (fs.statSync(abs).isDirectory()) walk(abs, rel + '/' + f)
        else if (f.endsWith('.png')) {
          const base = f.replace(/\.png$/, '')
          ;(texIndex[base] = texIndex[base] || []).push((rel + '/' + base).replace(/^\//, ''))
        }
      }
    }
    walk(TEX_ROOT, 'textures')
  }
  const base = texPath.split('/').pop()
  let hits = texIndex[base] || []
  if (hits.length > 1) hits = hits.filter(h => h.startsWith('textures/entity/')) // mob textures live here
  return hits.length === 1 ? hits[0] : null // still ambiguous → don't guess
}

// ---------------------------------------------------------------- main
function main () {
  const geoIndex = indexGeometries()
  const oldRegistry = JSON.parse(fs.readFileSync(OLD_REGISTRY, 'utf8'))
  let javaNames = null
  try { javaNames = new Set(Object.keys(require(path.join(ROOT, 'node_modules', 'minecraft-data'))('1.21.11').entitiesByName)) } catch (e) {}

  const converted = {}
  const report = { used: [], keptOld: [], added: [], skipped: [], texturePatched: [], unknownJava: [], noSource: [] }

  const entDir = path.join(SAMPLES, 'entity')
  for (const f of fs.readdirSync(entDir).sort()) { // sorted: modern 'x.entity.json' before 'x.v1.0.entity.json'
    if (!f.endsWith('.entity.json')) continue
    let desc
    try { desc = JSON.parse(fs.readFileSync(path.join(entDir, f), 'utf8'))['minecraft:client_entity'].description } catch (e) { continue }
    const bedrockName = (desc.identifier || '').replace(/^minecraft:/, '')
    if (!bedrockName) continue
    const javaName = bedrockName in NAME_MAP ? NAME_MAP[bedrockName] : bedrockName
    if (javaName === null) continue // bedrock-only tech entity
    if (converted[javaName]) continue // first successful conversion wins (modern file sorts first)
    if (javaNames && !javaNames.has(javaName) && !oldRegistry[javaName] && javaName !== 'player') {
      report.unknownJava.push(javaName + ' (from ' + f + ')')
      continue
    }

    const flags = []
    const geoMap = desc.geometry || {}
    const texMap = desc.textures || {}
    const geoKey = 'default' in geoMap ? 'default' : Object.keys(geoMap)[0]
    if (!geoKey) { report.skipped.push([javaName, 'no geometry map']); continue }
    const texKey = geoKey in texMap ? geoKey : ('default' in texMap ? 'default' : Object.keys(texMap)[0])
    let texPath = texMap[texKey]
    if (!texPath) { report.skipped.push([javaName, 'no texture']); continue }

    let bones
    try { bones = resolveBones(geoMap[geoKey], geoIndex) } catch (e) { report.skipped.push([javaName, e.message]); continue }
    const g = geoIndex[geoMap[geoKey]]
    const conv = convertBones(bones, flags)
    if (!conv) { report.skipped.push([javaName, flags.join('; ')]); continue }
    if (conv.cubeCount === 0) { report.skipped.push([javaName, 'zero cubes']); continue }

    if (!textureExists(texPath)) {
      const fixed = findTextureByBasename(texPath)
      if (fixed) { report.texturePatched.push(javaName + ': ' + texPath + ' → ' + fixed); texPath = fixed } else {
        report.skipped.push([javaName, 'texture missing: ' + texPath]); continue
      }
    }

    converted[javaName] = {
      identifier: 'minecraft:' + javaName,
      materials: desc.materials || { default: javaName },
      textures: { default: texPath },
      geometry: {
        default: {
          texturewidth: g.texturewidth || 64,
          textureheight: g.textureheight || 64,
          bones: conv.bones
        }
      },
      _flags: flags // stripped before final emit; kept in converted.json for the report
    }
  }

  // ---- merge: old registry is the floor; clean conversions replace; never leave a stale texture
  const merged = {}
  for (const [name, oldEntry] of Object.entries(oldRegistry)) {
    if (converted[name]) {
      const entry = JSON.parse(JSON.stringify(converted[name]))
      delete entry._flags
      merged[name] = entry
      report.used.push(name + (converted[name]._flags.length ? ' [' + converted[name]._flags.join('; ') + ']' : ''))
    } else {
      merged[name] = JSON.parse(JSON.stringify(oldEntry))
      report.keptOld.push(name)
    }
  }
  for (const [name, entry] of Object.entries(converted)) {
    if (merged[name]) continue
    const e = JSON.parse(JSON.stringify(entry))
    delete e._flags
    merged[name] = e
    report.added.push(name + (entry._flags.length ? ' [' + entry._flags.join('; ') + ']' : ''))
  }

  // java 1.21.2+ per-wood boat entities → alias to the boat model
  if (merged.boat) {
    for (const wood of BOAT_WOODS) {
      for (const suffix of ['_boat', '_chest_boat']) {
        const n = wood + suffix
        if (!merged[n] && (!javaNames || javaNames.has(n))) { merged[n] = merged.boat; report.added.push(n + ' (alias → boat)') }
      }
    }
    for (const n of ['bamboo_raft', 'bamboo_chest_raft']) {
      if (!merged[n] && (!javaNames || javaNames.has(n))) { merged[n] = merged.boat; report.added.push(n + ' (alias → boat)') }
    }
  }

  // texture pass over EVERY merged entry, but only keys the renderer will actually pair
  // with a geometry key: 1) exists → ok; 2) basename rescue (moved in the java tree);
  // 3) fill-forward: copy the png from the newest older version dir that has it (these
  // copies must ride along in the backup tar); 4) report as unresolved.
  report.filledForward = []
  const numver = v => v.split('.').map(Number)
  const texVersions = fs.readdirSync(path.join(TEX_ROOT, '..'))
    .filter(d => d !== '1.21.1' && /^\d+(\.\d+)*$/.test(d) && fs.statSync(path.join(TEX_ROOT, '..', d)).isDirectory())
    .sort((a, b) => { const A = numver(a); const B = numver(b); for (let i = 0; i < 3; i++) { if ((A[i] || 0) !== (B[i] || 0)) return (B[i] || 0) - (A[i] || 0) } return 0 })
  for (const [name, entry] of Object.entries(merged)) {
    if (!entry.textures || !entry.geometry) continue
    for (const k of Object.keys(entry.geometry)) {
      const tp = entry.textures[k]
      if (!tp || textureExists(tp)) continue
      const fixed = findTextureByBasename(tp)
      if (fixed) { entry.textures[k] = fixed; report.texturePatched.push(name + ': ' + tp + ' → ' + fixed); continue }
      const rel = tp.replace(/^textures\//, '') + '.png'
      const srcVer = texVersions.find(v => fs.existsSync(path.join(TEX_ROOT, '..', v, rel)))
      if (srcVer) {
        const dst = path.join(TEX_ROOT, rel)
        fs.mkdirSync(path.dirname(dst), { recursive: true })
        fs.copyFileSync(path.join(TEX_ROOT, '..', srcVer, rel), dst)
        report.filledForward.push(rel + ' (from ' + srcVer + ') [' + name + ']')
      } else {
        report.noSource.push(name + ': texture unresolved anywhere: ' + tp)
      }
    }
  }

  // final structural audit: the renderer throws (→ fallback box) on any orphan parent,
  // and old-registry entries carry some too — repair them the same way
  report.audit = []
  for (const [name, e] of Object.entries(merged)) {
    for (const g of Object.values(e.geometry || {})) {
      if (!g.bones || !g.bones.length) { report.audit.push(name + ': NO BONES'); continue }
      const byName = new Set(g.bones.map(b => b.name))
      const byLower2 = {}
      for (const b of g.bones) byLower2[b.name.toLowerCase()] = b.name
      for (const b of g.bones) {
        if (!b.parent || byName.has(b.parent)) continue
        const ci = byLower2[b.parent.toLowerCase()]
        if (ci) { report.audit.push(name + ': parent case-fixed ' + b.name + '→' + ci); b.parent = ci } else { report.audit.push(name + ': orphan parent dropped ' + b.name + '→' + b.parent); delete b.parent }
      }
    }
  }

  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, 'converted.json'), JSON.stringify(converted, null, 1))
  fs.writeFileSync(path.join(OUT, 'merged-entities.json'), JSON.stringify(merged, null, 1))

  const md = []
  md.push('# Entity registry conversion report — ' + new Date().toISOString().slice(0, 10))
  md.push('\nOld registry: ' + Object.keys(oldRegistry).length + ' mobs. Merged: ' + Object.keys(merged).length + ' mobs.\n')
  const section = (title, arr, fmt = x => x) => { md.push('## ' + title + ' (' + arr.length + ')\n'); for (const a of arr) md.push('- ' + fmt(a)); md.push('') }
  section('Converted, replacing old entry', report.used)
  section('New mobs added', report.added)
  section('Kept old entry (no clean conversion)', report.keptOld)
  section('Skipped (flagged, old kept if it existed)', report.skipped, s => s[0] + ' — ' + s[1])
  section('Texture paths patched (drift rescue)', report.texturePatched)
  section('Textures filled forward into 1.21.1 tree (add to backup tar!)', report.filledForward)
  section('Bone-parent repairs (post-merge audit)', report.audit)
  section('UNRESOLVED textures (will render untextured!)', report.noSource)
  section('Bedrock entities with no java match (ignored)', report.unknownJava)
  fs.writeFileSync(path.join(OUT, 'report.md'), md.join('\n'))
  console.log('merged: ' + Object.keys(merged).length + ' mobs (' + report.used.length + ' modernized, ' +
    report.added.length + ' added, ' + report.keptOld.length + ' kept old, ' + report.skipped.length + ' skipped)')
  console.log('report: ' + path.join(OUT, 'report.md'))
  for (const key of ['allay', 'warden', 'camel', 'sniffer', 'breeze', 'frog', 'glow_squid', 'armadillo', 'vex', 'evoker']) {
    console.log('  ' + key + ': ' + (report.added.find(a => a.startsWith(key)) ? 'ADDED' : report.used.find(a => a.startsWith(key + ' ') || a === key) ? 'MODERNIZED' : merged[key] ? 'kept old' : 'MISSING'))
  }
}

main()
