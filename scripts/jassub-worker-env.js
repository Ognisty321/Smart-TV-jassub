// Runs before the bundled renderer modules. Chrome before 90 accepts desynchronized on a
// transferred OffscreenCanvas but presents nothing, so only newer engines may use the hint.
const ua = navigator.userAgent || ''
const chrome = ua.match(/(?:Chrome|Chromium)\/(\d+)/i)
const tizen = /tizen/i.test(ua) && ua.match(/\(KHTML, like Gecko\)\s+(\d+)(?:\.\d+){2,4}\/[\d.]+\s+TV\b/i)
const major = Number((chrome || tizen || [])[1] || 0)
self.jassubDesynchronized = !major || major >= 90

// Chromium's file:// implementation cannot fetch package files, while XHR can. TV apps commonly
// run from file://, so local non-http assets need this small transport bridge. blob/data/http(s)
// keep the native path untouched. Vega marks its shimmed worker fetch, which already answers packaged files.
const nativeFetch = self.fetch && self.fetch.bind(self)
const absoluteUrl = (input) => {
  const raw = typeof input === 'string' ? input : input && input.url
  try { return new URL(raw, self.location.href).href } catch (err) { return String(raw || '') }
}
self.fetch = (input, init) => {
  const url = absoluteUrl(input)
  if (nativeFetch && (self.__moonfinVegaWorker || /^(?:https?|blob|data):/i.test(url))) return nativeFetch(input, init)
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open((init && init.method) || 'GET', url, true)
    xhr.responseType = 'arraybuffer'
    xhr.onload = () => resolve(new Response(xhr.response, {
      status: 200,
      headers: { 'Content-Type': /\.wasm(?:[?#]|$)/i.test(url) ? 'application/wasm' : 'application/octet-stream' },
    }))
    xhr.onerror = () => reject(new TypeError(`Failed to fetch ${url}`))
    xhr.send((init && init.body) || null)
  })
}

// instantiateStreaming requires an application/wasm response. Some embedded hosts and file://
// bridges cannot provide that, so compile from bytes whenever streaming is unavailable or rejected.
self.jassubInstantiate = (imports) => {
  const bytes = () => self.fetch(self.location.href)
    .then((response) => response.arrayBuffer())
    .then((buffer) => WebAssembly.instantiate(buffer, imports))
  if (!WebAssembly.instantiateStreaming) return bytes()
  try {
    return WebAssembly.instantiateStreaming(self.fetch(self.location.href), imports).catch(bytes)
  } catch (err) {
    return bytes()
  }
}

// Chromium 85-93 can report a working WebGL2 context on TV/embedded GL backends yet present
// nothing. WebGL1 is nearly as fast in Jassub and was validated on that floor, so use it there.
if (major && major < 94 && self.OffscreenCanvas) {
  const getContext = self.OffscreenCanvas.prototype.getContext
  self.OffscreenCanvas.prototype.getContext = function (type, ...args) {
    if (type === 'webgl2') return null
    return getContext.call(this, type, ...args)
  }
}
