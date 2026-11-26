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
