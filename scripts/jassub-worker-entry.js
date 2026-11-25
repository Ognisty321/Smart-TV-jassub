// Bundled into one classic worker by scripts/subtitle-assets.mjs. The two emscripten glue modules
// sit in the same file, so the worker never needs a module import or a second script to start.
import './jassub-worker-env.js'
import normalGlue from 'jassub/dist/wasm/jassub-worker.js'
import 'jassub/dist/worker/worker.js'

self.jassubLoadWasmGlue = () => Promise.resolve({ default: normalGlue })
