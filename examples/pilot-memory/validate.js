#!/usr/bin/env node
// validate.js — the memory graph's /waypoints: renders GRAPH.md FROM the nodes' own frontmatter
// (the map is generated from the territory, never hand-drawn) and enforces the graph's laws:
//   1. every node parses (frontmatter with name + description)
//   2. node names are unique
//   3. every [[wikilink]] resolves to a node name
//   4. _CORE.md stays under its token cap (it is the always-load tier)
//   5. state nodes carry an `updated:` stamp and are flagged when stale (>7 days) — a WARNING
//      here (the example's dates are deliberately old so you can see the check fire); the first
//      crew runs it as a hard failure, which is the right severity once the graph is live.
// Exit 0 = graph sound. Exit 1 = violations (printed). Run at every session wrap.
'use strict'
const fs = require('fs')
const path = require('path')

const ROOT = __dirname
const CORE_TOKEN_CAP = 2800            // ~4 chars/token heuristic on the cap check below
const STATE_STALE_DAYS = 7

function walk (dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (e.name.endsWith('.md') && e.name !== 'GRAPH.md' && e.name !== 'README.md') out.push(p)
  }
  return out
}

// tier comes from the PATH, not frontmatter: some memory harnesses normalize frontmatter on
// write (the first crew's stamped over their taxonomy — discovered on this validator's first
// run), and a directory cannot be normalized away. Frontmatter `tier:` is an explicit override.
function tierOf (file, fm) {
  if (fm.tier) return fm.tier
  const rel = path.relative(ROOT, file).replace(/\\/g, '/')
  if (rel === '_CORE.md') return 'core'
  if (rel.startsWith('state/')) return 'state'
  if (rel.startsWith('gotchas/')) return 'gotcha'
  if (rel.startsWith('episodes/')) return 'episode'
  if (rel.startsWith('archive')) return 'archive'
  return 'unfiled'
}

function parseNode (file) {
  const raw = fs.readFileSync(file, 'utf8')
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return { file, error: 'no frontmatter block' }
  const fm = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^\s*([A-Za-z_]+):\s*(.*)$/)
    if (kv) fm[kv[1]] = kv[2].replace(/^"|"$/g, '')
  }
  const body = raw.slice(m[0].length)
  const links = [...body.matchAll(/\[\[([a-z0-9-]+)\]\]/gi)].map(x => x[1])
  return { file, name: fm.name, description: fm.description, nodeType: tierOf(file, fm), updated: fm.updated, links, chars: raw.length }
}

// the wider memory constellation: if this graph lives inside a larger memory directory, nodes
// may legitimately link to memories OUTSIDE it. Index the parent dir's names so those resolve.
function outerNames () {
  const names = new Set()
  try {
    const parent = path.dirname(ROOT)
    for (const e of fs.readdirSync(parent, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue
      const head = fs.readFileSync(path.join(parent, e.name), 'utf8').slice(0, 400)
      const nm = head.match(/^name:\s*(.+)$/m)
      if (nm) names.add(nm[1].trim())
    }
  } catch (err) {}
  return names
}

const problems = []
const warnings = []
const nodes = walk(ROOT).map(parseNode)

// law 1+2: parse + unique names
const byName = new Map()
for (const n of nodes) {
  if (n.error) { problems.push(`${path.relative(ROOT, n.file)}: ${n.error}`); continue }
  if (!n.name || !n.description) problems.push(`${path.relative(ROOT, n.file)}: frontmatter missing name/description`)
  if (n.name) {
    if (byName.has(n.name)) problems.push(`duplicate node name '${n.name}' (${path.relative(ROOT, n.file)} vs ${path.relative(ROOT, byName.get(n.name).file)})`)
    else byName.set(n.name, n)
  }
}

// law 3: links resolve — within the graph OR to the wider memory constellation
const outer = outerNames()
for (const n of nodes) {
  for (const l of n.links || []) {
    if (!byName.has(l) && !outer.has(l)) problems.push(`${n.name || path.relative(ROOT, n.file)}: dangling link [[${l}]]`)
  }
}

// law 4: _CORE token cap
const core = nodes.find(n => n.nodeType === 'core')
if (!core) problems.push('no core node found (_CORE.md at the graph root)')
else {
  const tokens = Math.round(core.chars / 4)
  if (tokens > CORE_TOKEN_CAP) problems.push(`_CORE.md ≈${tokens} tokens > cap ${CORE_TOKEN_CAP} — demote something to state/gotchas/episodes`)
}

// law 5: state freshness
const now = Date.now()
for (const n of nodes) {
  if (n.nodeType !== 'state') continue
  if (!n.updated) { problems.push(`state node '${n.name}' has no updated: stamp`); continue }
  const age = (now - new Date(n.updated).getTime()) / 86400000
  if (age > STATE_STALE_DAYS) warnings.push(`state node '${n.name}' is ${Math.floor(age)} days stale — verify or update`)
}

// render GRAPH.md — the generated index
const order = ['core', 'state', 'gotcha', 'episode', 'archive', 'unfiled']
const lines = ['# GRAPH.md — generated by validate.js. DO NOT EDIT (edit the nodes).', '']
for (const t of order) {
  const group = nodes.filter(n => n.nodeType === t).sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  if (!group.length) continue
  lines.push(`## ${t}`)
  for (const n of group) {
    const rel = path.relative(ROOT, n.file).replace(/\\/g, '/')
    const edges = (n.links || []).length ? `  →  ${[...new Set(n.links)].map(l => `[[${l}]]`).join(' ')}` : ''
    lines.push(`- **${n.name}** (${rel}, ≈${Math.round(n.chars / 4)}tok) — ${n.description}${edges}`)
  }
  lines.push('')
}
fs.writeFileSync(path.join(ROOT, 'GRAPH.md'), lines.join('\n'))

const tokTotal = Math.round(nodes.reduce((s, n) => s + (n.chars || 0), 0) / 4)
console.log(`graph: ${nodes.length} nodes, ≈${tokTotal} tokens on disk; always-load ≈${Math.round(((core ? core.chars : 0) + nodes.filter(n => n.nodeType === 'state').reduce((s, n) => s + n.chars, 0)) / 4)} tokens (core+state)`)
for (const w of warnings) console.log('  ⚠ ' + w)
if (problems.length) {
  console.log(`\n${problems.length} problem(s):`)
  for (const p of problems) console.log('  ✗ ' + p)
  process.exit(1)
}
console.log('graph sound ✓ (GRAPH.md regenerated)')
