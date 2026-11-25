// AVPlay reports its position in steps, each one delivered some time after the frame it names, so a
// subtitle drawn on those reports alone lands up to a whole step late. A report can be stale but never
// ahead, so the report furthest ahead of the wall clock is the closest to the truth: the clock keeps
// that offset and reads the position between reports from the wall clock.
const JUMP_S = 0.25
// The estimate gives way this much per second, so a slower media clock or a stall pulls it back.
const DRIFT = 0.002
// With no report for this long the stream is taken as stalled and the clock waits.
const COAST_S = 1.5

export const createPlayClock = (wall = () => performance.now()) => {
  let offset = null
  let sampledAt = 0
  let held = 0
  const seconds = () => wall() / 1000
  return {
    // A seek, a pause or a new stream: the next report starts the estimate over.
    reset(t) {
      offset = null
      if (t != null) held = t
    },
    sample(t) {
      const n = seconds()
      const o = t - n
      if (offset == null || Math.abs(o - offset) > JUMP_S) {
        offset = o
        if (Math.abs(t - held) > JUMP_S) held = t
      } else offset = Math.max(o, offset - DRIFT * (n - sampledAt))
      sampledAt = n
    },
    read(running = true) {
      if (!running) {
        offset = null
        return held
      }
      if (offset == null) return held
      const t = offset + Math.min(seconds(), sampledAt + COAST_S)
      if (t > held) held = t
      return held
    },
  }
}
