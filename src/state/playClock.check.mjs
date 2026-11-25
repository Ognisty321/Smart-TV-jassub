import assert from 'node:assert/strict'
import { createPlayClock } from './playClock.js'

let now = 0
const clock = createPlayClock(() => now)
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`)

// Media runs from 100 s at wall 0. Reports come every 500 ms, each 0 to 120 ms stale.
const truth = () => 100 + now / 1000
const lags = [120, 60, 0, 90, 30, 110, 5, 70]
let worst = 0
for (let i = 0; i < 40; i++) {
  now = i * 500
  clock.sample(truth() - lags[i % lags.length] / 1000)
  for (let step = 0; step < 500; step += 20) {
    now = i * 500 + step
    const err = truth() - clock.read()
    if (i >= 3) worst = Math.max(worst, Math.abs(err))
    assert.ok(err > -0.001, 'the clock never runs ahead of the stream')
  }
}
assert.ok(worst < 0.01, `between reports the clock stays within 10 ms, got ${worst}`)

// Paused: the clock holds, and a resume starts from where it held.
const heldAt = clock.read(false)
now += 5000
assert.equal(clock.read(false), heldAt)
assert.equal(clock.read(), heldAt, 'nothing moves before the first report after a pause')
clock.sample(heldAt + 0.01)
now += 100
near(clock.read(), heldAt + 0.11, 0.001, 'runs again from the report')

// A report slightly behind what was shown does not step the subtitles back.
clock.reset()
const shown = clock.read()
clock.sample(shown - 0.05)
assert.equal(clock.read(), shown)

// A seek lands on the target, in either direction.
clock.reset(20)
assert.equal(clock.read(), 20)
clock.sample(20.2)
near(clock.read(), 20.2, 0.001, 'forward after seek')
clock.sample(900)
near(clock.read(), 900, 0.001, 'an unannounced jump is followed')
clock.sample(30)
near(clock.read(), 30, 0.001, 'and so is one back')

// A stream that stops reporting stops the clock.
now += 10000
near(clock.read(), 31.5, 0.001, 'coasts no further than the limit')

console.log('playClock: ok')
