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
// honest; the version check keeps older TV browsers on the compatibility engine instead of letting
// one transfer the canvas before its WASM turns out not to compile.
export const supportsJassubRenderer = () => {
	const chromiumMajor = getChromiumMajorVersion();
	if (chromiumMajor && chromiumMajor < 85) return false;
	if (!chromiumMajor) return false;
	if (typeof Worker !== 'function') return false;
	if (typeof WebAssembly !== 'object') return false;
	if (typeof Proxy !== 'function') return false;
	if (typeof ResizeObserver !== 'function') return false;
	if (typeof TextDecoder !== 'function') return false;
	if (typeof HTMLCanvasElement === 'undefined') return false;
	return typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function';
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
const JASSUB_MODERN_WASM = 'jassub-worker-modern.wasm';
const fullUrl = (path) => new URL(assetUrl(path), document.baseURI).href;

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
		modernWasmUrl: fullUrl(JASSUB_MODERN_WASM),
		wasmWorkerUrl: `${worker}#normal`,
		modernWasmWorkerUrl: `${worker}#modern`,
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
const JASSUB_SLOW_FRAME_MS = 34;
const JASSUB_FAST_FRAME_MS = 12;

// Jassub has no clock of its own in canvas-only use. This facade follows the same contract as
// SubtitlesOctopus: ticks are absolute corrections, while playing time advances between them so
// animated typesetting keeps moving. Most frames come back unchanged from libass and cost little.
class JassubCanvasRenderer {
	constructor(instance, onError) {
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
		this.qualityLevel = 0;
		this.frameCosts = [];
		this.fastFrames = 0;
		this.qualityChangedAt = 0;
		this.resizeWrite = Promise.resolve();
		this.trackWrite = Promise.resolve();
		this.onError = onError;
		instance.ready.catch((err) => this.fail(err));
	}

	fail(err) {
		if (this.failed || this.destroyed) return;
		this.failed = true;
		console.error('[AssRenderer] Jassub failed:', err);
		if (this.onError) this.onError(err);
	}

	now() {
		if (this.paused) return this.clockTime;
		return this.clockTime + Math.max(0, ((performance.now() || Date.now()) - this.clockAt) / 1000);
	}

	anchor(seconds) {
		this.clockTime = Math.max(0, seconds || 0);
		this.clockAt = performance.now() || Date.now();
	}

	render(repaint = false) {
		if (this.destroyed || this.failed) return Promise.resolve();
		return this.instance.ready.then(() => {
			if (this.destroyed || this.failed) return;
			const started = performance.now() || Date.now();
			return this.instance.manualRender({
				expectedDisplayTime: started,
				width: Math.max(1, this.width),
				height: Math.max(1, this.height),
				mediaTime: this.now(),
			}, repaint).then(() => this.adaptQuality((performance.now() || Date.now()) - started));
		}).catch((err) => this.fail(err));
	}

	adaptQuality(cost) {
		if (this.destroyed || this.failed) return;
		const now = performance.now() || Date.now();
		// Unchanged frames return almost immediately. Judge load only by frames which did
		// enough work to prove libass actually rasterized or composited them; otherwise a
		// heavy track which changes every other video frame looks half cheap and half slow.
		if (cost >= 10) {
			this.frameCosts.push(cost);
			if (this.frameCosts.length > 5) this.frameCosts.shift();
		}
		if (cost <= JASSUB_FAST_FRAME_MS) this.fastFrames += 1;
		else this.fastFrames = 0;
		const slowFrames = this.frameCosts.filter((frameCost) => frameCost >= JASSUB_SLOW_FRAME_MS).length;
		if (this.frameCosts.length >= 3 && slowFrames >= 3 && this.qualityLevel < JASSUB_QUALITY_LEVELS.length - 1 && now - this.qualityChangedAt > 300) {
			this.qualityLevel += 1;
			this.frameCosts = [];
			this.fastFrames = 0;
			this.qualityChangedAt = now;
			this.resize();
		} else if (this.fastFrames >= 96 && this.qualityLevel > 0 && now - this.qualityChangedAt > 4000) {
			this.qualityLevel -= 1;
			this.frameCosts = [];
			this.fastFrames = 0;
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
		this.timer = setInterval(() => this.render(false), 1000 / 24);
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
					return this.instance.renderer._resizeCanvas(size.width, size.height, 0, 0);
				}
			})
			.then(() => {
				if (!this.destroyed) this.render(true);
			})
			.catch((err) => this.fail(err));
		return this.resizeWrite;
	}

	setTrack(content) {
		this.trackWrite = this.trackWrite
			.then(() => this.instance.ready)
			.then(() => this.instance.renderer.setTrack(content))
			.then(() => this.render(true))
			.catch((err) => this.fail(err));
		return this.trackWrite;
	}

	setCurrentTime(seconds) {
		this.time = Math.max(0, seconds || 0);
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
		this.instance.destroy().catch(() => {});
	}
}

const createJassubRenderer = async (options, onError) => {
	try {
		const mod = await import('jassub');
		const JASSUB = mod.default || mod;
		const fallback = fullUrl(FALLBACK_FONT);
		const instance = new JASSUB({
			...options,
			...jassubEngine(),
			// availableFonts only says where a font can be fetched after libass first misses it.
			// Put the fallback in fonts too, so the first frame already has glyphs instead of
			// rendering empty until a later animated frame happens to force a repaint.
			fonts: [...(options.fonts || []), fallback],
			availableFonts: {roboto: fallback},
			defaultFont: 'roboto',
			queryFonts: false,
			// TV browsers rarely expose deviceMemory. Use upstream's low-memory tier: in the
			// extreme typesetting harness it capped WASM heap growth near 135 MB instead of 203 MB,
			// while producing the same pixels and broadly unchanged render times.
			libassMemoryLimit: 32,
			libassGlyphLimit: 1000,
			debug: false
		});
		return new JassubCanvasRenderer(instance, onError);
	} catch (err) {
		console.error('[AssRenderer] Failed to initialize Jassub:', err);
		return null;
	}
};

const createRenderer = async (options, onError, compatibility = false) => {
	if (supportsJassubRenderer() && !compatibility) {
		const renderer = await createJassubRenderer(options, onError);
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

export const initAssCanvasRenderer = async (canvasElement, subtitleUrl, fontsUrl, onError, compatibility = false) => {
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
	const renderer = await createRenderer(options, onError, compatibility);
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
		renderer.setCurrentTime(Math.max(0, currentTimeSeconds));
	}
};

export const clearAssCanvas = (canvas) => {
	if (!canvas) return;
	const ctx = canvas.getContext('2d');
	if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
};
