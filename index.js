/**
 * SillyTavern Video Support Extension for llama.cpp
 *
 * Adds a dedicated video attach button that bypasses ST's media pipeline
 * entirely. Video is injected directly into the API payload as input_video
 * in the fetch rewrite, so ST's image/caption handling never touches it.
 *
 * Video data is persisted in message.extra so previews survive regeneration,
 * swipes, and branch switching. On regeneration the stored video is
 * automatically re-injected into the new generation request.
 *
 * Requires llama.cpp server built with mtmd support and ffmpeg installed.
 */

import { chat, eventSource, event_types, saveChatConditional } from '../../../../script.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {{ dataUrl: string, fileName: string } | null} */
let pendingVideo = null;

let fetchPatched = false;

// ---------------------------------------------------------------------------
// fetch() patch — injects input_video directly into the API payload
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
            const videoDataUrl = pendingVideo?.dataUrl ?? getLastUserVideoFromChat();
            if (videoDataUrl) {
                try {
                    options = injectVideo(options, videoDataUrl);
                } catch (err) {
                    console.error('[VideoSupport] Failed to inject video into request:', err);
                }
            }
        }
        return originalFetch.call(this, url, options);
    };
}

function isGenerationRequest(url) {
    return url.includes('/generate') || url.includes('/chat/completions');
}

/**
 * For regeneration/swipes: find the video stored on the most recent user message.
 */
function getLastUserVideoFromChat() {
    if (!Array.isArray(chat)) return null;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i].is_user && chat[i].extra?.video_url) {
            return chat[i].extra.video_url;
        }
    }
    return null;
}

/**
 * Finds the last user message in the payload and appends an input_video part.
 */
function injectVideo(options, videoDataUrl) {
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

    msg.content.push({ type: 'input_video', input_video: { url: videoDataUrl } });

    console.debug('[VideoSupport] Injected input_video into API payload');

    // Clear pending state — video is now persisted in the chat message extra
    if (pendingVideo) {
        pendingVideo = null;
        $('#video_support_indicator').hide();
    }

    return { ...options, body: JSON.stringify(body) };
}

// ---------------------------------------------------------------------------
// Render video preview inside a message bubble
// ---------------------------------------------------------------------------

function renderPreview(messageId, dataUrl) {
    const msgEl = $(`.mes[mesid="${messageId}"] .mes_text`);
    if (!msgEl.length || msgEl.find('.video-support-preview').length) return;
    const mimeType = dataUrl.split(';')[0].slice(5);
    msgEl.append($(`
        <video class="video-support-preview" controls preload="metadata">
            <source src="${dataUrl}" type="${mimeType}">
        </video>
    `));
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

function onMessageSent(messageId) {
    if (!pendingVideo) return;

    const { dataUrl, fileName } = pendingVideo;

    // Persist in chat message so it survives regeneration and branching
    if (chat[messageId]) {
        if (!chat[messageId].extra) chat[messageId].extra = {};
        chat[messageId].extra.video_url = dataUrl;
        saveChatConditional();
    }

    // Render preview — wait for ST to paint the bubble first
    setTimeout(() => renderPreview(messageId, dataUrl), 500);

    console.debug('[VideoSupport] Saved video to message', messageId, fileName);
}

function onUserMessageRendered(messageId) {
    const msg = chat[messageId];
    if (msg?.extra?.video_url) {
        renderPreview(messageId, msg.extra.video_url);
    }
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
