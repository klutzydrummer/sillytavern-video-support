/**
 * SillyTavern Video Support Extension for llama.cpp
 *
 * ST's OpenAI-compat pipeline explicitly skips video (videoInlining=false
 * for custom backends), so this extension bridges the gap:
 *
 *  - Attaches video to messages via extra.media (ST's native format) so
 *    persistence, saving, and branch/swipe handling come for free
 *  - Renders <video> previews via USER_MESSAGE_RENDERED since ST doesn't
 *    render video for non-Gemini backends
 *  - Injects input_video into the API payload via a fetch rewrite, reading
 *    from extra.media on the last user message
 */

import { chat, eventSource, event_types, saveChatConditional } from '../../../../script.js';

// ---------------------------------------------------------------------------
// State — only held until MESSAGE_SENT moves it into extra.media
// ---------------------------------------------------------------------------

/** @type {{ dataUrl: string, fileName: string } | null} */
let pendingVideo = null;

let fetchPatched = false;

// ---------------------------------------------------------------------------
// fetch() patch — bridges extra.media → input_video for llama.cpp
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
            const videoUrl = getVideoFromLastUserMessage();
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

/** Read video from extra.media on the most recent user message. */
function getVideoFromLastUserMessage() {
    if (!Array.isArray(chat)) return null;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (!chat[i].is_user) continue;
        const video = chat[i].extra?.media?.find(m => m.type === 'video');
        if (video?.url) return video.url;
    }
    return null;
}

/** Append an input_video part to the last user message in the request body. */
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
// Message events
// ---------------------------------------------------------------------------

/** On send: move pendingVideo into extra.media and persist. */
async function onMessageSent(messageId) {
    if (!pendingVideo) return;

    const msg = chat[messageId];
    if (!msg) return;

    if (!msg.extra) msg.extra = {};
    if (!Array.isArray(msg.extra.media)) msg.extra.media = [];

    msg.extra.media.push({
        type: 'video',
        url: pendingVideo.dataUrl,
        title: pendingVideo.fileName,
        source: 'upload',
    });

    pendingVideo = null;
    $('#video_support_indicator').hide();

    await saveChatConditional();
    console.debug('[VideoSupport] Saved video to message', messageId);
}

/**
 * On render: draw <video> for any message that has video in extra.media.
 * ST doesn't render video for custom OpenAI backends, so we do it here.
 */
function onUserMessageRendered(messageId) {
    const msg = chat[messageId];
    const video = msg?.extra?.media?.find(m => m.type === 'video');
    if (!video?.url) return;

    const container = $(`.mes[mesid="${messageId}"] .mes_text`);
    if (!container.length || container.find('.video-support-preview').length) return;

    const mimeType = video.url.split(';')[0].slice(5);
    container.append($(`
        <video class="video-support-preview" controls preload="metadata">
            <source src="${video.url}" type="${mimeType}">
        </video>
    `));
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
    eventSource.on(event_types.USER_MESSAGE_RENDERED, onUserMessageRendered);
    console.log('[VideoSupport] Loaded');
});
