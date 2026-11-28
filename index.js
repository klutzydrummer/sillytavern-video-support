/**
 * SillyTavern Video Support Extension
 *
 * Two processing modes:
 *   Backend  — sends the raw video as input_video for the server to decode
 *   Frontend — extracts JPEG frames in the browser via <video>+<canvas>,
 *              sends them as a sequence of image_url parts
 *
 * Video is stored in extra.media (ST's native format) for persistence.
 * The fetch rewrite reads pendingVideo (current send) or extra.media
 * (regeneration) and injects the appropriate content parts.
 *
 * P6 (routing "dossier", RTR URL set): media goes once to a media model through
 * RTR (pipeline.js); RP requests then get text tiers only, never media (Q26a).
 * The legacy path above stays for routing "direct" or an empty RTR URL.
 */

import { chat, eventSource, event_types, saveChatConditional, getRequestHeaders } from '../../../../script.js';
import {
    DEFAULT_CDN_BASE,
    estimateTokens,
    ffmpegAssetUrls,
    formatTokenEstimate,
    getOwnedVideoUrl,
    isInjectableGenType,
    isMainGenerateUrl,
    AUDIO_SAMPLE_RATE,
    encodeWav16,
    bytesToBase64,
    makeAudioPart,
    appendPartsToLastUser,
    selectFrameTimes,
    framesBudget,
    dossierDuration,
    decideFramesForTurn,
    requestedFrameTimes,
    buildFrameParts,
    frameAtArgs,
    createKeyFrameCache,
} from './video-utils.js';
import { createStore, runStorageSelfTest } from './dossier-store.js';
import { sha256 } from './hash.js';
import { CHAT_SETTINGS_KEY, resolveSettings, settingsRows, setGlobal, setChat } from './settings.js';
import { createRtrClient } from './rtr-client.js';
import { createProtocol } from './pipeline.js';
import { buildTiers, createTranscriptCache, parseTimestamps } from './tiers.js';
import { buildCapsule, buildMediaParts, mediaSeconds } from './prompts.js';
import { itemHandle } from './queue.js';
import { REGEN_CHOICES, dropdownOptions, resolveMediaModel } from './media-models.js';
import { ROUTING_DOSSIER, ROUTING_DIRECT, routingMode, injectTiers, progressText, requeryBarModel,
    itemCardModel, parseQuestionLines, rpVisionHint } from './protocol-view.js';

const SETTINGS_KEY = 'videoSupport';

// Dynamic import — extensions.js path varies and static import kills the module silently
let extension_settings, saveSettingsDebounced, getContext;
async function loadExtensionAPIs() {
    // Try multiple known paths for extensions.js
    const paths = [
        '../../../extensions.js',
        '../../../../scripts/extensions.js',
        '../../extensions.js',
    ];
    for (const path of paths) {
        try {
            const mod = await import(path);
            extension_settings = mod.extension_settings;
            saveSettingsDebounced = mod.saveSettingsDebounced;
            getContext = mod.getContext;
            console.debug('[VideoSupport] Loaded extensions.js from', path);
            return;
        } catch { /* try next */ }
    }
    console.warn('[VideoSupport] Could not load extensions.js — settings will not persist across sessions');
    extension_settings = {};
    saveSettingsDebounced = () => {};
}

const DEFAULTS = {
    mode: 'frontend',
    fps: 1,
    maxDimension: 512,
    maxFrames: 24,
    tokensPerFrame: 1024, // vastai-llmrunner models.json forces image min=max=1024 tokens
    jpegQuality: 0.7,
    maxUploadMB: 50, // refuse videos larger than this (base64 inflates ~33% on the wire)
    cdnBase: DEFAULT_CDN_BASE,
    sendAudio: false, // direct (legacy) frontend mode only; dossier mode always sends audio to the media model
    debug: false,
    // P6 protocol
    routing: ROUTING_DOSSIER, // 'dossier' (media once via RTR, tiers after) | 'direct' (legacy re-send)
    rtrBaseUrl: '',           // box base URL without /v1 (guard routes media-dossier to RTR); empty = legacy path
    gpuLabel: '',             // keys the learned time averages (estimate.js)
    protocol: {},             // global layer of settings.js; per-chat layer is in chatMetadata
    stats: {},                // EMA timing averages, model|gpu → field → {v, n}
    mmproj: {},               // last mmproj_sha256 RTR reported per media model (soft key)
    // P7: key frames to an image-capable RP (dossier mode)
    rpAcceptsImages: false,   // the authority; RTR's rp_vision only drives a hint (P7 #1)
    sendFramesToRp: true,     // master toggle; does nothing while rpAcceptsImages is off
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function settings() {
    return extension_settings[SETTINGS_KEY];
}

function loadSettings() {
    if (!extension_settings[SETTINGS_KEY]) extension_settings[SETTINGS_KEY] = {};
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (extension_settings[SETTINGS_KEY][k] === undefined) {
            extension_settings[SETTINGS_KEY][k] = v && typeof v === 'object' ? structuredClone(v) : v;
        }
    }
}

function applySettingsToUI() {
    $('#video_support_mode').val(settings().mode);
    $('#video_support_fps').val(settings().fps);
    $('#video_support_max_dimension').val(settings().maxDimension);
    $('#video_support_max_frames').val(settings().maxFrames);
    $('#video_support_jpeg_quality').val(settings().jpegQuality);
    $('#video_support_tokens_per_frame').val(settings().tokensPerFrame);
    $('#video_support_max_upload_mb').val(settings().maxUploadMB);
    $('#video_support_cdn_base').val(settings().cdnBase);
    $('#video_support_send_audio').prop('checked', settings().sendAudio);
    $('#video_support_debug').prop('checked', settings().debug);
    $('#video_support_rp_images').prop('checked', settings().rpAcceptsImages);
    $('#video_support_rp_frames').prop('checked', settings().sendFramesToRp);
    $('#video_support_routing').val(routingMode(settings()));
    $('#video_support_rtr_url').val(settings().rtrBaseUrl);
    $('#video_support_gpu_label').val(settings().gpuLabel);
    renderProtocolSettings();
    renderRpVisionHint();
    toggleFrontendOptions();
    updateTokenEstimate();
}

function updateTokenEstimate() {
    const { maxFrames, tokensPerFrame } = settings();
    $('#video_support_token_estimate').text(formatTokenEstimate(maxFrames, tokensPerFrame));
}

function toggleFrontendOptions() {
    $('#video_support_frontend_options').toggle(settings().mode === 'frontend');
}

function bindSettingsEvents() {
    $('#video_support_mode').on('change', function () {
        settings().mode = $(this).val();
        saveSettingsDebounced();
        toggleFrontendOptions();
    });
    $('#video_support_fps').on('input', function () {
        settings().fps = Math.max(0.1, Math.min(30, Number($(this).val()) || DEFAULTS.fps));
        saveSettingsDebounced();
    });
    $('#video_support_max_dimension').on('input', function () {
        settings().maxDimension = Math.max(128, Math.min(2048, Number($(this).val())));
        saveSettingsDebounced();
    });
    $('#video_support_max_frames').on('input', function () {
        settings().maxFrames = Math.max(1, Math.min(512, Number($(this).val()) || DEFAULTS.maxFrames));
        saveSettingsDebounced();
        updateTokenEstimate();
    });
    $('#video_support_tokens_per_frame').on('input', function () {
        settings().tokensPerFrame = Math.max(1, Math.min(16384, Number($(this).val()) || DEFAULTS.tokensPerFrame));
        saveSettingsDebounced();
        updateTokenEstimate();
    });
    $('#video_support_max_upload_mb').on('input', function () {
        settings().maxUploadMB = Math.max(1, Math.min(2048, Number($(this).val()) || DEFAULTS.maxUploadMB));
        saveSettingsDebounced();
    });
    $('#video_support_cdn_base').on('change', function () {
        settings().cdnBase = String($(this).val()).trim() || DEFAULT_CDN_BASE;
        ffmpegInstance = null; // reload from the new location
        saveSettingsDebounced();
    });
    $('#video_support_jpeg_quality').on('input', function () {
        settings().jpegQuality = Math.max(0.1, Math.min(1.0, Number($(this).val())));
        saveSettingsDebounced();
    });
    $('#video_support_send_audio').on('change', function () {
        settings().sendAudio = $(this).is(':checked');
        saveSettingsDebounced();
    });
    $('#video_support_rp_images').on('change', function () {
        settings().rpAcceptsImages = $(this).is(':checked');
        saveSettingsDebounced();
        renderItems();
        renderRpVisionHint();
    });
    $('#video_support_rp_frames').on('change', function () {
        settings().sendFramesToRp = $(this).is(':checked');
        saveSettingsDebounced();
        renderItems();
    });
    $('#video_support_selftest').on('click', onStorageSelfTest);
    $('#video_support_debug').on('change', function () {
        settings().debug = $(this).is(':checked');
        saveSettingsDebounced();
    });
    $('#video_support_routing').on('change', function () {
        settings().routing = $(this).val() === ROUTING_DIRECT ? ROUTING_DIRECT : ROUTING_DOSSIER;
        saveSettingsDebounced();
        renderItems();
    });
    $('#video_support_rtr_url').on('change', function () {
        settings().rtrBaseUrl = String($(this).val()).trim();
        saveSettingsDebounced();
        renderItems();
    });
    $('#video_support_gpu_label').on('change', function () {
        settings().gpuLabel = String($(this).val()).trim();
        saveSettingsDebounced();
    });
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {{ dataUrl: string, fileName: string } | null} */
let pendingVideo = null;

let fetchPatched = false;

/** Type of the generation currently in flight (from GENERATION_STARTED); null = none/unknown. */
let currentGenType = null;
let currentGenDryRun = false;

// ---------------------------------------------------------------------------
// Frame extraction (frontend mode)
// ---------------------------------------------------------------------------

/**
 * Extract JPEG frames from a video data URL using ffmpeg.wasm.
 * Runs ffmpeg entirely in the browser via WebAssembly — handles all
 * codecs correctly with no GPU/hardware decode issues.
 * Returns an array of base64 data URL strings.
 */

let ffmpegInstance = null;

async function getFFmpeg() {
    if (ffmpegInstance?.loaded) return ffmpegInstance;

    const urls = ffmpegAssetUrls(settings().cdnBase);
    const { FFmpeg } = await import(/* webpackIgnore: true */ urls.ffmpegModule);
    const { toBlobURL } = await import(/* webpackIgnore: true */ urls.utilModule);

    const ffmpeg = new FFmpeg();
    const coreBaseURL = urls.coreBase;
    const ffmpegBaseURL = urls.ffmpegBase;

    // Fetch worker.js and rewrite relative imports to absolute URLs so it works as a blob Worker
    const workerSrc = await (await fetch(`${ffmpegBaseURL}/worker.js`)).text();
    const workerPatched = workerSrc
        .replace(/from\s+["']\.\/const\.js["']/g, `from "${ffmpegBaseURL}/const.js"`)
        .replace(/from\s+["']\.\/errors\.js["']/g, `from "${ffmpegBaseURL}/errors.js"`);
    const classWorkerURL = URL.createObjectURL(new Blob([workerPatched], { type: 'text/javascript' }));

    await ffmpeg.load({
        classWorkerURL,
        coreURL: await toBlobURL(`${coreBaseURL}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${coreBaseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    });

    ffmpegInstance = ffmpeg;
    console.debug('[VideoSupport] ffmpeg.wasm loaded');
    return ffmpeg;
}

async function extractFrames(videoDataUrl) {
    const { fps, maxDimension, maxFrames, jpegQuality } = settings();

    toastr.info('Extracting frames with ffmpeg...', 'Video Support', { timeOut: 0, extendedTimeOut: 0, tapToDismiss: true });

    try {
        const ffmpeg = await getFFmpeg();

        // Write video to virtual filesystem
        const videoBytes = dataUrlToUint8Array(videoDataUrl);
        if (settings().debug) {
            console.debug(`[VideoSupport] Input video: ${videoBytes.byteLength} bytes, first 4 bytes: ${Array.from(videoBytes.slice(0, 4)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
        }
        await ffmpeg.writeFile('input.mp4', videoBytes);

        // Map JPEG quality: our 0-1 scale → ffmpeg qscale 1-31 (lower = better)
        const qscale = Math.max(1, Math.round((1 - jpegQuality) * 30 + 1));

        // Extract frames
        await ffmpeg.exec([
            '-i', 'input.mp4',
            '-vf', `fps=${fps},scale=${maxDimension}:-2`,
            '-frames:v', String(maxFrames),
            '-q:v', String(qscale),
            'frame_%04d.jpg',
        ]);

        // Read output frames
        const frames = [];
        for (let i = 1; i <= maxFrames; i++) {
            const name = `frame_${String(i).padStart(4, '0')}.jpg`;
            try {
                const data = await ffmpeg.readFile(name);
                const blob = new Blob([data], { type: 'image/jpeg' });
                const dataUrl = await blobToDataUrl(blob);
                frames.push(dataUrl);
                if (settings().debug) {
                    console.debug(`[VideoSupport] Frame ${i}: ${data.byteLength} bytes, dataUrl length: ${dataUrl.length}`);
                    if (i === 1) {
                        $('#video_support_debug_preview').remove();
                        const img = document.createElement('img');
                        img.id = 'video_support_debug_preview';
                        img.src = dataUrl;
                        img.style.cssText = 'position:fixed;top:10px;right:10px;z-index:99999;max-width:200px;border:3px solid red;';
                        img.title = 'Debug: first extracted frame (click to dismiss)';
                        img.onclick = () => img.remove();
                        document.body.appendChild(img);
                    }
                }
                await ffmpeg.deleteFile(name);
            } catch {
                break; // no more frames
            }
        }

        // Clean up input
        await ffmpeg.deleteFile('input.mp4');

        console.debug(`[VideoSupport] Extracted ${frames.length} frames (${fps} fps, q=${jpegQuality})`);
        toastr.clear();
        toastr.success(`Extracted ${frames.length} frames (~${estimateTokens(frames.length, settings().tokensPerFrame)} tokens)`, 'Video Support');
        return frames;
    } catch (err) {
        toastr.clear();
        toastr.error(`Frame extraction failed: ${err.message}`, 'Video Support');
        throw err;
    }
}

function dataUrlToUint8Array(dataUrl) {
    const base64 = dataUrl.split(',')[1];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

// ---------------------------------------------------------------------------
// Audio extraction — the browser decodes the video's soundtrack (no ffmpeg needed),
// downmixes to mono and resamples to 16 kHz. Videos without audio return null and are
// sent frames-only.
// ---------------------------------------------------------------------------

const audioCache = new Map();

async function getAudioForVideo(videoUrl, dataUrl) {
    if (audioCache.has(videoUrl)) return audioCache.get(videoUrl);
    let b64 = null;
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = AC ? new AC() : null;
    try {
        if (!ctx) throw new Error('Web Audio is not available');
        const decoded = await ctx.decodeAudioData(dataUrlToUint8Array(dataUrl).buffer);
        const len = Math.max(1, Math.ceil(decoded.duration * AUDIO_SAMPLE_RATE));
        const off = new OfflineAudioContext(1, len, AUDIO_SAMPLE_RATE); // mixes down to mono
        const src = off.createBufferSource();
        src.buffer = decoded;
        src.connect(off.destination);
        src.start();
        const rendered = await off.startRendering();
        b64 = bytesToBase64(encodeWav16(rendered.getChannelData(0)));
    } catch (err) {
        console.warn('[VideoSupport] No usable audio (sending frames only):', err);
        toastr.warning('Could not decode the video\'s audio; sending frames only.', 'Video Support');
    } finally {
        ctx?.close();
    }
    if (audioCache.size >= FRAME_CACHE_MAX_ENTRIES) audioCache.delete(audioCache.keys().next().value);
    audioCache.set(videoUrl, b64);
    return b64;
}

// ---------------------------------------------------------------------------
// Frame cache — swipes/regenerations re-send the same video repeatedly.
// Skip re-extraction when the video and the extraction-relevant settings
// haven't changed since the last run.
// ---------------------------------------------------------------------------

const FRAME_CACHE_MAX_ENTRIES = 5;
/** @type {Map<string, { signature: string, frames: string[] }>} */
const frameCache = new Map();

function extractionSignature() {
    const { fps, maxDimension, maxFrames, jpegQuality } = settings();
    return JSON.stringify({ fps, maxDimension, maxFrames, jpegQuality });
}

/** Returns cached frames for this video if the extraction settings still match, otherwise re-extracts. */
async function getFramesForVideo(videoUrl, dataUrl = videoUrl) {
    const signature = extractionSignature();
    const cached = frameCache.get(videoUrl);
    if (cached && cached.signature === signature) {
        console.debug(`[VideoSupport] Reusing ${cached.frames.length} cached frames (settings unchanged)`);
        // Refresh recency for LRU eviction
        frameCache.delete(videoUrl);
        frameCache.set(videoUrl, cached);
        return cached.frames;
    }

    const frames = await extractFrames(dataUrl);

    frameCache.delete(videoUrl);
    if (frameCache.size >= FRAME_CACHE_MAX_ENTRIES) {
        frameCache.delete(frameCache.keys().next().value);
    }
    frameCache.set(videoUrl, { signature, frames });

    return frames;
}

/**
 * P7: one JPEG per timestamp with ffmpeg.wasm (`-ss` before `-i`, so a fast seek).
 * The legacy extractFrames (fps sampling) stays for the legacy path and the media model.
 * `ff` is injectable; returns a data URL or null per time, in order.
 */
async function extractFramesAt(videoDataUrl, times, ff = null) {
    const { maxDimension, jpegQuality } = settings();
    const ffmpeg = ff || await getFFmpeg();
    const qscale = Math.max(1, Math.round((1 - jpegQuality) * 30 + 1));
    await ffmpeg.writeFile('kf_input.mp4', dataUrlToUint8Array(videoDataUrl));
    const out = [];
    try {
        for (const t of times) {
            const name = 'kf_at.jpg';
            try {
                await ffmpeg.exec(frameAtArgs(t, { maxDimension, qscale, input: 'kf_input.mp4', output: name }));
                const data = await ffmpeg.readFile(name);
                out.push(data?.byteLength ? await blobToDataUrl(new Blob([data], { type: 'image/jpeg' })) : null);
                try { await ffmpeg.deleteFile(name); } catch { /* not written */ }
            } catch (err) {
                console.warn(`[VideoSupport] No frame at t=${t}:`, err);
                out.push(null);
            }
        }
    } finally {
        try { await ffmpeg.deleteFile('kf_input.mp4'); } catch { /* ignore */ }
    }
    return out;
}

/** Key frames for the RP, by (media hash, t). Hash = item id (media sha256). */
const keyFrameCache = createKeyFrameCache({ maxEntries: 24 });

// ---------------------------------------------------------------------------
// fetch() patch
// ---------------------------------------------------------------------------

function patchFetch() {
    if (fetchPatched) return;
    fetchPatched = true;

    const originalFetch = window.fetch;

    window.fetch = async function (url, options = {}) {
        // Our own question pass (generateRaw) must reach the RP model untouched.
        if (bypassFetch > 0) return originalFetch.call(this, url, options);
        if (
            options.body &&
            typeof options.body === 'string' &&
            typeof url === 'string' &&
            isMainGenerateUrl(url) &&
            isInjectableGenType(currentGenType, currentGenDryRun) &&
            isCustomSource(options.body)
        ) {
            if (protocolActive()) {
                // Q26a: tiers as text, never media.
                try {
                    options = await injectProtocolTiers(options);
                } catch (err) {
                    console.error('[VideoSupport] Failed to add media dossier tiers:', err);
                }
                return originalFetch.call(this, url, options);
            }
            // pendingVideo = being sent right now; otherwise only a video owned by the newest user message
            const videoUrl = pendingVideo?.dataUrl ?? getOwnedVideoUrl(chat);
            if (videoUrl) {
                try {
                    const dataUrl = await resolveVideoDataUrl(videoUrl);
                    if (settings().mode === 'frontend') {
                        const frames = await getFramesForVideo(videoUrl, dataUrl);
                        if (frames.length > 0) {
                            options = injectFrames(options, frames);
                        }
                        if (settings().sendAudio) {
                            const audio = await getAudioForVideo(videoUrl, dataUrl);
                            if (audio) options = injectAudio(options, audio);
                        }
                    } else {
                        options = injectInputVideo(options, dataUrl);
                    }
                } catch (err) {
                    console.error('[VideoSupport] Failed to inject video:', err);
                }
            }
        }
        return originalFetch.call(this, url, options);
    };

    // Resolve stored files through the unpatched fetch
    originalFetchRef = originalFetch;
}

let originalFetchRef = null;

/** Only the Custom (OpenAI-compatible) source gets video; other chat-completion sources are left alone. */
function isCustomSource(body) {
    try {
        const source = JSON.parse(body).chat_completion_source;
        return source === undefined || source === 'custom';
    } catch {
        return false;
    }
}

/** Stored videos are uploaded files (URL path); convert back to a data URL for sending. Data URLs pass through. */
async function resolveVideoDataUrl(url) {
    if (url.startsWith('data:')) return url;
    const res = await (originalFetchRef ?? window.fetch)(url);
    if (!res.ok) throw new Error(`Could not read stored video (${res.status})`);
    return blobToDataUrl(await res.blob());
}

/** Frontend mode, opt-in: inject the soundtrack as an input_audio part after the frames. */
function injectAudio(options, base64Wav) {
    const body = JSON.parse(options.body);
    if (!appendPartsToLastUser(body, [makeAudioPart(base64Wav)])) return options;
    console.debug('[VideoSupport] Injected input_audio (frontend mode)');
    return { ...options, body: JSON.stringify(body) };
}

/** Backend mode: inject raw video as input_video. */
function injectInputVideo(options, videoUrl) {
    const body = JSON.parse(options.body);
    if (!Array.isArray(body.messages)) return options;

    const msg = findLastUserMessage(body.messages);
    if (!msg) return options;

    msg.content.push({ type: 'input_video', input_video: { url: videoUrl } });
    console.debug('[VideoSupport] Injected input_video (backend mode)');

    return { ...options, body: JSON.stringify(body) };
}

/** Frontend mode: inject extracted frames as image_url parts. */
function injectFrames(options, frames) {
    const body = JSON.parse(options.body);
    if (!Array.isArray(body.messages)) return options;

    const msg = findLastUserMessage(body.messages);
    if (!msg) return options;

    for (const frame of frames) {
        msg.content.push({ type: 'image_url', image_url: { url: frame } });
    }
    console.debug(`[VideoSupport] Injected ${frames.length} frames (frontend mode)`);

    return { ...options, body: JSON.stringify(body) };
}

/**
 * Find the last user message and normalise its content to an array.
 * Returns the message object, or null if not found.
 */
function findLastUserMessage(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
            const msg = messages[i];
            if (typeof msg.content === 'string') {
                msg.content = [{ type: 'text', text: msg.content }];
            } else if (!Array.isArray(msg.content)) {
                msg.content = [];
            }
            return msg;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// MESSAGE_SENT — persist to extra.media, then clear pendingVideo
// ---------------------------------------------------------------------------

async function onMessageSent(messageId) {
    if (!pendingVideo) return;

    const { dataUrl, fileName } = pendingVideo;
    const msg = chat[messageId];

    if (msg) {
        if (!msg.extra) msg.extra = {};
        if (!Array.isArray(msg.extra.media)) msg.extra.media = [];
        const upload = uploadVideo(dataUrl, fileName);
        if (protocolActive()) {
            // The RP request awaits this in the fetch patch (Open fork: first pass there).
            trackFirstPass(upload.then(url => startFirstPass({ url, title: fileName, messageId, dataUrl })));
        }
        const url = await upload;
        msg.extra.media.push({ type: 'video', url, title: fileName, source: 'upload' });
        await saveChatConditional();
        console.debug('[VideoSupport] Saved video to message', messageId);
    }

    pendingVideo = null;
    $('#video_support_indicator').hide();
}

/**
 * Save the video via ST's file upload API so the chat JSONL stores a short path
 * instead of megabytes of base64. Falls back to the inline data URL if the upload fails.
 */
async function uploadVideo(dataUrl, fileName) {
    try {
        const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
        const res = await fetch('/api/files/upload', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name: `video_${Date.now()}_${safeName}`, data: dataUrl.split(',')[1] }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { path } = await res.json();
        if (!path) throw new Error('no path returned');
        return path;
    } catch (err) {
        console.warn('[VideoSupport] Upload failed, storing inline in chat file:', err);
        toastr.warning('Could not upload video file; storing it inline in the chat.', 'Video Support');
        return dataUrl;
    }
}

// ---------------------------------------------------------------------------
// Dossier storage adapter (dossier-store.js). Real ST / TauriTavern behaviour of
// these calls is unverified [U]: parent-chat reads and group chats especially.
// ---------------------------------------------------------------------------

function stContext() {
    if (typeof getContext !== 'function') throw new Error('getContext unavailable');
    return getContext();
}

/** Metadata of a saved chat of the current character or group, read from the chat file. */
async function readSavedChatMetadata(chatName) {
    const ctx = stContext();
    let res;
    if (ctx.groupId) {
        res = await fetch('/api/chats/group/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ id: chatName }) });
    } else {
        const ch = ctx.characters?.[ctx.characterId];
        if (!ch) return null;
        res = await fetch('/api/chats/get', {
            method: 'POST', headers: getRequestHeaders(),
            body: JSON.stringify({ ch_name: ch.name, file_name: chatName, avatar_url: ch.avatar }),
        });
    }
    if (!res.ok) return null;
    const lines = await res.json();
    return Array.isArray(lines) ? (lines.find(l => l && typeof l.chat_metadata === 'object')?.chat_metadata ?? null) : null;
}

const storageAdapter = {
    getChatMetadata: () => stContext().chatMetadata,
    saveMetadata: () => stContext().saveMetadata(),
    getCurrentChatName: () => stContext().getCurrentChatId?.() ?? null,
    readChatMetadata: readSavedChatMetadata,
    async uploadFile(name, base64) {
        const res = await fetch('/api/files/upload', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ name, data: base64 }) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { path } = await res.json();
        return path;
    },
    async readFile(path) {
        const res = await fetch(path, { cache: 'no-store' });
        if (!res.ok) return null;
        return new Uint8Array(await res.arrayBuffer());
    },
    async deleteFile(path) {
        await fetch('/api/files/delete', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ path }) });
    },
};

const dossierStore = createStore(storageAdapter);

async function onChatChanged() {
    transcriptCache.clear();
    lastDecisions = [];
    renderRequeryBar();
    renderProtocolSettings();
    try {
        const r = await dossierStore.onChatOpened();
        if (r.copied) console.log(`[VideoSupport] Copied ${r.items} media dossier item(s) from the parent chat`);
    } catch (err) {
        console.warn('[VideoSupport] Branch dossier check failed:', err);
    }
    renderItems();
}

async function onStorageSelfTest() {
    const out = $('#video_support_selftest_result');
    out.text('Running…');
    try {
        const { ok, checks } = await runStorageSelfTest(storageAdapter);
        const mark = (c) => (c.ok === true ? 'PASS' : c.ok === false ? 'FAIL' : 'N/A ');
        out.text(checks.map(c => `${mark(c)}  ${c.name}: ${c.detail}`).join('\n'));
        (ok ? toastr.success : toastr.warning)(ok ? 'Storage self-test passed' : 'Storage self-test found problems', 'Video Support');
    } catch (err) {
        out.text(`FAIL  ${String(err?.message || err)}`);
    }
}


// ---------------------------------------------------------------------------
// P6 media protocol glue. Decisions live in the pure modules (pipeline.js,
// queue.js, tiers.js, protocol-view.js), which have node tests; this section
// only reads ST state and draws DOM, so it is checked with node --check alone.
// Real ST / TauriTavern / phone behaviour here is unverified [U].
// ---------------------------------------------------------------------------

let firstPass = null;          // in-flight first pass of the newest attachment
let bypassFetch = 0;           // > 0 while our own question pass runs (re-entrancy)
const itemStatus = new Map();  // itemId → {busy:{label}} | {error} | null
const transcriptCache = createTranscriptCache(dossierStore);
// One shot per item for the next reply: null = the user's "Send frames" button (key frames),
// times[] = the RP's <frames t="…"/> tag (explicit times, clamped to the frame budget when sent).
const framesRequested = new Map();
let rtrInfo = { rpVision: null, coSet: null, gpu: null, prefillRpS: null }; // last RTR extras seen
let lastDecisions = [];

function protocolActive() {
    return routingMode(settings()) === ROUTING_DOSSIER && !!String(settings().rtrBaseUrl || '').trim();
}

function chatLayer(create = false) {
    let md;
    try { md = stContext().chatMetadata; } catch { return {}; }
    if (!md) return {};
    if (!md[CHAT_SETTINGS_KEY] && create) md[CHAT_SETTINGS_KEY] = {};
    return md[CHAT_SETTINGS_KEY] || {};
}

function protocolSettings() {
    return resolveSettings(settings().protocol, chatLayer());
}

/** Built per call so a changed URL applies at once. Goes straight to the box (Open fork: transport). */
function rtrClient() {
    return createRtrClient({ fetch: (...a) => (originalFetchRef ?? window.fetch)(...a), baseUrl: settings().rtrBaseUrl });
}

function capsuleContext() {
    const ctx = stContext();
    const ch = ctx.characters?.[ctx.characterId];
    return {
        charName: ctx.name2 || ch?.name || '',
        charDescription: ch?.description || '',
        userName: ctx.name1 || '',
        messages: (ctx.chat || chat || []).filter(m => m && !m.is_system).map(m => ({ name: m.name, text: m.mes })),
    };
}

/** Question pass on the RP model. [U] generateRaw's jsonSchema form; retried plain if rejected. */
async function askQuestions({ prompt, schema, maxTokens }) {
    const ctx = stContext();
    const s = protocolSettings();
    const capsule = buildCapsule(capsuleContext(), s);
    const full = capsule ? `${capsule}\n\n${prompt}` : prompt;
    bypassFetch++;
    try {
        try {
            return await ctx.generateRaw({ prompt: full, responseLength: maxTokens, jsonSchema: { name: 'media_questions', strict: true, value: schema } });
        } catch (err) {
            console.warn('[VideoSupport] Question pass with a JSON schema failed; retrying plain:', err);
            return await ctx.generateRaw({ prompt: full, responseLength: maxTokens });
        }
    } finally {
        bypassFetch--;
    }
}

/** Media for the RTR call, from the stored file (frames/audio reuse the legacy caches). Audio is always included. */
async function getMediaForItem(_itemId, item) {
    const url = item?.media_url;
    if (!url) throw new Error('no stored media for this item');
    const dataUrl = await resolveVideoDataUrl(url);
    if (settings().mode === 'frontend') {
        const frames = await getFramesForVideo(url, dataUrl);
        // Dossier mode always sends the soundtrack (P6 #19): the transcript and timeline need it.
        const audio = await getAudioForVideo(url, dataUrl);
        const fps = settings().fps;
        return { mediaParts: buildMediaParts({ mode: 'frontend', frames, fps, audioB64: audio }), mediaSeconds: mediaSeconds({ frames, fps }) };
    }
    return { mediaParts: buildMediaParts({ mode: 'backend', videoUrl: dataUrl }), mediaSeconds: null };
}

const protocol = createProtocol({
    store: dossierStore,
    rtr: { plan: (a) => rtrClient().plan(a), run: (a) => rtrClient().run(a) },
    askQuestions,
    getMedia: getMediaForItem,
    capsuleContext,
    settings: protocolSettings,
    getStats: () => settings().stats || {},
    setStats: (st) => { settings().stats = st; saveSettingsDebounced(); },
    gpu: () => settings().gpuLabel || '',
    rpModel: () => null, // RTR resolves the loaded RP model
    knownMmproj: (lsId) => settings().mmproj?.[lsId],
    rememberMmproj: (lsId, sha) => { settings().mmproj = { ...(settings().mmproj || {}), [lsId]: sha }; saveSettingsDebounced(); },
    onStatus: (id, st) => { itemStatus.set(id, st); renderItems(); },
    onRtrInfo: (x) => {
        // Older RTR sends no extras: keep the last known rp_vision rather than clearing it.
        rtrInfo = { ...x, rpVision: x.rpVision ?? rtrInfo.rpVision };
        renderRpVisionHint();
    },
});

function renderRpVisionHint() {
    const el = $('#video_support_rp_vision_hint');
    if (!el.length) return;
    const h = rpVisionHint({ rpVision: rtrInfo.rpVision, rpAcceptsImages: !!settings().rpAcceptsImages });
    el.toggle(!!h).text(h?.text || '').toggleClass('tone-warn', h?.tone === 'warn');
}

/** The RP takes frames: the user's setting (the authority) and the frames toggle. */
function rpFramesOn() {
    return !!settings().rpAcceptsImages && !!settings().sendFramesToRp;
}

function trackFirstPass(p) {
    const tracked = p.catch(err => console.error('[VideoSupport] Media first pass failed:', err))
        .finally(() => { if (firstPass === tracked) firstPass = null; });
    firstPass = tracked;
    return tracked;
}

/** Hash → register → cache lookup / first pass. Item id = media sha256. */
async function startFirstPass({ url, title, messageId, dataUrl }) {
    const bytes = dataUrl.startsWith('data:') ? dataUrlToUint8Array(dataUrl) : dataUrlToUint8Array(await resolveVideoDataUrl(dataUrl));
    const { hex: id } = await sha256(bytes);
    await protocol.registerItem({ id, title, mediaUrl: url, messageId });
    renderItems();
    const r = await protocol.ensureDossier(id);
    if (r.status === 'failed') toastr.error(r.error || 'Media pass failed', 'Video Support');
    else if (r.status === 'stale') toastr.warning('Using a stale dossier (media model projector changed). Regenerate to refresh.', 'Video Support');
    if (r.badge) toastr.warning(`Dossier saved; ${r.badge}.`, 'Video Support');
    renderItems();
    return r;
}

function lastUserText(messages) {
    for (let i = (messages || []).length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role !== 'user') continue;
        if (typeof m.content === 'string') return m.content;
        if (Array.isArray(m.content)) return m.content.filter(p => p?.type === 'text').map(p => p.text).join('\n');
        return '';
    }
    return '';
}

/** RP request in dossier mode: wait for a running first pass, then add T0/T1/T2/F as text. */
async function injectProtocolTiers(options) {
    // A video owned by the newest user message with no item yet (older chat, regenerate): first pass now.
    const owned = getOwnedVideoUrl(chat);
    if (owned && !firstPass && !dossierStore.listItems().some(x => x.item.media_url === owned)) {
        let lastUser = -1;
        for (let i = chat.length - 1; i >= 0; i--) if (chat[i]?.is_user) { lastUser = i; break; }
        const title = chat[lastUser]?.extra?.media?.find(m => m.url === owned)?.title || 'video';
        trackFirstPass(startFirstPass({ url: owned, title, messageId: lastUser, dataUrl: owned }));
    }
    if (firstPass) await firstPass;
    const items = protocol.tierItems();
    if (!items.length) return options;
    const body = JSON.parse(options.body);
    const tiers = await buildTiers(items, lastUserText(body.messages), protocolSettings(), transcriptCache);
    for (const [id, badge] of tiers.badges) itemStatus.set(id, { ...(itemStatus.get(id) || {}), transcriptBadge: badge });
    const added = injectTiers(body, { t0: tiers.t0.text, t1: tiers.t1.text, t2: tiers.t2.text, handles: items.map(it => itemHandle(it.id)), frames: rpFramesOn() });
    if (added && settings().debug) console.debug('[VideoSupport] Tiers', { t0: tiers.t0.tokens, t1: tiers.t1.tokens, t2: tiers.t2.tokens });
    let framed = false;
    try {
        framed = await addRpFrames(body, items, tiers, owned);
    } catch (err) {
        console.error('[VideoSupport] Could not add key frames for the RP:', err);
    }
    if (!added && !framed) return options;
    return { ...options, body: JSON.stringify(body) };
}

/**
 * P7 (§5, Q26a): key frames as captioned image_url parts, only when the RP takes images.
 * The item is the one the newest user message owns (the reply right after processing),
 * else the active item. Audio/video is never re-sent here.
 */
async function addRpFrames(body, items, tiers, ownedUrl) {
    if (!rpFramesOn()) return false;
    const s = protocolSettings();
    const k = framesBudget(s.rpFrames, settings().tokensPerFrame, s.rpFrameCtx);
    const urlById = new Map(dossierStore.listItems().map(x => [x.id, x.item.media_url]));
    const ownedItem = ownedUrl ? items.find(it => urlById.get(it.id) === ownedUrl) : null;
    // An item the RP asked frames for (<frames> tag) comes before the active item.
    const tagged = items.find(x => Array.isArray(framesRequested.get(x.id)));
    const it = ownedItem || tagged || tiers.active;
    if (!it?.version) return false;
    const d = it.version.dossier || {};
    const selected = selectFrameTimes(d.key_frames, k, dossierDuration(d));
    const asked = framesRequested.get(it.id);
    const userAsked = framesRequested.has(it.id);
    const requested = Array.isArray(asked) ? requestedFrameTimes(asked, k, dossierDuration(d)) : [];
    const decision = decideFramesForTurn({
        rpImages: true, enabled: true, k, selected,
        replyToMedia: !!ownedItem, userAsked, requested,
        citedTimes: parseTimestamps(lastUserText(body.messages)), t2Hits: tiers.t2.hits,
    });
    if (!decision.frames.length) return false;
    const mediaUrl = urlById.get(it.id);
    if (!mediaUrl) return false;
    const times = decision.frames.map(f => f.t);
    let dataUrl = null;
    const { urls, hits } = await keyFrameCache.getOrExtract(it.id, times, async (missing) => {
        dataUrl = dataUrl || await resolveVideoDataUrl(mediaUrl);
        return extractFramesAt(dataUrl, missing);
    });
    const parts = buildFrameParts(decision.frames.map((f, i) => ({ ...f, url: urls[i] })));
    if (!parts.length || !appendPartsToLastUser(body, parts)) return false;
    if (userAsked) { framesRequested.delete(it.id); renderItems(); }
    if (settings().debug) console.debug('[VideoSupport] RP frames', { reason: decision.reason, times, cacheHits: hits });
    return true;
}

/**
 * RP reply done: strip <media_q> and <frames>, queue, then auto / confirm per item.
 * <frames> requests become one-shot frame requests for the next reply (no auto-continue);
 * they are ignored (still stripped) while the RP is not set to take frames. [U] runs after streaming ends.
 */
async function onMessageReceived(messageId) {
    if (!protocolActive()) return;
    const msg = chat[messageId];
    if (!msg || msg.is_user || typeof msg.mes !== 'string') return;
    let out;
    try {
        out = await protocol.afterRpTurn({ text: msg.mes, turn: Number(messageId) || 0 });
    } catch (err) {
        console.error('[VideoSupport] Follow-up handling failed:', err);
        return;
    }
    if (out.text !== msg.mes) {
        msg.mes = out.text;
        if (Array.isArray(msg.swipes)) msg.swipes[msg.swipe_id ?? 0] = out.text;
        try { stContext().updateMessageBlock?.(messageId, msg); } catch (err) { console.warn('[VideoSupport] Could not redraw message:', err); }
        await saveChatConditional();
    }
    if (out.frames?.length && rpFramesOn()) {
        for (const f of out.frames) {
            const prev = framesRequested.get(f.itemId);
            framesRequested.set(f.itemId, [...(Array.isArray(prev) ? prev : []), ...f.times]);
        }
        if (settings().debug) console.debug('[VideoSupport] RP asked for frames', out.frames);
    }
    lastDecisions = out.decisions;
    renderRequeryBar();
    for (const p of out.auto) {
        p.then(r => { if (r?.status === 'ok') toastr.info('Media follow-up answered; it applies from the next reply.', 'Video Support'); })
            .finally(() => { transcriptCache.clear(); renderItems(); });
    }
    renderItems();
}

// --- DOM: item list, dialog, requery bar, settings rows ----------------------

function badgeEl(b) {
    return $('<span>', { class: `video-support-badge tone-${b.tone}`, title: b.title || '' }).text(b.text);
}

function renderItems() {
    const box = $('#video_support_items');
    if (!box.length) return;
    let list = [];
    try { if (protocolActive()) list = dossierStore.listItems(); } catch { list = []; }
    box.empty().toggle(list.length > 0);
    list.sort((a, b) => (a.item.order ?? 0) - (b.item.order ?? 0));
    for (const { id, item } of list) {
        const st = itemStatus.get(id) || null;
        let lookup = null;
        try { const m = protocol.itemModel(item); lookup = m ? protocol.lookupFor(id, m) : null; } catch { lookup = null; }
        const vm = itemCardModel({ id, item, lookup, busy: st?.busy || null, error: st?.error || null, transcriptBadge: st?.transcriptBadge || null });
        const row = $('<div>', { class: 'video-support-item', 'data-id': id });
        row.append($('<span>', { class: 'video-support-item-title', title: `id ${vm.handle}` }).text(vm.title));
        const sel = $('<select>', { class: 'text_pole video-support-item-model', title: 'Media model for this item' });
        for (const o of vm.options) sel.append($('<option>', { value: o.value, selected: o.selected }).text(o.label));
        sel.on('change', async () => { await protocol.setSelectedModel(id, sel.val()); renderItems(); });
        row.append(sel);
        const badges = $('<span>', { class: 'video-support-badges' });
        vm.badges.forEach(b => badges.append(badgeEl(b)));
        row.append(badges);
        if (!vm.canAsk && !st?.busy) {
            row.append($('<button>', { class: 'menu_button', text: 'Run' }).on('click', () => runAndReport(() => protocol.ensureDossier(id))));
        }
        if (vm.canAsk) row.append($('<button>', { class: 'menu_button', text: 'Ask' }).on('click', () => openDialog(id, 'ask')));
        if (vm.canRegenerate) row.append($('<button>', { class: 'menu_button', text: 'Regenerate' }).on('click', () => openDialog(id, 'regenerate')));
        if (vm.canRegenerate && rpFramesOn()) {
            const on = framesRequested.has(id);
            const tagTimes = framesRequested.get(id);
            const title = Array.isArray(tagTimes)
                ? `The roleplay model asked for frames at ${tagTimes.join(', ')} s; they go with the next reply. Click to cancel.`
                : 'Send this item\'s key frames to the RP on the next reply';
            row.append($('<button>', { class: 'menu_button', text: on ? 'Frames: next reply' : 'Send frames', title })
                .on('click', () => { if (framesRequested.has(id)) framesRequested.delete(id); else framesRequested.set(id, null); renderItems(); }));
        }
        box.append(row);
    }
}

async function runAndReport(fn) {
    try {
        const r = await fn();
        if (r?.status === 'failed') toastr.error(r.error || 'Media call failed', 'Video Support');
    } catch (err) {
        toastr.error(String(err?.message || err), 'Video Support');
    } finally {
        transcriptCache.clear();
        renderItems();
    }
}

/** Ask (questions only) or Regenerate (F10: same / other model / extra questions), with the estimate shown first. */
function openDialog(id, kind) {
    $('.video-support-dialog').remove();
    const item = dossierStore.getItem(id);
    const dlg = $('<div>', { class: 'video-support-dialog' });
    let choice = null, modelSel = null;
    if (kind === 'regenerate') {
        choice = $('<select>', { class: 'text_pole' });
        REGEN_CHOICES.forEach(c => choice.append($('<option>', { value: c.value }).text(c.label)));
        modelSel = $('<select>', { class: 'text_pole' }).hide();
        dropdownOptions(item?.selected_model).forEach(o => modelSel.append($('<option>', { value: o.value, selected: o.selected }).text(o.label)));
        dlg.append(choice, modelSel);
    }
    const text = $('<textarea>', { class: 'text_pole', rows: 3, placeholder: 'One question per line' });
    const est = $('<small>', { class: 'video-support-hint' }).text('Estimating…');
    const go = $('<button>', { class: 'menu_button', text: kind === 'ask' ? 'Ask now' : 'Regenerate' });
    const cancel = $('<button>', { class: 'menu_button', text: 'Cancel' }).on('click', () => dlg.remove());
    dlg.append(text, est, go, cancel);
    const refresh = async () => {
        const c = choice?.val() || 'ask';
        text.toggle(kind === 'ask' || c === 'questions');
        modelSel?.toggle(c === 'model');
        try {
            const model = c === 'model' ? resolveMediaModel(modelSel.val()) : protocol.itemModel(item);
            const pv = await protocol.preview(model, kind === 'ask' ? 'delta' : 'dossier', null);
            est.text(progressText(pv, { kind: kind === 'ask' ? 'delta' : 'dossier' }));
        } catch (err) {
            est.text(`No estimate: ${err?.message || err}`);
        }
    };
    choice?.on('change', refresh);
    modelSel?.on('change', refresh);
    go.on('click', () => {
        const qs = parseQuestionLines(text.val(), protocolSettings().maxQuestions);
        dlg.remove();
        if (kind === 'ask') {
            if (!qs.length) return;
            runAndReport(() => protocol.ask(id, qs));
        } else {
            runAndReport(() => protocol.regenerate(id, choice.val(), { modelKey: modelSel.val(), questions: qs }));
        }
    });
    $(`.video-support-item[data-id="${id}"]`).after(dlg);
    refresh();
}

/** T-F7 confirm bar: [Ask now] [Later] per item. */
function renderRequeryBar() {
    const bar = $('#video_support_requery');
    if (!bar.length) return;
    let titles = {};
    try { titles = Object.fromEntries(dossierStore.listItems().map(({ id, item }) => [id, item.title])); } catch { titles = {}; }
    const m = requeryBarModel(lastDecisions, titles);
    bar.empty().toggle(m.visible);
    for (const it of m.items) {
        const drop = () => { lastDecisions = lastDecisions.filter(d => d.itemId !== it.itemId); renderRequeryBar(); };
        const row = $('<div>', { class: 'video-support-requery-row' }).append($('<span>').text(it.text));
        row.append($('<button>', { class: 'menu_button', text: 'Ask now' }).on('click', () => { drop(); runAndReport(() => protocol.requery(it.itemId, 'confirm')); }));
        row.append($('<button>', { class: 'menu_button', text: 'Later' }).on('click', drop));
        bar.append(row);
    }
}

/** Global and per-chat values side by side; an empty box inherits. */
function renderProtocolSettings() {
    const box = $('#video_support_protocol_rows');
    if (!box.length) return;
    box.empty();
    const g = settings().protocol || (settings().protocol = {});
    const table = $('<table>', { class: 'video-support-protocol-table' });
    table.append('<tr><th>Setting</th><th>All chats</th><th>This chat</th><th>In use</th></tr>');
    for (const r of settingsRows(g, chatLayer())) {
        const tr = $('<tr>');
        tr.append($('<td>').text(r.label));
        const gIn = $('<input>', { class: 'text_pole', type: 'text', placeholder: String(r.def), value: r.global ?? '' });
        const cIn = $('<input>', { class: 'text_pole', type: 'text', placeholder: 'inherit', value: r.chat ?? '' });
        gIn.on('change', () => { setGlobal(g, r.key, gIn.val()); saveSettingsDebounced(); renderProtocolSettings(); });
        cIn.on('change', () => {
            try {
                setChat(chatLayer(true), r.key, cIn.val(), g);
                stContext().saveMetadata();
            } catch (err) {
                toastr.warning('Open a chat to set per-chat values.', 'Video Support');
            }
            renderProtocolSettings();
        });
        tr.append($('<td>').append(gIn), $('<td>').append(cIn), $('<td>').text(`${r.effective === '' ? '—' : r.effective} (${r.source})`));
        table.append(tr);
    }
    box.append(table);
}

// ---------------------------------------------------------------------------
// UI — attach button + indicator
// ---------------------------------------------------------------------------

function createAttachUI() {
    const fileInput = $('<input>', {
        type: 'file',
        accept: 'video/*',
        id: 'video_support_file_input',
        css: { display: 'none' },
    });
    $('body').append(fileInput);

    const btn = $(`
        <div id="video_support_btn" class="list-group-item flex-container flexGap5" title="Attach video">
            <i class="fa-solid fa-film extensionsMenuExtensionButton"></i>
            <span>Attach Video</span>
        </div>
    `);

    const indicator = $(`
        <div id="video_support_indicator" style="display:none;">
            <i class="fa-solid fa-film"></i>
            <span id="video_support_filename"></span>
            <button id="video_support_clear" title="Remove video">&#x2715;</button>
        </div>
    `);

    const menuTarget = $('#extensionsMenu, #options_popup, #send_form .options-content').first();
    if (menuTarget.length) {
        menuTarget.append(btn);
    } else {
        $('#options_button').after(btn);
    }
    indicator.insertBefore('#nonQRFormItems');
    $('<div>', { id: 'video_support_items', css: { display: 'none' } }).insertBefore('#nonQRFormItems');
    $('<div>', { id: 'video_support_requery', css: { display: 'none' } }).insertBefore('#nonQRFormItems');

    btn.on('click', () => fileInput.trigger('click'));

    fileInput.on('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const maxBytes = settings().maxUploadMB * 1048576;
        if (file.size > maxBytes) {
            toastr.error(`Video is ${formatBytes(file.size)}; limit is ${settings().maxUploadMB} MB (see Video Support settings).`, 'Video Support');
            fileInput.val('');
            return;
        }
        try {
            pendingVideo = { dataUrl: await readAsDataUrl(file), fileName: file.name };
            $('#video_support_filename').text(file.name);
            indicator.show();
            console.debug('[VideoSupport] Staged:', file.name, formatBytes(file.size));
        } catch (err) {
            console.error('[VideoSupport] Read failed:', err);
            toastr.error('Could not read video file.', 'Video Support');
        }
        fileInput.val('');
    });

    $(document).on('click', '#video_support_clear', () => {
        pendingVideo = null;
        indicator.hide();
    });
}

// ---------------------------------------------------------------------------
// Settings UI — loaded inline to avoid renderExtensionTemplateAsync dependency
// ---------------------------------------------------------------------------

function createSettingsUI() {
    const html = `
    <div class="video-support-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Video Support</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="video-support-setting">
                    <label for="video_support_mode">Processing Mode</label>
                    <select id="video_support_mode" class="text_pole">
                        <option value="backend">Backend (send raw video)</option>
                        <option value="frontend">Frontend (extract frames)</option>
                    </select>
                    <small class="video-support-hint">
                        Backend sends the video file for the server to decode.
                        Frontend extracts JPEG frames in the browser and sends them as images.
                    </small>
                </div>
                <div id="video_support_frontend_options" style="display:none;">
                    <hr>
                    <div class="video-support-setting">
                        <label for="video_support_fps">Frames per second</label>
                        <input type="number" id="video_support_fps" class="text_pole" min="0.1" max="30" step="0.1" />
                        <small class="video-support-hint">Lower = fewer frames, faster. 1 recommended.</small>
                    </div>
                    <div class="video-support-setting">
                        <label for="video_support_max_dimension">Max frame dimension (px)</label>
                        <input type="number" id="video_support_max_dimension" class="text_pole" min="128" max="2048" step="64" />
                        <small class="video-support-hint">Longest side of each frame.</small>
                    </div>
                    <div class="video-support-setting">
                        <label for="video_support_max_frames">Max frames</label>
                        <input type="number" id="video_support_max_frames" class="text_pole" min="1" max="512" step="1" />
                        <small class="video-support-hint">Hard cap. Context cost: <b id="video_support_token_estimate"></b></small>
                    </div>
                    <div class="video-support-setting">
                        <label for="video_support_tokens_per_frame">Tokens per frame</label>
                        <input type="number" id="video_support_tokens_per_frame" class="text_pole" min="1" max="16384" step="1" />
                        <small class="video-support-hint">Used only for the estimate. 1024 matches vastai-llmrunner, which forces 1024 image tokens regardless of frame size. ST's own token counter does not see video frames.</small>
                    </div>
                    <div class="video-support-setting">
                        <label for="video_support_jpeg_quality">JPEG quality</label>
                        <input type="number" id="video_support_jpeg_quality" class="text_pole" min="0.1" max="1.0" step="0.05" />
                        <small class="video-support-hint">0.1 = smallest, 1.0 = best quality. 0.7 is a good balance.</small>
                    </div>
                </div>
                <hr>
                <div class="video-support-setting">
                    <label for="video_support_max_upload_mb">Max video size (MB)</label>
                    <input type="number" id="video_support_max_upload_mb" class="text_pole" min="1" max="2048" step="1" />
                    <small class="video-support-hint">Larger files are refused. Videos are saved as ST uploaded files; backend mode sends the whole file (base64, +33%) through ST and any tunnel.</small>
                </div>
                <div class="video-support-setting">
                    <label for="video_support_cdn_base">ffmpeg.wasm source (npm-layout base URL)</label>
                    <input type="text" id="video_support_cdn_base" class="text_pole" />
                    <small class="video-support-hint">Frontend mode downloads ffmpeg.wasm (~30 MB) from here on first use. Default is jsDelivr (needs browser internet). To avoid the CDN, self-host @ffmpeg/ffmpeg 0.12.15, @ffmpeg/util 0.12.1 and @ffmpeg/core 0.12.9 in an npm-style folder and point this at it. Reload ffmpeg by changing the value.</small>
                </div>
                <div class="video-support-setting">
                    <label class="checkbox_label" for="video_support_send_audio">
                        <input type="checkbox" id="video_support_send_audio" />
                        Also send the video's audio (direct routing, frontend mode)
                    </label>
                    <small class="video-support-hint">Decodes the soundtrack in the browser (mono, 16 kHz WAV) and sends it as an input_audio part after the frames. Only for audio-capable models (e.g. LFM3-Omni); other servers may reject it. Adds about 2 MB of base64 per minute. Dossier routing ignores this box and always sends the audio to the media model, because the transcript and timeline need it.</small>
                </div>
                <div class="video-support-setting">
                    <label class="checkbox_label" for="video_support_debug">
                        <input type="checkbox" id="video_support_debug" />
                        Debug mode
                    </label>
                    <small class="video-support-hint">Log frame sizes to console and show first extracted frame as a preview overlay.</small>
                </div>
                <hr>
                <div class="video-support-setting">
                    <label for="video_support_routing">Media routing</label>
                    <select id="video_support_routing" class="text_pole">
                        <option value="dossier">Dossier (media model once, text after)</option>
                        <option value="direct">Direct (re-send media every reply)</option>
                    </select>
                    <small class="video-support-hint">Dossier mode sends each video once to a media model through the RTR router and gives the roleplay model a text dossier afterwards. It needs the RTR URL below; with no URL the direct path is used.</small>
                </div>
                <div class="video-support-setting">
                    <label for="video_support_rtr_url">RTR URL</label>
                    <input type="text" id="video_support_rtr_url" class="text_pole" placeholder="https://your-box" />
                    <small class="video-support-hint">Base URL of the GPU box, the same one the chat API uses, without /v1. The extension adds /v1/chat/completions with model "media-dossier", and the box's guard passes that to the media router (RTR). The browser calls it directly, so the box must allow your SillyTavern origin (see LLAMACPP_SETUP.md).</small>
                </div>
                <div class="video-support-setting">
                    <label for="video_support_gpu_label">GPU label</label>
                    <input type="text" id="video_support_gpu_label" class="text_pole" placeholder="e.g. RTX 4090" />
                    <small class="video-support-hint">Time estimates are learned per model and GPU label. A new label starts at "unknown, first run".</small>
                </div>
                <div class="video-support-setting">
                    <label class="checkbox_label" for="video_support_rp_images">
                        <input type="checkbox" id="video_support_rp_images" />
                        The roleplay model accepts images
                    </label>
                    <label class="checkbox_label" for="video_support_rp_frames">
                        <input type="checkbox" id="video_support_rp_frames" />
                        Send key frames to the roleplay model
                    </label>
                    <small class="video-support-hint">Dossier mode only. The reply right after a video is processed gets its top key frames (K below, default 3) as images, each captioned with its timestamp. Later replies get frames only when you cite a timestamp the dossier matches, press "Send frames" on the item, or the roleplay model asks with a &lt;frames t="…"/&gt; tag (those go with your next message, at most K). About K × tokens per frame each time. Audio and video are never re-sent.</small>
                    <small id="video_support_rp_vision_hint" class="video-support-hint" style="display:none"></small>
                </div>
                <div class="video-support-setting">
                    <label>Dossier settings</label>
                    <small class="video-support-hint">Empty boxes inherit: this chat → all chats → default.</small>
                    <div id="video_support_protocol_rows"></div>
                </div>
                <hr>
                <div class="video-support-setting">
                    <input type="button" id="video_support_selftest" class="menu_button" value="Storage self-test" />
                    <small class="video-support-hint">Checks the hash path, a test transcript upload and read-back, chat metadata save/reload and the branch copy trigger. Open a chat first. Writes and removes a small test file and marker.</small>
                    <pre id="video_support_selftest_result" class="video-support-selftest"></pre>
                </div>
            </div>
        </div>
    </div>`;

    $('#extensions_settings2').append(html);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

jQuery(async () => {
    await loadExtensionAPIs();
    loadSettings();
    patchFetch();
    createAttachUI();
    createSettingsUI();
    applySettingsToUI();
    bindSettingsEvents();

    eventSource.on(event_types.MESSAGE_SENT, onMessageSent);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.GENERATION_STARTED, (type, _params, dryRun) => {
        currentGenType = type || 'normal';
        currentGenDryRun = !!dryRun;
    });
    for (const ev of [event_types.GENERATION_ENDED, event_types.GENERATION_STOPPED]) {
        eventSource.on(ev, () => { currentGenType = null; });
    }
    console.log('[VideoSupport] Loaded');
});
