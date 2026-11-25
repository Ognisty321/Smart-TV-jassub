// The generated worker bootstrap is itself code inside a string, so node --check of the outer
// shim cannot see it. Evaluate the shim with just enough browser surface to capture and parse it.
//   node vega/worker-shim.check.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const code = fs.readFileSync(new URL('./inject/worker-shim.js', import.meta.url), 'utf8')
let blobText = ''
class FakeBlob {
  constructor(parts) {
    blobText = parts.join('')
  }
}
class FakeWorker {}

const context = {
  console,
  location: { protocol: 'file:' },
  navigator: { userAgent: '' },
  document: { createElement: () => ({}), head: { appendChild: () => {} } },
  URL: { createObjectURL: () => 'blob:worker-shim-test' },
  Blob: FakeBlob,
  TextDecoder,
  Uint8Array,
  Promise,
  Error,
  ErrorEvent,
  MessageEvent,
  XMLHttpRequest: function XMLHttpRequest() {},
  Worker: FakeWorker,
  atob: (value) => Buffer.from(value, 'base64').toString('binary'),
}
context.window = context
context.self = context
context.globalThis = context

vm.runInNewContext(code, context)
assert.ok(blobText.length > 1000, 'bootstrap captured')
new vm.Script(blobText)
assert.match(blobText, /self\.__moonfinVegaWorker = true/)
assert.match(blobText, /self\.fetch = function/)
assert.match(blobText, /XMLHttpRequest\.prototype\.open/)
assert.equal(typeof context.Worker, 'function', 'the shim replaces Worker on file://')
console.log('vega worker shim ok')
