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
} from './video-utils.js';

const SETTINGS_KEY = 'videoSupport';

// Dynamic import — extensions.js path varies and static import kills the module silently
let extension_settings, saveSettingsDebounced;
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
    sendAudio: false, // frontend mode only: also send the soundtrack as an input_audio part
    debug: false,
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
            extension_settings[SETTINGS_KEY][k] = v;
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
    $('#video_support_debug').on('change', function () {
        settings().debug = $(this).is(':checked');
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

// ---------------------------------------------------------------------------
// fetch() patch
// ---------------------------------------------------------------------------

function patchFetch() {
    if (fetchPatched) return;
    fetchPatched = true;

    const originalFetch = window.fetch;

    window.fetch = async function (url, options = {}) {
        if (
            options.body &&
            typeof options.body === 'string' &&
            typeof url === 'string' &&
            isMainGenerateUrl(url) &&
            isInjectableGenType(currentGenType, currentGenDryRun) &&
            isCustomSource(options.body)
        ) {
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
        const url = await uploadVideo(dataUrl, fileName);
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
                        Also send the video's audio (frontend mode)
                    </label>
                    <small class="video-support-hint">Decodes the soundtrack in the browser (mono, 16 kHz WAV) and sends it as an input_audio part after the frames. Only for audio-capable models (e.g. LFM3-Omni); other servers may reject it. Adds about 2 MB of base64 per minute.</small>
                </div>
                <div class="video-support-setting">
                    <label class="checkbox_label" for="video_support_debug">
                        <input type="checkbox" id="video_support_debug" />
                        Debug mode
                    </label>
                    <small class="video-support-hint">Log frame sizes to console and show first extracted frame as a preview overlay.</small>
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
    eventSource.on(event_types.GENERATION_STARTED, (type, _params, dryRun) => {
        currentGenType = type || 'normal';
        currentGenDryRun = !!dryRun;
    });
    for (const ev of [event_types.GENERATION_ENDED, event_types.GENERATION_STOPPED]) {
        eventSource.on(ev, () => { currentGenType = null; });
    }
    console.log('[VideoSupport] Loaded');
});
