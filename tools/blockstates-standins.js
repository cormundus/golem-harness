#!/usr/bin/env node
// Block-entity stand-ins for prismarine-viewer's runtime blocksStates (2026-07-20).
//
// Chests and banners are block ENTITIES — their models live outside blockstate JSON, so the
// viewer ships them as empty models (elements: []) and they render invisible. Mansion loot
// rooms need visible chests. This script writes simple cube/panel stand-ins into
// public/blocksStates/1.21.11.json, borrowing atlas texture refs from donor blocks
// (chest → oak_planks, ender_chest → obsidian, banners → their wool color).
//
// blocksStates is RUNTIME-FETCHED by the browser — no webpack rebuild needed. But npm
// reinstall wipes it: the file is part of the viewer backup mirror (install-viewer.sh).
// Idempotent: overwrites exactly the keys it owns, tagged _standin.
//
// Usage: node tools/blockstates-standins.js [path-to-blocksStates.json]

const fs = require('fs')
const path = require('path')

const target = process.argv[2] ||
  path.join(__dirname, '..', 'node_modules', 'prismarine-viewer', 'public', 'blocksStates', '1.21.11.json')

const bs = JSON.parse(fs.readFileSync(target, 'utf8'))

function faceTextures (donorName) { // per-face texture refs from a donor full-cube block
  const el = bs[donorName]?.variants?.['']?.model?.elements?.[0]
  if (!el) throw new Error('donor block missing or empty: ' + donorName)
  const out = {}
  for (const [face, spec] of Object.entries(el.faces)) out[face] = spec.texture
  return out
}

function boxModel (donorName, from, to) {
  const tex = faceTextures(donorName)
  const faces = {}
  for (const face of ['down', 'up', 'north', 'south', 'west', 'east']) {
    faces[face] = { texture: tex[face] } // no cullface: shrunken box must render beside solids
  }
  const particle = bs[donorName].variants[''].model.textures?.particle || tex.up
  return { variants: { '': { model: { textures: { particle }, elements: [{ from, to, faces }], ao: true, _standin: true } } } }
}

const written = []
function put (name, model) {
  if (!(name in bs)) return // only stand-in for states this version actually has
  bs[name] = model
  written.push(name)
}

// chests: 14/16-high wooden box, ender chest in obsidian
put('chest', boxModel('oak_planks', [1, 0, 1], [15, 14, 15]))
put('trapped_chest', boxModel('oak_planks', [1, 0, 1], [15, 14, 15]))
put('ender_chest', boxModel('obsidian', [1, 0, 1], [15, 14, 15]))

// banners: thin wool-colored panel (standing: centered; wall: against north face)
const COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
  'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
for (const c of COLORS) {
  try {
    put(c + '_banner', boxModel(c + '_wool', [6.5, 0, 7], [9.5, 16, 9]))
    put(c + '_wall_banner', boxModel(c + '_wool', [1, 0, 14], [15, 13, 15.5]))
  } catch (e) { console.log('skip ' + c + ': ' + e.message) }
}

fs.writeFileSync(target, JSON.stringify(bs))
console.log('stand-ins written into ' + target + ': ' + written.length + ' states')
console.log(written.join(', '))
