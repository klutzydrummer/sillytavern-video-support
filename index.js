/**
 * SillyTavern Video Support Extension for llama.cpp
 *
 * Adds a dedicated video attach button that bypasses ST's media pipeline
 * entirely. Video is injected directly into the API payload as input_video
 * in the fetch rewrite, so ST's image/caption handling never touches it.
 *
 * Requires llama.cpp server built with mtmd support and ffmpeg installed.
 */

import { eventSource, event_types } from '../../../../script.js';

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
            pendingVideo !== null &&
            options.body &&
            typeof options.body === 'string' &&
            typeof url === 'string' &&
            url.includes('/chat/completions')
        ) {
            try {
                options = injectVideo(options);
            } catch (err) {
                console.error('[VideoSupport] Failed to inject video into request:', err);
            }
        }
        return originalFetch.call(this, url, options);
    };
}

/**
 * Finds the last user message in the payload and appends an input_video
 * content part. Converts string content to a content array if needed.
 */
function injectVideo(options) {
    const body = JSON.parse(options.body);

    if (!Array.isArray(body.messages)) return options;

    // Find the last user message
    let targetIdx = -1;
    for (let i = body.messages.length - 1; i >= 0; i--) {
        if (body.messages[i].role === 'user') {
            targetIdx = i;
            break;
        }
    }

    if (targetIdx === -1) return options;

    const msg = body.messages[targetIdx];

    // Normalise content to an array
    if (typeof msg.content === 'string') {
        msg.content = [{ type: 'text', text: msg.content }];
    } else if (!Array.isArray(msg.content)) {
        msg.content = [];
    }

    msg.content.push({
        type: 'input_video',
        input_video: { url: pendingVideo.dataUrl },
    });

    console.debug('[VideoSupport] Injected input_video into API payload:', pendingVideo.fileName);

    return { ...options, body: JSON.stringify(body) };
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function createUI() {
    // Hidden file input — completely separate from ST's #img_file
    const fileInput = $('<input>', {
        type: 'file',
        accept: 'video/*',
        id: 'video_support_file_input',
        css: { display: 'none' },
    });
    $('body').append(fileInput);

    // Attach button — placed inside #send_form next to other action buttons
    const btn = $(`
        <div id="video_support_btn" class="fa-solid fa-film" title="Attach video (llama.cpp)"></div>
    `);

    // Indicator shown above the textarea when a video is staged
    const indicator = $(`
        <div id="video_support_indicator" style="display:none;">
            <i class="fa-solid fa-film"></i>
            <span id="video_support_filename"></span>
            <button id="video_support_clear" title="Remove video">&#x2715;</button>
        </div>
    `);

    // Insert button into the send form action area
    $('#send_form').prepend(btn);
    indicator.insertBefore('#send_textarea');

    // Events
    btn.on('click', () => fileInput.trigger('click'));

    fileInput.on('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            pendingVideo = {
                dataUrl: await readAsDataUrl(file),
                fileName: file.name,
            };
            $('#video_support_filename').text(file.name);
            indicator.show();
            console.debug('[VideoSupport] Staged:', file.name, formatBytes(file.size));
        } catch (err) {
            console.error('[VideoSupport] Read failed:', err);
            toastr.error('Could not read video file.', 'Video Support');
        }
        fileInput.val('');
    });

    $(document).on('click', '#video_support_clear', clearVideo);
}

function clearVideo() {
    pendingVideo = null;
    $('#video_support_indicator').hide();
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
    eventSource.on(event_types.MESSAGE_SENT, clearVideo);
    console.log('[VideoSupport] Loaded');
});
