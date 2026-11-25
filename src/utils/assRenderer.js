// ASS and SSA subtitles, primarily through Jassub (libass on WASM/WebGL), with the older
// SubtitlesOctopus engine left for TV browsers too old for Jassub's WASM build. The canvas is kept
// in step with the video through setAssTime/setIsPaused.

import {parseSubtitleText} from './subtitleText.js';
import {assetUrl} from './assetUrl.js';

// The octopus worker files use arrow functions (Chrome 45 and up) and `let` in sloppy mode
// (Chrome 49 and up), so support is gated on the Chrome version rather than on createImageBitmap.
const getChromiumMajorVersion = () => {
	const ua = navigator.userAgent || '';
	const match = ua.match(/(?:Chrome|Chromium)\/(\d+)/i);
	if (match) return parseInt(match[1], 10);
	// Tizen's app webview names the Chromium version as the application version:
	// "108.0.5359.1/8.0 TV" means Chromium 108 on Tizen 8.
	const tizen = /tizen/i.test(ua) && ua.match(/\(KHTML, like Gecko\)\s+(\d+)(?:\.\d+){2,4}\/[\d.]+\s+TV\b/i);
	return tizen ? parseInt(tizen[1], 10) : null;
};

const supportsOctopusRenderer = () => {
	const chromiumMajor = getChromiumMajorVersion();
	if (typeof Worker !== 'function') return false;
	if (typeof Promise === 'undefined') return false;
	if (typeof Uint8Array === 'undefined') return false;
	if (chromiumMajor && chromiumMajor < 49) return false;
	return true;
};

// Jassub's own floor is Chrome 85. The API checks keep embedded or future Chromium-like engines
// honest; a known Chrome/Tizen version below the floor stays on the compatibility engine, while an
// unknown embedded engine may still prove itself through the API checks and has a runtime fallback.
export const supportsJassubRenderer = () => {
	const chromiumMajor = getChromiumMajorVersion();
	if (chromiumMajor && chromiumMajor < 85) return false;
	if (typeof Worker !== 'function') return false;
	if (typeof WebAssembly !== 'object') return false;
	if (typeof Proxy !== 'function') return false;
	if (typeof ResizeObserver !== 'function') return false;
	if (typeof TextDecoder !== 'function') return false;
	if (typeof HTMLCanvasElement === 'undefined') return false;
	if (typeof HTMLCanvasElement.prototype.transferControlToOffscreen !== 'function') return false;
	if (typeof Atomics !== 'object') return false;
	try {
		// Both Jassub WASM builds are compiled for shared memory even when they use one thread.
		new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
	} catch (err) {
		return false;
	}
	return true;
};

export const supportsAssRenderer = () => supportsJassubRenderer() || supportsOctopusRenderer();

const supportsWasmBlend = () => {
	const chromiumMajor = getChromiumMajorVersion();
	if (chromiumMajor && chromiumMajor >= 57) return true;
	return false;
};

const ENGINE = 'subtitles-octopus-worker.js';
const LEGACY_ENGINE = 'subtitles-octopus-worker-legacy.js';
const WASM = 'subtitles-octopus-worker.wasm';
const FALLBACK_FONT = 'ass-fallback-font.ttf';
const JASSUB_WORKER = 'jassub-worker.js';
const JASSUB_WASM = 'jassub-worker.wasm';
// One merged Noto fallback covers Latin/Cyrillic/Greek plus Arabic, Hebrew, Thai and the
// symbols common in song/typeset lines. A single family is required because libass does not
// cascade across separately registered browser-side fonts when a glyph is missing.
const fullUrl = (path) => new URL(assetUrl(path), document.baseURI).href;
const fallbackFontUrls = () => [fullUrl(FALLBACK_FONT)];
const fallbackFontMap = () => ({ roboto: fullUrl(FALLBACK_FONT), 'noto sans': fullUrl(FALLBACK_FONT) });

// The octopus engine's files as the worker gets them. When an in-app update replaced any of them,
// the worker starts from a short script that names each file, since a worker started from a blob URL
// can't find its wasm and font beside itself. Otherwise it loads straight from the package.
let engineFiles = null;
export const engine = () => {
	if (engineFiles) return engineFiles;
	const updated = [ENGINE, LEGACY_ENGINE, WASM, FALLBACK_FONT].some((path) => assetUrl(path) !== path);
	const boot = (worker) => URL.createObjectURL(new Blob([
		`var Module={locateFile:function(p){return p===${JSON.stringify(WASM)}?${JSON.stringify(fullUrl(WASM))}:p}};importScripts(${JSON.stringify(fullUrl(worker))})`
	], {type: 'application/javascript'}));
	engineFiles = updated
		? {workerUrl: boot(ENGINE), legacyWorkerUrl: boot(LEGACY_ENGINE), fallbackFont: fullUrl(FALLBACK_FONT)}
		: {workerUrl: ENGINE, legacyWorkerUrl: LEGACY_ENGINE, fallbackFont: FALLBACK_FONT};
	return engineFiles;
};

// Jassub's worker is one classic bundle, so it never imports beside itself. The wasmWorkerUrl values
// only have to name the right glue to the loader inside that bundle; the fragment also makes the
// pthread entry distinct if a host ever runs the threaded WASM.
const jassubEngine = () => {
	const worker = fullUrl(JASSUB_WORKER);
	return {
		workerUrl: worker,
		wasmUrl: fullUrl(JASSUB_WASM),
		// The mimalloc build is only a few percent faster but uses about twice the WASM heap in
		// typesetting-heavy tracks. TVs are memory constrained, so every engine gets emmalloc.
		modernWasmUrl: fullUrl(JASSUB_WASM),
		wasmWorkerUrl: `${worker}#normal`,
		modernWasmWorkerUrl: `${worker}#normal`,
	};
};

const createOctopusRenderer = async (options, onError) => {
	try {
		const mod = await import('libass-wasm');
		const SubtitlesOctopus = mod.default || mod;
		const qualityOptions = supportsWasmBlend()
			? { targetFps: 24, renderMode: 'wasm-blend', prescaleFactor: 0.8, maxRenderHeight: 2160}
			: { targetFps: 10, renderMode: 'js-blend', prescaleFactor: 0.5, maxRenderHeight: 540};

		return new SubtitlesOctopus({
			...options,
			fonts: [...new Set([...(options.fonts || []), ...fallbackFontUrls()])],
			...engine(),
			onError: onError || null,
			...qualityOptions,
			debug: false
		});
	} catch (err) {
		console.error('[AssRenderer] Failed to initialize:', err);
		return null;
	}
};

// Heavy typesetting is rasterized in one worker thread. These steps trade sharpness for frame time
// only after several slow frames, then recover after a sustained quiet period.
const JASSUB_QUALITY_LEVELS = [1, 0.8, 0.65, 0.5];
const JASSUB_FRAME_INTERVAL_MS = 1000 / 24;
const JASSUB_SLOW_FRAME_MS = JASSUB_FRAME_INTERVAL_MS * 0.8;
const JASSUB_FAST_FRAME_MS = JASSUB_FRAME_INTERVAL_MS * 0.3;
const JASSUB_VERY_SLOW_FRAME_MS = 100;
const JASSUB_CRITICAL_FRAME_MS = 250;

// Jassub has no clock of its own in canvas-only use. This facade follows the same contract as
// SubtitlesOctopus: ticks are absolute corrections, while playing time advances between them so
// animated typesetting keeps moving. Most frames come back unchanged from libass and cost little.
class JassubCanvasRenderer {
	constructor(instance, onError, storageSize = null, colorSpace = null) {
		this.instance = instance;
		this.ready = instance.ready;
		this.width = instance._canvas.width || 1920;
		this.height = instance._canvas.height || 1080;
		// Canvas-only use has no video element whose size manualRender can follow. Pin those
		// internals here and in resize() so a render never replaces Moonfin's exact picture-rect
		// size with a guessed letterboxed size.
		instance._videoWidth = this.width;
		instance._videoHeight = this.height;
		// Moonfin owns this canvas's geometry. Jassub's element observer can already have a
		// callback queued before disconnecting it, so automatic resizing is disabled outright;
		// canvas-only rendering never needs its letterbox guessing.
		instance._ro.disconnect();
		instance.resize = async () => {};
		this.time = 0;
		this.clockTime = 0;
		this.clockAt = 0;
		this.paused = true;
		this.timer = null;
		this.failed = false;
		this.destroyed = false;
		this.storageWidth = storageSize?.width || 0;
		this.storageHeight = storageSize?.height || 0;
		this.qualityLevel = 0;
		this.frameCosts = [];
		this.fastDraws = 0;
		this.qualityChangedAt = 0;
		this.renderBusy = false;
		this.renderSkipped = false;
		this.renderSamples = [];
		this.warmupDraws = 2;
		this.renderVerified = false;
		this.resizeWrite = Promise.resolve();
		this.trackWrite = Promise.resolve();
		this.onError = onError;
		this.readySettled = false;
		if (colorSpace?.matrix) {
			instance.ready.then(() => {
				if (!this.destroyed && !this.failed) return instance.renderer._setColorSpace(colorSpace.matrix, !!colorSpace.fullRange);
			}).catch((err) => this.fail(err));
		}
		this.readyTimeout = setTimeout(() => {
			if (!this.readySettled) this.fail(new Error('Jassub worker did not become ready'));
		}, 8000);
		this.workerError = (event) => {
			this.fail(new Error(event.message || 'Jassub worker stopped'));
		};
		if (instance._worker) {
			instance._worker.addEventListener('error', this.workerError);
			instance._worker.addEventListener('messageerror', this.workerError);
		}
		instance.ready.then(() => {
			this.readySettled = true;
			clearTimeout(this.readyTimeout);
		}, (err) => {
			this.readySettled = true;
			clearTimeout(this.readyTimeout);
			this.fail(err);
		});
	}

	fail(err) {
		if (this.failed || this.destroyed) return;
		this.failed = true;
		this.stopClock();
		console.error('[AssRenderer] Jassub failed:', err);
		if (this.onError) this.onError(err);
	}

	now() {
		if (this.paused) return this.clockTime;
		return this.clockTime + Math.max(0, ((performance.now() || Date.now()) - this.clockAt) / 1000);
	}

	anchor(seconds) {
		this.clockTime = Number(seconds) || 0;
		this.clockAt = performance.now() || Date.now();
	}

	render(repaint = false) {
		if (this.destroyed || this.failed) return Promise.resolve(false);
		if (this.renderBusy) {
			this.renderSkipped = true;
			this.noteRenderSample(true);
			return Promise.resolve(false);
		}
		this.renderBusy = true;
		this.noteRenderSample(false);
		const started = performance.now() || Date.now();
		return this.instance.ready.then(() => {
			if (this.destroyed || this.failed) return;
			if (this.renderVerified) return this.instance.renderer._draw(this.now(), repaint);
			return this.instance.renderer._drawVerify(this.now(), repaint).then((result) => {
				// No images is a legitimate gap or an unchanged frame. Once libass does emit images,
				// at least one pixel must survive the GPU canvas path; alpha -1 means this browser
				// cannot read the canvas back, so that browser simply stays unverified.
				if (result && result.images > 0) {
					if (result.alpha === 0) throw new Error('Jassub rendered no pixels');
					if (result.alpha > 0) this.renderVerified = true;
				}
			});
		}).then(() => {
			this.adaptQuality((performance.now() || Date.now()) - started);
		}).catch((err) => this.fail(err)).finally(() => {
			this.renderBusy = false;
			if (this.renderSkipped) {
				this.renderSkipped = false;
				this.render(false);
			}
		});
	}

	noteRenderSample(skipped) {
		const now = performance.now() || Date.now();
		this.renderSamples.push({ at: now, skipped });
		while (this.renderSamples.length && now - this.renderSamples[0].at > 1000) this.renderSamples.shift();
		if (this.renderSamples.length >= 4 && this.renderSamples.filter((sample) => sample.skipped).length / this.renderSamples.length >= 0.5) {
			this.degradeQuality(now);
		}
	}

	degradeQuality(now, lowest = false) {
		if ((lowest || this.qualityLevel < JASSUB_QUALITY_LEVELS.length - 1) && now - this.qualityChangedAt > 300) {
			this.qualityLevel = lowest ? JASSUB_QUALITY_LEVELS.length - 1 : this.qualityLevel + 1;
			this.frameCosts = [];
			this.fastDraws = 0;
			this.renderSamples = [];
			this.qualityChangedAt = now;
			this.resize();
		}
	}

	adaptQuality(cost) {
		if (this.destroyed || this.failed) return;
		const now = performance.now() || Date.now();
		// The first draws after a track load include cold font/glyph caches. Sustained overload is
		// still caught by skipped renders, but those one-off cache misses must not lower sharpness.
		if (this.warmupDraws > 0) {
			this.warmupDraws -= 1;
			return;
		}
		if (cost >= JASSUB_CRITICAL_FRAME_MS) {
			this.degradeQuality(now, true);
			return;
		}
		if (cost >= JASSUB_VERY_SLOW_FRAME_MS) {
			this.degradeQuality(now);
			return;
		}
		if (cost >= 10) {
			this.frameCosts.push(cost);
			if (this.frameCosts.length > 5) this.frameCosts.shift();
		}
		if (cost <= JASSUB_FAST_FRAME_MS) this.fastDraws += 1;
		else this.fastDraws = 0;
		const slowFrames = this.frameCosts.filter((frameCost) => frameCost >= JASSUB_SLOW_FRAME_MS).length;
		if (this.frameCosts.length >= 3 && slowFrames >= 3) {
			this.degradeQuality(now);
		} else if (this.fastDraws >= 72 && this.qualityLevel > 0 && now - this.qualityChangedAt > 4000) {
			this.qualityLevel -= 1;
			this.frameCosts = [];
			this.fastDraws = 0;
			this.renderSamples = [];
			this.qualityChangedAt = now;
			this.resize();
		}
	}

	renderSize() {
		const scale = JASSUB_QUALITY_LEVELS[this.qualityLevel];
		return {
			width: Math.max(1, Math.round(this.width * scale)),
			height: Math.max(1, Math.round(this.height * scale)),
		};
	}

	startClock() {
		if (this.timer || this.destroyed) return;
		this.timer = setInterval(() => this.render(false), JASSUB_FRAME_INTERVAL_MS);
	}

	stopClock() {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	resize(width, height) {
		this.width = Math.max(1, Math.round(width || this.width));
		this.height = Math.max(1, Math.round(height || this.height));
		this.instance._videoWidth = this.width;
		this.instance._videoHeight = this.height;
		this.resizeWrite = this.resizeWrite
			.then(() => this.instance.ready)
			.then(() => {
				if (!this.destroyed) {
					const size = this.renderSize();
					return this.instance.renderer._resizeCanvas(size.width, size.height, this.storageWidth, this.storageHeight);
				}
			})
			.then(() => {
				if (!this.destroyed) this.render(true);
			})
			.catch((err) => this.fail(err));
		return this.resizeWrite;
	}

	setTrack(content) {
		this.warmupDraws = 2;
		this.trackWrite = this.trackWrite
			.then(() => this.instance.ready)
			.then(() => this.instance.renderer.setTrack(content))
			.then(() => this.render(true))
			.catch((err) => this.fail(err));
		return this.trackWrite;
	}

	setCurrentTime(seconds) {
		this.time = Number(seconds) || 0;
		const drift = Math.abs(this.time - this.now());
		// A small drift is taken up by the running clock without a redraw of its own.
		if (!this.paused && drift < 0.08) {
			if (drift > 0.015) this.anchor(this.time);
			return;
		}
		this.anchor(this.time);
		this.render(false);
	}

	setIsPaused(paused, seconds) {
		this.anchor(seconds);
		this.paused = !!paused;
		if (this.paused) this.stopClock();
		else this.startClock();
		this.render(true);
	}

	dispose() {
		if (this.destroyed) return;
		this.destroyed = true;
		this.stopClock();
		clearTimeout(this.readyTimeout);
		if (this.instance._worker) {
			this.instance._worker.removeEventListener('error', this.workerError);
			this.instance._worker.removeEventListener('messageerror', this.workerError);
			// JASSUB.destroy() awaits ready before terminating. A worker that never started would
			// otherwise leak forever, so the facade owns termination for both healthy and bad workers.
			this.instance._worker.terminate();
			return;
		}
		this.instance.destroy().catch(() => {});
	}
}

const createJassubRenderer = async (options, onError, storageSize, colorSpace) => {
	try {
		const mod = await import('jassub');
		const JASSUB = mod.default || mod;
		const instance = new JASSUB({
			...options,
			...jassubEngine(),
			// availableFonts only says where a font can be fetched after libass first misses it.
			// Put the fallbacks in fonts too, so the first frame already has glyphs instead of
			// rendering empty until a later animated frame happens to force a repaint.
			fonts: [...new Set([...(options.fonts || []), ...fallbackFontUrls()])],
			availableFonts: fallbackFontMap(),
			defaultFont: 'noto sans',
			queryFonts: false,
			// TV browsers rarely expose deviceMemory. Use upstream's low-memory tier: in the
			// extreme typesetting harness it keeps the emmalloc WASM heap near 67 MB instead of about 135 MB,
			// while producing the same pixels and broadly unchanged render times.
			libassMemoryLimit: 32,
			libassGlyphLimit: 1000,
			debug: false
		});
		// The facade handles this same rejection, but it is attached after constructor setup. Mark it
		// handled here too so a worker that cannot even parse does not become an unhandled rejection.
		instance.ready.catch(() => {});
		return new JassubCanvasRenderer(instance, onError, storageSize, colorSpace);
	} catch (err) {
		console.error('[AssRenderer] Failed to initialize Jassub:', err);
		return null;
	}
};

const createRenderer = async (options, onError, compatibility = false, storageSize = null, colorSpace = null) => {
	if (supportsJassubRenderer() && !compatibility) {
		const renderer = await createJassubRenderer(options, onError, storageSize, colorSpace);
		if (renderer) return renderer;
	}
	return createOctopusRenderer(options, onError);
};

// The script each renderer started from, so a size change can hand it over again and the offset
// timeline can list its lines.
const tracks = new WeakMap();
let fontScale = 1;

// Multiplies a script's style sizes and its \fs tags by scale, the way libass's font scale does.
// Outlines, shadows and positions stay as authored.
export const scaleAssFontSizes = (script, scale) => {
	if (!script || scale === 1 || !(scale > 0)) return script;
	const size = (value) => String(Math.round(parseFloat(value) * scale * 100) / 100);
	let column = 2;
	return script.replace(/^(Format|Style|Dialogue):(.*)$/gm, (line, kind, rest) => {
		if (kind === 'Format') {
			const at = rest.split(',').map((field) => field.trim().toLowerCase()).indexOf('fontsize');
			if (at >= 0) column = at;
			return line;
		}
		if (kind === 'Style') {
			const fields = rest.split(',');
			if (fields.length > column) fields[column] = fields[column].replace(/\d+(?:\.\d+)?/, size);
			return `Style:${fields.join(',')}`;
		}
		return line.replace(/\{[^}]*\}/g, (block) => block.replace(/\\fs(\d+(?:\.\d+)?)/g, (tag, value) => `\\fs${size(value)}`));
	});
};

// The subtitle size as a multiple of the default, which the next track starts at and the one on
// screen is drawn again at.
export const setAssFontScale = (renderer, scale) => {
	fontScale = scale;
	const track = tracks.get(renderer);
	if (!track || track.scale === scale || !renderer.setTrack) return;
	track.scale = scale;
	renderer.setTrack(scaleAssFontSizes(track.script, scale));
};

const fetchScript = async (url) => {
	try {
		const response = await window.fetch(url);
		return response.ok ? await response.text() : null;
	} catch (err) {
		return null;
	}
};

export const initAssCanvasRenderer = async (canvasElement, subtitleUrl, fontsUrl, onError, compatibility = false, storageSize = null, colorSpace = null) => {
	if (!canvasElement || !subtitleUrl) return null;
	canvasElement.width = window.innerWidth || canvasElement.clientWidth || 1920;
	canvasElement.height = window.innerHeight || canvasElement.clientHeight || 1080;
	// Read here rather than in the worker so it can be scaled and listed. If it can't be, the
	// worker fetches the URL itself.
	const script = await fetchScript(subtitleUrl);
	const scale = fontScale;
	const options = script === null
		? {canvas: canvasElement, subUrl: subtitleUrl, fonts: fontsUrl}
		: {canvas: canvasElement, subContent: scaleAssFontSizes(script, scale), fonts: fontsUrl};
	const renderer = await createRenderer(options, onError, compatibility, storageSize, colorSpace);
	if (renderer && script !== null) {
		tracks.set(renderer, {script, scale});
		// The size may have changed while the renderer was starting.
		setAssFontScale(renderer, fontScale);
	}
	return renderer;
};

// The track's lines as timed events for the subtitle offset timeline, read once per track.
export const assTimelineEvents = (renderer) => {
	const track = tracks.get(renderer);
	if (!track) return null;
	if (!track.events) track.events = parseSubtitleText(track.script);
	return track.events;
};

export const disposeAssRenderer = (renderer) => {
	if (renderer?.dispose) {
		try {
			renderer.dispose();
		} catch (err) {
			console.warn('[AssRenderer] Error disposing', err);
		}
	}
};

export const setAssTime = (renderer, currentTimeSeconds) => {
	if (renderer?.setCurrentTime) {
		renderer.setCurrentTime(Number(currentTimeSeconds) || 0);
	}
};

export const clearAssCanvas = (canvas) => {
	if (!canvas) return;
	try {
		const ctx = canvas.getContext('2d');
		if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
	} catch (err) {
		// Jassub transfers control of its canvas to the worker. That canvas is retired, not cleared.
	}
};
