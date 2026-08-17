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

import { chat, eventSource, event_types, saveChatConditional } from '../../../../script.js';

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
    fps: 2,
    maxDimension: 512,
    maxFrames: 128,
    jpegQuality: 0.7,
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
    toggleFrontendOptions();
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
        settings().fps = Math.max(0.5, Math.min(30, Number($(this).val())));
        saveSettingsDebounced();
    });
    $('#video_support_max_dimension').on('input', function () {
        settings().maxDimension = Math.max(128, Math.min(2048, Number($(this).val())));
        saveSettingsDebounced();
    });
    $('#video_support_max_frames').on('input', function () {
        settings().maxFrames = Math.max(1, Math.min(512, Number($(this).val())));
        saveSettingsDebounced();
    });
    $('#video_support_jpeg_quality').on('input', function () {
        settings().jpegQuality = Math.max(0.1, Math.min(1.0, Number($(this).val())));
        saveSettingsDebounced();
    });
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {{ dataUrl: string, fileName: string } | null} */
let pendingVideo = null;

let fetchPatched = false;

// ---------------------------------------------------------------------------
// Frame extraction (frontend mode)
// ---------------------------------------------------------------------------

/**
 * Extract JPEG frames from a video data URL using <video> + <canvas>.
 * Returns an array of base64 data URL strings.
 */
async function extractFrames(videoDataUrl) {
    const { fps, maxDimension, maxFrames, jpegQuality } = settings();

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
    video.src = videoDataUrl;
    document.body.appendChild(video);

    try {
        await new Promise((resolve, reject) => {
            video.onloadeddata = resolve;
            video.onerror = () => reject(new Error('Failed to load video'));
        });

        const duration = video.duration;
        const interval = 1 / fps;
        const totalPossible = Math.floor(duration * fps);
        const frameCount = Math.min(totalPossible, maxFrames);

        if (frameCount <= 0) {
            console.warn('[VideoSupport] No frames to extract');
            return [];
        }

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        const scale = Math.min(1, maxDimension / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);

        // Play the video at max speed and capture frames at the right
        // timestamps. This avoids seeking entirely — seeking is the root
        // cause of black frames because the decoder doesn't always produce
        // a frame on seek for non-keyframe positions.
        const frames = [];
        const targetTimes = Array.from({ length: frameCount }, (_, i) => i * interval);

        await new Promise((resolve) => {
            let idx = 0;
            video.playbackRate = 16; // fast as possible

            function onFrame() {
                if (idx >= targetTimes.length) {
                    video.pause();
                    resolve();
                    return;
                }
                if (video.currentTime >= targetTimes[idx]) {
                    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                    frames.push(canvas.toDataURL('image/jpeg', jpegQuality));
                    idx++;
                }
                if ('requestVideoFrameCallback' in video) {
                    video.requestVideoFrameCallback(onFrame);
                } else {
                    requestAnimationFrame(onFrame);
                }
            }

            video.currentTime = 0;
            video.onseeked = () => {
                if ('requestVideoFrameCallback' in video) {
                    video.requestVideoFrameCallback(onFrame);
                } else {
                    requestAnimationFrame(onFrame);
                }
                video.play();
            };
        });

        console.debug(`[VideoSupport] Extracted ${frames.length} frames (${canvas.width}x${canvas.height}, ${fps} fps, q=${jpegQuality})`);
        return frames;
    } finally {
        video.pause();
        video.removeAttribute('src');
        video.load();
        video.remove();
    }

    console.debug(`[VideoSupport] Extracted ${frames.length} frames (${canvas.width}x${canvas.height}, ${fps} fps, q=${jpegQuality})`);
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
            isGenerationRequest(url)
        ) {
            const videoUrl = pendingVideo?.dataUrl ?? getVideoFromLastUserMessage();
            if (videoUrl) {
                try {
                    if (settings().mode === 'frontend') {
                        const frames = await extractFrames(videoUrl);
                        if (frames.length > 0) {
                            options = injectFrames(options, frames);
                        }
                    } else {
                        options = injectInputVideo(options, videoUrl);
                    }
                } catch (err) {
                    console.error('[VideoSupport] Failed to inject video:', err);
                }
            }
        }
        return originalFetch.call(this, url, options);
    };
}

function isGenerationRequest(url) {
    return url.includes('/generate') || url.includes('/chat/completions');
}

function getVideoFromLastUserMessage() {
    if (!Array.isArray(chat)) return null;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (!chat[i].is_user) continue;
        const video = chat[i].extra?.media?.find(m => m.type === 'video');
        if (video?.url) return video.url;
    }
    return null;
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
        msg.extra.media.push({ type: 'video', url: dataUrl, title: fileName, source: 'upload' });
        await saveChatConditional();
        console.debug('[VideoSupport] Saved video to message', messageId);
    }

    pendingVideo = null;
    $('#video_support_indicator').hide();
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
                        <input type="number" id="video_support_fps" class="text_pole" min="0.5" max="30" step="0.5" />
                        <small class="video-support-hint">Lower = fewer frames, faster. 2 recommended.</small>
                    </div>
                    <div class="video-support-setting">
                        <label for="video_support_max_dimension">Max frame dimension (px)</label>
                        <input type="number" id="video_support_max_dimension" class="text_pole" min="128" max="2048" step="64" />
                        <small class="video-support-hint">Longest side of each frame.</small>
                    </div>
                    <div class="video-support-setting">
                        <label for="video_support_max_frames">Max frames</label>
                        <input type="number" id="video_support_max_frames" class="text_pole" min="1" max="512" step="1" />
                    </div>
                    <div class="video-support-setting">
                        <label for="video_support_jpeg_quality">JPEG quality</label>
                        <input type="number" id="video_support_jpeg_quality" class="text_pole" min="0.1" max="1.0" step="0.05" />
                        <small class="video-support-hint">0.1 = smallest, 1.0 = best quality. 0.7 is a good balance.</small>
                    </div>
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
    console.log('[VideoSupport] Loaded');
});
