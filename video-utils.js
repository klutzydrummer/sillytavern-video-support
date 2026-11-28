/**
 * Pure helpers for the Video Support extension (no SillyTavern imports,
 * so they can be unit-tested with plain node: `node --test`).
 */

/** Generation types (from GENERATION_STARTED) that should receive the owning message's video. */
const INJECTABLE_GEN_TYPES = new Set(['normal', 'regenerate', 'swipe', 'continue']);

/** True for ST's main chat-completions generate endpoint only (not other backends' /generate, /status, etc.). */
export function isMainGenerateUrl(url) {
    if (typeof url !== 'string') return false;
    let path;
    try {
        path = new URL(url, 'http://localhost').pathname;
    } catch {
        return false;
    }
    return path.replace(/\/+$/, '').endsWith('/api/backends/chat-completions/generate');
}

/** Generation type '' / undefined means a normal send. dryRun and quiet/impersonate/etc. are excluded. */
export function isInjectableGenType(type, dryRun = false) {
    if (dryRun) return false;
    return INJECTABLE_GEN_TYPES.has(type || 'normal');
}

/**
 * Pick the video that belongs to the current generation: the newest user message
 * in the chat must itself own a video. A later user message without a video
 * means the video is stale and must not be re-sent.
 * @returns {string|null} video url (data URL or uploaded file path)
 */
export function getOwnedVideoUrl(chat) {
    if (!Array.isArray(chat)) return null;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (!chat[i]?.is_user) continue;
        return chat[i].extra?.media?.find(m => m.type === 'video' && m.url)?.url ?? null;
    }
    return null;
}

/** Worst-case prompt tokens for a frame budget. */
export function estimateTokens(frames, tokensPerFrame) {
    return Math.max(0, Math.round(frames)) * Math.max(0, Math.round(tokensPerFrame));
}

/** Human label like "~24.6k tokens (24 frames x 1024)". */
export function formatTokenEstimate(frames, tokensPerFrame) {
    const t = estimateTokens(frames, tokensPerFrame);
    const s = t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t);
    return `up to ~${s} tokens (${frames} frames x ${tokensPerFrame})`;
}

export const DEFAULT_CDN_BASE = 'https://cdn.jsdelivr.net/npm';
const FFMPEG_VERSION = '0.12.15';
const UTIL_VERSION = '0.12.1';
const CORE_VERSION = '0.12.9';

/**
 * Asset URLs for ffmpeg.wasm. The default jsDelivr base uses its '+esm' bundles;
 * any other base is treated as an npm-layout mirror (e.g. self-hosted node_modules
 * folder) and uses the packages' dist/esm files.
 */
export function ffmpegAssetUrls(base = DEFAULT_CDN_BASE) {
    const b = (base || DEFAULT_CDN_BASE).replace(/\/+$/, '');
    const isDefault = b === DEFAULT_CDN_BASE;
    return {
        ffmpegModule: isDefault ? `${b}/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/+esm` : `${b}/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/esm/index.js`,
        utilModule: isDefault ? `${b}/@ffmpeg/util@${UTIL_VERSION}/+esm` : `${b}/@ffmpeg/util@${UTIL_VERSION}/dist/esm/index.js`,
        coreBase: `${b}/@ffmpeg/core@${CORE_VERSION}/dist/esm`,
        ffmpegBase: `${b}/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/esm`,
    };
}

/** 16 kHz is what the audio-capable local models (e.g. LFM3-Omni) expect; mono keeps the payload small. */
export const AUDIO_SAMPLE_RATE = 16000;

/** Encode mono float samples (-1..1) as a 16-bit PCM WAV file. */
export function encodeWav16(samples, rate = AUDIO_SAMPLE_RATE) {
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const v = new DataView(buf);
    const tag = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    tag(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); tag(8, 'WAVE'); tag(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true);
    v.setUint16(34, 16, true); tag(36, 'data'); v.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Uint8Array(buf);
}

/** Base64 of bytes, chunked so large buffers do not overflow the call stack. */
export function bytesToBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
}

/** OpenAI-style input_audio content part (llama-server / llama-swap accept wav or mp3). */
export function makeAudioPart(base64Wav) {
    return { type: 'input_audio', input_audio: { data: base64Wav, format: 'wav' } };
}

/**
 * Append content parts to the newest user message of a chat-completions body object
 * (string content becomes a text part first). Returns the message, or null if there is none.
 */
export function appendPartsToLastUser(body, parts) {
    if (!Array.isArray(body?.messages)) return null;
    for (let i = body.messages.length - 1; i >= 0; i--) {
        const msg = body.messages[i];
        if (msg.role !== 'user') continue;
        if (typeof msg.content === 'string') msg.content = [{ type: 'text', text: msg.content }];
        else if (!Array.isArray(msg.content)) msg.content = [];
        msg.content.push(...parts);
        return msg;
    }
    return null;
}

// ---------------------------------------------------------------------------
// P7: key frames to an image-capable RP (spec-v2 §5, fixed decision 6, Q26a)
// ---------------------------------------------------------------------------

/** Schema D allows up to 6 key_frames. */
export const MAX_KEY_FRAMES = 6;
/** Prompt reserve kept free beside the frames: frames × tokens/frame + 4k ≤ ctx (§5). */
export const FRAME_CTX_RESERVE = 4096;
/** Seconds between a cited timestamp and a key frame for the key frame to be reused. [I] */
export const FRAME_MATCH_WINDOW_S = 10;

function validTime(t) {
    if (t === null || t === undefined || t === '' || typeof t === 'boolean') return null;
    const n = Number(t);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Round to the 0.1 s the caption and cache key use. */
export function roundTime(t) {
    return Math.round(Number(t) * 10) / 10;
}

/** K clamped to 0..6 and to the context budget (frames × tokensPerFrame + reserve ≤ ctx). */
export function framesBudget(k, tokensPerFrame, ctx, reserve = FRAME_CTX_RESERVE) {
    const want = Math.max(0, Math.min(MAX_KEY_FRAMES, Math.floor(Number(k) || 0)));
    const tpf = Math.max(1, Math.round(Number(tokensPerFrame) || 0));
    const c = Number(ctx);
    if (!Number.isFinite(c) || c <= 0) return want;
    return Math.max(0, Math.min(want, Math.floor((c - reserve) / tpf)));
}

/** Longest time the dossier mentions (timeline t0/t1, key_frames t), or null. */
export function dossierDuration(dossier) {
    let max = null;
    const see = (t) => { const v = validTime(t); if (v !== null && (max === null || v > max)) max = v; };
    for (const e of Array.isArray(dossier?.timeline) ? dossier.timeline : []) { see(e?.t0); see(e?.t1); }
    for (const f of Array.isArray(dossier?.key_frames) ? dossier.key_frames : []) see(f?.t);
    return max;
}

/** K uniform times at the centre of K equal slices of the duration; [] when the duration is unknown. */
export function uniformFrameTimes(k, duration) {
    const d = validTime(duration);
    if (!d || k <= 0) return [];
    return Array.from({ length: k }, (_, i) => roundTime(((i + 0.5) * d) / k));
}

/**
 * Top K key frames in the order the media model gave them (most informative first),
 * at most 6, deduped at 0.1 s, past-the-end times dropped when the duration is known.
 * Falls back to uniform times when key_frames is missing or has no usable entry.
 * @returns {Array<{t: number, why: string}>}
 */
export function selectFrameTimes(keyFrames, k, durationHint = null) {
    const n = Math.max(0, Math.min(MAX_KEY_FRAMES, Math.floor(Number(k) || 0)));
    if (!n) return [];
    const d = validTime(durationHint);
    const out = [];
    const seen = new Set();
    for (const f of (Array.isArray(keyFrames) ? keyFrames : []).slice(0, MAX_KEY_FRAMES)) {
        const t = validTime(f?.t);
        if (t === null || (d !== null && t > d)) continue;
        const r = roundTime(t);
        if (seen.has(r)) continue;
        seen.add(r);
        out.push({ t: r, why: String(f?.why || '').trim() });
        if (out.length >= n) break;
    }
    if (out.length) return out;
    return uniformFrameTimes(n, d).map(t => ({ t, why: '' }));
}

/** Caption `why` for frames the RP asked for with a <frames> tag. */
export const REQUESTED_WHY = 'requested by the roleplay model';

/**
 * Explicit times from a <frames> tag (P7 #6 option C), clamped to the frame budget:
 * at most K (≤ 6), deduped at 0.1 s, past-the-end times dropped when the duration is known.
 * @returns {Array<{t: number, why: string}>}
 */
export function requestedFrameTimes(times, k, durationHint = null) {
    const n = Math.max(0, Math.min(MAX_KEY_FRAMES, Math.floor(Number(k) || 0)));
    const d = validTime(durationHint);
    const out = [];
    const seen = new Set();
    for (const raw of Array.isArray(times) ? times : []) {
        if (out.length >= n) break;
        const t = validTime(raw);
        if (t === null || (d !== null && t > d)) continue;
        const r = roundTime(t);
        if (seen.has(r)) continue;
        seen.add(r);
        out.push({ t: r, why: REQUESTED_WHY });
    }
    return out;
}

/** Most automatic follow-up generations after <frames/> tags per user message (Fold 7: capped auto-continue). */
export const AUTO_CONTINUE_MAX = 2;

/**
 * Whether an RP reply's resolved <frames/> tags start an automatic follow-up generation
 * that carries those frames. `count` = auto-continues already done since the last real
 * user message (the caller resets it to 0 on MESSAGE_SENT).
 * @param {{ resolved: number, framesOn: boolean, count: number, genType?: string|null, dryRun?: boolean, max?: number }} a
 * @returns {{ fire: boolean, count: number, why: string }}
 */
export function decideAutoContinue(a) {
    const count = Math.max(0, Number(a.count) || 0);
    const max = a.max ?? AUTO_CONTINUE_MAX;
    if (!(a.resolved > 0)) return { fire: false, count, why: 'no resolved tag' };
    if (!a.framesOn) return { fire: false, count, why: 'frames off' };
    if (!isInjectableGenType(a.genType, !!a.dryRun)) return { fire: false, count, why: 'not a chat reply' };
    if (count >= max) return { fire: false, count, why: 'cap reached' };
    return { fire: true, count: count + 1, why: 'frames requested' };
}

/** Caption sent as text before each frame: "t=12.0 s: why". */
export function frameCaption(t, why = '') {
    const w = String(why || '').trim();
    return `t=${roundTime(t).toFixed(1)} s${w ? `: ${w}` : ''}`;
}

/**
 * Which frames this RP turn gets (§5). Returns [] unless the RP takes images and the
 * toggle is on. The reply to the message that owns the media (incl. regenerate/swipe)
 * gets the selected frames; later turns only on a user request, or when the user
 * cites a timestamp that a T2 slice matched (then the nearest key frame, else that time).
 * `requested` (from the RP's <frames> tag, already clamped) wins over the user's
 * button and timestamps, but not over the reply right after processing.
 * @param {{rpImages: boolean, enabled: boolean, k: number, selected: Array<{t:number, why:string}>,
 *   replyToMedia?: boolean, userAsked?: boolean, requested?: Array<{t:number, why:string}>,
 *   citedTimes?: number[], t2Hits?: number}} a
 * @returns {{reason: 'off'|'first'|'requested'|'asked'|'t2'|'none', frames: Array<{t:number, why:string}>}}
 */
export function decideFramesForTurn(a) {
    if (!a?.rpImages || !a.enabled) return { reason: 'off', frames: [] };
    const k = Math.max(0, Math.min(MAX_KEY_FRAMES, Math.floor(Number(a.k) || 0)));
    const sel = (a.selected || []).slice(0, k);
    if (!k) return { reason: 'none', frames: [] };
    if (a.replyToMedia) return { reason: 'first', frames: sel };
    if (a.requested?.length) return { reason: 'requested', frames: a.requested.slice(0, k) };
    if (a.userAsked) return { reason: 'asked', frames: sel };
    const cited = (a.citedTimes || []).map(validTime).filter(t => t !== null);
    if (cited.length && (a.t2Hits || 0) > 0) {
        const out = [];
        const seen = new Set();
        for (const c of cited) {
            let best = null;
            for (const f of a.selected || []) {
                const dist = Math.abs(f.t - c);
                if (dist <= FRAME_MATCH_WINDOW_S && (!best || dist < best.dist)) best = { f, dist };
            }
            const pick = best ? best.f : { t: roundTime(c), why: 'cited in chat' };
            if (seen.has(pick.t)) continue;
            seen.add(pick.t);
            out.push(pick);
            if (out.length >= k) break;
        }
        return { reason: 't2', frames: out };
    }
    return { reason: 'none', frames: [] };
}

/** Content parts for the RP: caption text, then the image_url, per frame. */
export function buildFrameParts(frames) {
    const parts = [];
    for (const f of frames || []) {
        if (!f?.url) continue;
        parts.push({ type: 'text', text: frameCaption(f.t, f.why) });
        parts.push({ type: 'image_url', image_url: { url: f.url } });
    }
    return parts;
}

/** ffmpeg args for one JPEG at time t (fast input seek). */
export function frameAtArgs(t, { maxDimension = 512, qscale = 10, input = 'input.mp4', output = 'at.jpg' } = {}) {
    return ['-ss', roundTime(t).toFixed(1), '-i', input, '-frames:v', '1', '-vf', `scale=${maxDimension}:-2`, '-q:v', String(qscale), output];
}

/**
 * Client-side frame cache keyed by (media hash, t at 0.1 s), LRU by entry.
 * getOrExtract calls the injected extract(times) only for the missing times.
 */
export function createKeyFrameCache({ maxEntries = 24 } = {}) {
    const map = new Map();
    const key = (hash, t) => `${hash}@${roundTime(t).toFixed(1)}`;
    function get(hash, t) {
        const k = key(hash, t);
        if (!map.has(k)) return undefined;
        const v = map.get(k);
        map.delete(k); map.set(k, v);
        return v;
    }
    function set(hash, t, url) {
        const k = key(hash, t);
        map.delete(k);
        while (map.size >= maxEntries) map.delete(map.keys().next().value);
        map.set(k, url);
    }
    /**
     * @param {string} hash
     * @param {number[]} times
     * @param {(times: number[]) => Promise<Array<string|null>>} extract  one data URL (or null) per time
     * @returns {Promise<{urls: Array<string|null>, hits: number, misses: number}>}
     */
    async function getOrExtract(hash, times, extract) {
        const urls = times.map(t => get(hash, t));
        const missing = times.filter((_, i) => urls[i] === undefined);
        if (missing.length) {
            const got = await extract(missing);
            let j = 0;
            for (let i = 0; i < times.length; i++) {
                if (urls[i] !== undefined) continue;
                const u = got?.[j++] ?? null;
                urls[i] = u;
                if (u) set(hash, times[i], u);
            }
        }
        return { urls, hits: times.length - missing.length, misses: missing.length };
    }
    return { get, set, getOrExtract, clear: () => map.clear(), has: (h, t) => map.has(key(h, t)), get size() { return map.size; } };
}
