import assert from 'node:assert/strict'
import { subtitleDelayWithLatency, subtitleMediaTime } from './subtitleSync.js'

assert.equal(subtitleDelayWithLatency(0.5, 120, true), 0.62)
assert.equal(subtitleDelayWithLatency(0.5, 120, false), 0.5)
assert.equal(subtitleDelayWithLatency(0.5, -20, true), 0.5)
assert.equal(subtitleMediaTime(10, 0.5, 120, true), 9.38)
assert.equal(subtitleMediaTime(0, 0, 120, true), -0.12)
console.log('subtitle sync ok')
