// Headless screenshot of a qa-harness page (same swiftshader recipe as bot.js /snapshot).
//   node tools/viewer-qa/qa-snap.js [url] [outfile] [settleMs]
const path = require('path')
const puppeteer = require('puppeteer-core')
const fs = require('fs')

const url = process.argv[2] || 'http://localhost:3005'
const out = process.argv[3] || path.join(__dirname, 'qa-snap.png')
const settle = parseInt(process.argv[4] || '9000', 10)

;(async () => {
  const exe = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  ].find(p => fs.existsSync(p))
  if (!exe) throw new Error('no Chrome/Edge found')
  const browser = await puppeteer.launch({
    executablePath: exe, headless: 'new',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox', '--disable-dev-shm-usage']
  })
  const page = await browser.newPage()
  page.on('console', async m => {
    const t = m.text()
    if (!/Unknown entity|Error|error/.test(t)) return
    const parts = []
    for (const a of m.args()) { try { parts.push(await a.evaluate(x => (x && x.stack) ? String(x.message || x).slice(0, 200) : String(x).slice(0, 200))) } catch (e) { parts.push('?') } }
    console.log('[page]', (parts.join(' ') || t).split('\n')[0])
  })
  await page.setViewport({ width: 1280, height: 720 })
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 })
  await new Promise(r => setTimeout(r, settle))
  await page.screenshot({ path: out })
  await browser.close()
  console.log('saved', out)
})().catch(e => { console.error(e); process.exit(1) })
