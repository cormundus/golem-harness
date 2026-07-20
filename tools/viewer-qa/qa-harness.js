// Viewer QA harness (2026-07-20, born during the entity-layer modernization).
//
// Serves the INSTALLED prismarine-viewer bundles (node_modules/prismarine-viewer/public)
// with a synthetic world and a synthetic entity cast over the same socket.io protocol the
// bot uses — so the whole render stack can be screenshot-tested without a Minecraft server.
//
//   node tools/viewer-qa/qa-harness.js 3005                    # standard 22-mob cast
//   node tools/viewer-qa/qa-harness.js 3005 --full             # every registry mob, grid
//   node tools/viewer-qa/qa-harness.js 3005 --full --rows=0-2  # grid rows subset (closer camera)
//   node tools/viewer-qa/qa-harness.js 3005 --only=allay,vex   # close-up line-up
//
// Pair with qa-snap.js for headless screenshots. The world also carries a block-entity
// stand-in row (chests, banners, short_grass) at x 2..12, z 2.
const { Vec3 } = require('vec3')
const path = require('path')

const VERSION = '1.21.11'
const PORT = parseInt(process.argv[2] || '3005', 10)
const VIEWER = path.join(__dirname, '..', '..', 'node_modules', 'prismarine-viewer')

const Chunk = require('prismarine-chunk')(VERSION)
const mcData = require('minecraft-data')(VERSION)

const planksId = mcData.blocksByName.oak_planks.defaultState
const grassId = mcData.blocksByName.grass_block.defaultState

function makeChunk (cx, cz) {
  const chunk = new Chunk()
  for (let x = 0; x < 16; x++) {
    for (let z = 0; z < 16; z++) {
      chunk.setBlockStateId(new Vec3(x, 60, z), grassId)
      // planks backdrop wall along world z=-4, 5 tall
      const wz = cz * 16 + z
      if (wz === -4) {
        for (let y = 61; y <= 65; y++) chunk.setBlockStateId(new Vec3(x, y, z), planksId)
      }
      chunk.setSkyLight(new Vec3(x, 61, z), 15)
    }
  }
  // block-entity stand-in check row (world x 2..12 at z 2, chunk 0,0)
  if (cx === 0 && cz === 0) {
    const put = (n, x, y, z) => { const b = mcData.blocksByName[n]; if (b) chunk.setBlockStateId(new Vec3(x, y, z), b.defaultState) }
    put('chest', 2, 61, 2)
    put('trapped_chest', 4, 61, 2)
    put('ender_chest', 6, 61, 2)
    put('white_banner', 8, 61, 2)
    put('gray_wall_banner', 10, 61, 2)
    put('short_grass', 12, 61, 2)
  }
  return chunk
}

const express = require('express')
const app = express()
const http = require('http').createServer(app)
const io = require('socket.io')(http)
app.use(express.static(path.join(VIEWER, 'public')))

const center = new Vec3(0, 61, 8)
const viewDistance = 2

// the standard cast: [name, width, height] — width/height only matter for the fallback box
let cast = [
  ['allay', 0.35, 0.6],
  ['vex', 0.4, 0.8],
  ['vindicator', 0.6, 1.95],
  ['evoker', 0.6, 1.95],
  ['pillager', 0.6, 1.95],
  ['warden', 0.9, 2.9],
  ['sheep', 0.9, 1.3],
  ['cow', 0.9, 1.4],
  ['chicken', 0.4, 0.7],
  ['wolf', 0.6, 0.85],
  ['frog', 0.5, 0.5],
  ['glow_squid', 0.8, 0.8],
  ['armadillo', 0.7, 0.65],
  ['camel', 1.7, 2.375],
  ['sniffer', 1.9, 1.75],
  ['breeze', 0.6, 1.77],
  ['item', 0.25, 0.25], // stays fallback — should be the neutral box, not magenta
  ['creeper', 0.6, 1.7],
  ['zombie', 0.6, 1.95],
  ['villager', 0.6, 1.95],
  ['iron_golem', 1.4, 2.7],
  ['horse', 1.4, 1.6]
]

const FULL = process.argv.includes('--full')
const rowsArg = (process.argv.find(a => a.startsWith('--rows=')) || '').replace('--rows=', '')
const onlyArg = (process.argv.find(a => a.startsWith('--only=')) || '').replace('--only=', '')
if (onlyArg) cast = onlyArg.split(',').map(n => [n, 0.6, 1.8])
let perRow = 8; let spacing = [4, 5]
if (FULL) {
  const registry = require(path.join(VIEWER, 'viewer', 'lib', 'entity', 'entities.json'))
  cast = Object.keys(registry).sort().map(n => [n, 0.6, 1.8])
  cast.push(['definitely_unknown', 0.25, 0.25]) // fallback-box check rides along
  perRow = 12; spacing = [6, 7]
  if (rowsArg) {
    const [a, b] = rowsArg.split('-').map(Number)
    cast = cast.slice(a * perRow, (b + 1) * perRow)
  }
  console.log('FULL sweep, grid order:')
  cast.forEach(([n], i) => { if (i % perRow === 0) console.log('  row ' + Math.floor(i / perRow) + ': ' + cast.slice(i, i + perRow).map(c => c[0]).join(', ')) })
}

io.on('connection', (socket) => {
  console.log('viewer connected')
  socket.emit('version', VERSION)
  for (let cx = -viewDistance; cx <= viewDistance; cx++) {
    for (let cz = -viewDistance; cz <= viewDistance; cz++) {
      socket.emit('loadChunk', { x: cx * 16, z: cz * 16, chunk: makeChunk(cx, cz).toJson() })
    }
  }
  const rows = Math.ceil(cast.length / perRow)
  let camCenter = FULL ? new Vec3(0, 61 + rows * 2, rows * spacing[1] + 6) : center
  if (onlyArg) camCenter = new Vec3((cast.length - 1) * 2 - (perRow / 2) * spacing[0] + 2 + 1, 56, -12) // cam lands at y+20,z+20 → eye-ish level looking at the line
  socket.emit('position', { pos: camCenter, addMesh: false })
  // line the cast up in front of the wall, facing the camera
  cast.forEach(([name, width, height], i) => {
    const x = onlyArg ? i * 2 - (perRow / 2) * spacing[0] + 2 : (i % perRow) * spacing[0] - (perRow / 2) * spacing[0] + 2
    const z = Math.floor(i / (onlyArg ? cast.length : perRow)) * spacing[1] - 1
    socket.emit('entity', { id: 1000 + i, name, pos: new Vec3(x, 61, z), width, height })
  })
})

http.listen(PORT, () => console.log(`QA harness on http://localhost:${PORT} — version ${VERSION}, ${cast.length} cast members`))
