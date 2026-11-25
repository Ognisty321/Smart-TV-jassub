// Browser stress benchmark for the Jassub ASS integration.
//   node tools/jassub-bench.mjs [--throttle 6] [--frames 40] [--scenario anime]
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 ? process.argv[at + 1] : fallback
}
const throttle = Number(arg('throttle', '1'))
const frames = Number(arg('frames', '40'))
const selected = arg('scenario', '')
const scenarios = selected ? selected.split(',') : ['static', 'karaoke', 'blur', 'vector', 'signs', 'anime', 'extreme']
const renderScale = arg('renderScale', '1')
const adaptive = arg('adaptive', '0')
const normalWasm = arg('normalWasm', '0')
const storageW = arg('storageW', '')
const storageH = arg('storageH', '')
const keep = arg('keep', '0')
const page = arg('page', 'jassub-bench.html')
const shots = arg('shots', '')
const sizes = arg('sizes', '1920x1080').split(',').map((size) => size.split('x').map(Number))
const chrome = process.env.CHROME || '/home/ubuntu/.local/bin/google-chrome'
const cpus = arg('cpus', '')
const userAgent = arg('ua', '')
const port = 5174 + Math.floor(Math.random() * 100)
const debugPort = 9300 + Math.floor(Math.random() * 200)
const profile = mkdtempSync(join(tmpdir(), 'jassub-bench-chrome-'))

const lifecyclePlaybackMock = {
  name: 'moonfin:lifecycle-playback-mock',
  enforce: 'pre',
  resolveId(id, importer) {
    if (importer?.endsWith('bitmapSubs.js') && id === '../../services/playback.js') return '\0lifecycle-playback'
  },
  load(id) {
    if (id !== '\0lifecycle-playback') return
    return `export const getAssSubtitleUrl = (stream) => stream.url
export const getAssFontsUrl = () => []
export const getVideoStorageSize = () => ({ width: 1920, height: 1080 })
export const getVideoColorSpace = () => null
`
  },
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (!process.env.CORRUPT_JASSUB || !req.url?.startsWith('/jassub-worker.js')) return next()
      res.setHeader('Content-Type', 'text/html')
      res.end('<html>not a worker</html>')
    })
  },
}
const server = await createServer({
  logLevel: 'silent',
  server: { host: '127.0.0.1', port },
  plugins: page === 'bitmapSubs-lifecycle.html' ? [lifecyclePlaybackMock] : [],
})
await server.listen()
const chromeArgs = [
  '--headless=new', '--no-sandbox', '--mute-audio', `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profile}`, '--window-size=1920,1080', 'about:blank',
]
const browser = cpus
  ? spawn('/usr/bin/taskset', ['-c', cpus, chrome, ...chromeArgs], { stdio: 'ignore' })
  : spawn(chrome, chromeArgs, { stdio: 'ignore' })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const connect = async () => {
  for (let i = 0; i < 50; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
        let id = 0
        const pending = new Map()
        ws.onmessage = (message) => {
          const data = JSON.parse(message.data)
          if (data.id && pending.has(data.id)) {
            pending.get(data.id)(data)
            pending.delete(data.id)
          } else if (data.method === 'Runtime.consoleAPICalled') {
            consoleEvents.push(`${data.params.type}: ${data.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ')}`.slice(0, 500))
          } else if (data.method === 'Log.entryAdded') {
            consoleEvents.push(`${data.params.entry.level}: ${data.params.entry.text}`.slice(0, 500))
          }
        }
        const send = (method, params = {}) => new Promise((resolve, reject) => {
          const n = ++id
          pending.set(n, (data) => data.error ? reject(new Error(JSON.stringify(data.error))) : resolve(data.result))
          ws.send(JSON.stringify({ id: n, method, params }))
        })
        return { ws, send }
      }
    } catch {}
    await sleep(200)
  }
  throw new Error('Chrome did not expose a page over CDP')
}

const results = []
const consoleEvents = []
let client
try {
  client = await connect()
  const { send } = client
  if (throttle > 1) await send('Emulation.setCPUThrottlingRate', { rate: throttle })
  if (userAgent) await send('Network.setUserAgentOverride', { userAgent })
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Log.enable').catch(() => {})
  await send('Performance.enable').catch(() => {})
  for (const [width, height] of sizes) {
    for (const scenario of scenarios) {
      consoleEvents.length = 0
      const url = `http://127.0.0.1:${port}/tools/${page}?scenario=${scenario}&width=${width}&height=${height}&frames=${frames}&renderScale=${renderScale}&adaptive=${adaptive}&normalWasm=${normalWasm}&storageW=${storageW}&storageH=${storageH}&keep=${keep}`
      await send('Page.navigate', { url })
      for (let i = 0; i < 100; i++) {
        const phase = await send('Runtime.evaluate', { expression: 'window.__phase', returnByValue: true }).catch(() => null)
        if (phase?.result?.value === 'loaded') break
        await sleep(100)
      }
      let done = false
      const evaluationPromise = send('Runtime.evaluate', {
        expression: page === 'bitmapSubs-lifecycle.html' ? 'window.__runLifecycle()' : 'window.__runBench()',
        awaitPromise: true,
        returnByValue: true,
        timeout: 120000,
      }).finally(() => { done = true })
      const memory = []
      while (!done) {
        const metrics = await send('Performance.getMetrics').catch(() => null)
        if (metrics?.metrics) {
          const values = Object.fromEntries(metrics.metrics.map((metric) => [metric.name, metric.value]))
          memory.push({
            jsHeap: Math.round((values.JSHeapUsedSize || 0) / 1048576),
            documents: values.Documents,
            nodes: values.Nodes,
            workers: values.Workers,
          })
        }
        await sleep(500)
      }
      const evaluation = await evaluationPromise
      if (evaluation.exceptionDetails) throw new Error(JSON.stringify(evaluation.exceptionDetails))
      results.push({ throttle, memory, console: consoleEvents.slice(), ...evaluation.result.value })
      if (shots && keep === '1') {
        const pageShot = await send('Page.captureScreenshot', { format: 'png' }).catch(() => null)
        if (pageShot?.data) {
          mkdirSync(shots, { recursive: true })
          writeFileSync(join(shots, `${scenario}-${width}x${height}-page.png`), Buffer.from(pageShot.data, 'base64'))
        }
      }
      if (shots) {
        const shot = await send('Runtime.evaluate', { expression: 'window.__scenarioShot', returnByValue: true })
        const dataUrl = shot?.result?.value
        if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/png;base64,')) {
          mkdirSync(shots, { recursive: true })
          writeFileSync(join(shots, `${scenario}-${width}x${height}.png`), Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64'))
        }
      }
      console.error(`done ${scenario} ${width}x${height}`)
    }
  }
} finally {
  client?.ws.close()
  browser.kill('SIGKILL')
  await server.close()
  rmSync(profile, { recursive: true, force: true })
}

console.log(JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2))
