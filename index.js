/**
 * SillyTavern Video Support Extension for llama.cpp
 *
 * ST's OpenAI-compat pipeline skips video for custom backends
 * (videoInlining=false, default: return false). This extension bridges that:
 *
 *  - extra.media (ST's native format) stores the video — ST handles
 *    persistence, chat saving, and rendering the preview automatically
 *  - fetch rewrite injects input_video into the API payload:
 *    reads pendingVideo for the current send (no MESSAGE_SENT race),
 *    falls back to extra.media on the last user message for regeneration
 *  - pendingVideo is cleared in MESSAGE_SENT after persisting to extra.media,
 *    NOT in the fetch rewrite, so it stays available for the generation fetch
 */

import { chat, eventSource, event_types, saveChatConditional } from '../../../../script.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {{ dataUrl: string, fileName: string } | null} */
let pendingVideo = null;

let fetchPatched = false;

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
            // pendingVideo for current send; extra.media for regeneration
            const videoUrl = pendingVideo?.dataUrl ?? getVideoFromLastUserMessage();
            if (videoUrl) {
                try {
                    options = injectInputVideo(options, videoUrl);
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

function injectInputVideo(options, videoUrl) {
    const body = JSON.parse(options.body);
    if (!Array.isArray(body.messages)) return options;

    let targetIdx = -1;
    for (let i = body.messages.length - 1; i >= 0; i--) {
        if (body.messages[i].role === 'user') { targetIdx = i; break; }
    }
    if (targetIdx === -1) return options;

    const msg = body.messages[targetIdx];
    if (typeof msg.content === 'string') {
        msg.content = [{ type: 'text', text: msg.content }];
    } else if (!Array.isArray(msg.content)) {
        msg.content = [];
    }

    msg.content.push({ type: 'input_video', input_video: { url: videoUrl } });
    console.debug('[VideoSupport] Injected input_video into API payload');

    return { ...options, body: JSON.stringify(body) };
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

    // Clear only after persisting — the generation fetch fires before this
    // and reads pendingVideo directly, so clearing here is safe
    pendingVideo = null;
    $('#video_support_indicator').hide();
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function createUI() {
    const fileInput = $('<input>', {
        type: 'file',
        accept: 'video/*',
        id: 'video_support_file_input',
        css: { display: 'none' },
    });
    $('body').append(fileInput);

    const btn = $(`
        <div id="video_support_btn" class="list-group-item flex-container flexGap5" title="Attach video (llama.cpp)">
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
    patchFetch();
    createUI();
    eventSource.on(event_types.MESSAGE_SENT, onMessageSent);
    console.log('[VideoSupport] Loaded');
});
