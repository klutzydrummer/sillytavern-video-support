/**
 * SillyTavern Video Support Extension for llama.cpp
 *
 * Hooks into ST's built-in image/video attachment button (#img_file) to
 * intercept video file selections, then converts ST's internal video format
 * to the input_video content type expected by llama.cpp's multimodal API.
 *
 * Requires llama.cpp server built with mtmd support and ffmpeg installed.
 */

import { chat, eventSource, event_types } from '../../../script.js';

// ---------------------------------------------------------------------------
// Extension state
// ---------------------------------------------------------------------------

/** @type {{ dataUrl: string, mimeType: string, fileName: string } | null} */
let pendingVideo = null;

/** Whether we've already patched window.fetch this session */
let fetchPatched = false;

// ---------------------------------------------------------------------------
// fetch() patch — converts video_url → input_video for llama.cpp
// ---------------------------------------------------------------------------

function patchFetch() {
    if (fetchPatched) return;
    fetchPatched = true;

    const originalFetch = window.fetch;

    window.fetch = async function (url, options = {}) {
        if (
            pendingVideo !== null &&
            options.body &&
            typeof options.body === 'string' &&
            isChatCompletionsEndpoint(url)
        ) {
            try {
                options = rewriteVideoRequest(options);
            } catch (err) {
                console.error('[VideoSupport] Failed to rewrite request:', err);
            }
        }
        return originalFetch.call(this, url, options);
    };
}

function isChatCompletionsEndpoint(url) {
    if (typeof url !== 'string') return false;
    return url.includes('/chat/completions');
}

/**
 * Rewrites the fetch options body, replacing any video_url content parts
 * with the input_video format that llama.cpp expects.
 */
function rewriteVideoRequest(options) {
    const body = JSON.parse(options.body);

    if (!Array.isArray(body.messages)) return options;

    let modified = false;

    body.messages = body.messages.map((msg) => {
        if (!Array.isArray(msg.content)) return msg;

        const newContent = msg.content.map((part) => {
            // ST generates video_url (Gemini format) — convert to input_video (llama.cpp format)
            if (part.type === 'video_url' && part.video_url?.url) {
                modified = true;
                return {
                    type: 'input_video',
                    input_video: { url: part.video_url.url },
                };
            }
            return part;
        });

        return { ...msg, content: newContent };
    });

    if (modified) {
        console.debug('[VideoSupport] Rewrote video_url → input_video in API request');
    }

    return { ...options, body: JSON.stringify(body) };
}

// ---------------------------------------------------------------------------
// generate_interceptor — injects pending video into the last user message
// ---------------------------------------------------------------------------

/**
 * Called by ST before every generation. `chat` is a mutable array of message objects.
 * We inject the pending video into the most recent user message so that ST's
 * prompt-building pipeline picks it up and includes it in the API call.
 */
async function videoSupportInterceptor(chat, contextSize, abort, type) {
    if (!pendingVideo) return;

    const lastUserMsg = [...chat].reverse().find((m) => m.is_user);
    if (!lastUserMsg) return;

    if (!lastUserMsg.extra) lastUserMsg.extra = {};
    if (!Array.isArray(lastUserMsg.extra.media)) lastUserMsg.extra.media = [];

    lastUserMsg.extra.media.push({
        url: pendingVideo.dataUrl,
        type: 'video', // MEDIA_TYPE.VIDEO
        title: pendingVideo.fileName,
        source: 'upload',
    });

    console.debug('[VideoSupport] Injected video into message:', pendingVideo.fileName);
}

window.videoSupportInterceptor = videoSupportInterceptor;

// ---------------------------------------------------------------------------
// Hook into ST's built-in attachment button (#img_file)
// ---------------------------------------------------------------------------

function hookBuiltinAttachment() {
    // ST's caption extension creates #img_file — wait for it to exist
    const target = document.querySelector('#img_file') ?? document.querySelector('#img_form input[type="file"]');

    if (!target) {
        // Caption extension may not have initialised yet; retry after a tick
        setTimeout(hookBuiltinAttachment, 500);
        return;
    }

    // We prepend our listener so it fires before the caption extension's handler.
    // If the file is a video, we consume it ourselves and show the indicator.
    // The caption extension's handler will still fire but returns early for
    // non-Google APIs (isVideoCaptioningAvailable() === false), so no conflict.
    target.addEventListener(
        'change',
        async (e) => {
            const file = e.target.files?.[0];
            if (!file || !file.type.startsWith('video/')) return;

            try {
                const dataUrl = await readFileAsDataUrl(file);
                pendingVideo = { dataUrl, mimeType: file.type, fileName: file.name };
                showIndicator();
                console.debug('[VideoSupport] Staged video via built-in attachment:', file.name, `(${formatBytes(file.size)})`);
            } catch (err) {
                console.error('[VideoSupport] Failed to read video file:', err);
                toastr.error('Failed to read video file.', 'Video Support');
            }
        },
        true, // capture phase — runs before ST's bubble-phase handlers
    );

    console.debug('[VideoSupport] Hooked into built-in attachment input');
}

// ---------------------------------------------------------------------------
// Indicator UI
// ---------------------------------------------------------------------------

function createIndicator() {
    const indicator = $(`
        <div id="video_support_indicator" class="video-support-indicator" style="display:none;">
            <span class="video-support-icon"><i class="fa-solid fa-film"></i></span>
            <span id="video_support_filename" class="video-support-filename"></span>
            <button id="video_support_clear_btn" class="video-support-clear" title="Remove video">
                <i class="fa-solid fa-times"></i>
            </button>
        </div>
    `);

    indicator.insertBefore('#send_textarea');

    $(document).on('click', '#video_support_clear_btn', clearPendingVideo);
}

function showIndicator() {
    $('#video_support_filename').text(pendingVideo?.fileName ?? '');
    $('#video_support_indicator').show();
}

function clearPendingVideo() {
    pendingVideo = null;
    $('#video_support_indicator').hide();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

jQuery(async () => {
    patchFetch();
    createIndicator();
    hookBuiltinAttachment();

    eventSource.on(event_types.MESSAGE_SENT, clearPendingVideo);

    console.log('[VideoSupport] Extension loaded — llama.cpp video support ready');
});
