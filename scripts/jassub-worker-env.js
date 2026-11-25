// Runs before the bundled renderer modules. Chrome before 90 accepts desynchronized on a
// transferred OffscreenCanvas but presents nothing, so only newer engines may use the hint.
const ua = navigator.userAgent || ''
const chrome = ua.match(/(?:Chrome|Chromium)\/(\d+)/i)
const tizen = /tizen/i.test(ua) && ua.match(/\(KHTML, like Gecko\)\s+(\d+)(?:\.\d+){2,4}\/[\d.]+\s+TV\b/i)
const major = Number((chrome || tizen || [])[1] || 0)
self.jassubDesynchronized = !major || major >= 90
