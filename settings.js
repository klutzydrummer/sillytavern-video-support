/**
 * Protocol settings (spec-v2 §1.6; F12, Q11a, Q12b, Q27a, Q28b, OQ-E1, OQ-E7).
 *
 * Resolution is per-chat > global > default. Both layers store only changed keys:
 * a value equal to what it would inherit is removed instead of stored, so a later
 * change to the default or the global value still reaches the chat.
 *
 * Pure module: no SillyTavern imports.
 */

/** chatMetadata key for per-chat overrides (follows branches with chatMetadata). */
export const CHAT_SETTINGS_KEY = 'video_support_settings';

/**
 * One row per setting. `empty: true` means '' is a valid value (no cap / unknown).
 * Defaults are the §1.6 values; the [I] ones are marked in the label hint.
 */
export const SETTINGS_SPEC = [
    { key: 'maxQuestions', label: 'Questions per pass', type: 'int', min: 1, max: 8, def: 8 },
    { key: 'questionMaxTokens', label: 'Question pass output (tokens)', type: 'int', min: 50, max: 4000, def: 400 },
    { key: 'capsuleTokens', label: 'Context capsule to the media model (tokens)', type: 'int', min: 0, max: 4000, def: 600 },
    { key: 'capsuleMessages', label: 'Recent messages in the capsule', type: 'int', min: 0, max: 50, def: 6 },
    { key: 'mmMaxTokensQwen', label: 'First pass output, Qwen (tokens)', type: 'int', min: 100, max: 16000, def: 2500 },
    { key: 'mmMaxTokensLfm3', label: 'First pass output, LFM3 (tokens)', type: 'int', min: 100, max: 16000, def: 1200 },
    { key: 'deltaMaxTokens', label: 'Requery output (tokens)', type: 'int', min: 50, max: 8000, def: 800 },
    { key: 't0PerItem', label: 'T0 per item (tokens)', type: 'int', min: 20, max: 2000, def: 150 },
    { key: 't0Total', label: 'T0 all items (tokens)', type: 'int', min: 50, max: 20000, def: 1200 },
    { key: 't1Tokens', label: 'T1 active item (tokens)', type: 'int', min: 0, max: 8000, def: 900 },
    { key: 't2Tokens', label: 'T2 retrieval per turn (tokens)', type: 'int', min: 0, max: 8000, def: 1500 },
    { key: 'triggerBlocking', label: 'Requery trigger: blocking questions', type: 'int', min: 1, max: 50, def: 1 },
    { key: 'triggerNonBlocking', label: 'Requery trigger: pending questions', type: 'int', min: 1, max: 50, def: 3 },
    { key: 'autoRequeryCapS', label: 'Auto requery estimate cap (s; empty = no cap)', type: 'num', min: 0, max: 3600, def: '', empty: true },
    { key: 'rpFrames', label: 'Key frames to an image-capable RP (K)', type: 'int', min: 0, max: 6, def: 3 },
    { key: 'rpFrameCtx', label: 'RP context for the frame cap (tokens; K × tokens/frame + 4k ≤ this)', type: 'int', min: 0, max: 1048576, def: 8192 },
    { key: 'pricePerHour', label: 'Instance price ($/h; empty = unknown)', type: 'num', min: 0, max: 1000, def: '', empty: true },
];

export const SETTINGS_KEYS = SETTINGS_SPEC.map(s => s.key);
const SPEC_BY_KEY = Object.fromEntries(SETTINGS_SPEC.map(s => [s.key, s]));

export function defaultSettings() {
    return Object.fromEntries(SETTINGS_SPEC.map(s => [s.key, s.def]));
}

/**
 * Normalise one raw value for a key. Returns undefined for an invalid value
 * (callers treat that as "not set"). '' is kept only for `empty` keys.
 */
export function normalizeValue(key, raw) {
    const spec = SPEC_BY_KEY[key];
    if (!spec) return undefined;
    if (raw === '' || raw === null || raw === undefined) return spec.empty ? '' : undefined;
    const n = Number(raw);
    if (!Number.isFinite(n)) return undefined;
    const v = spec.type === 'int' ? Math.round(n) : n;
    return Math.min(spec.max, Math.max(spec.min, v));
}

function layer(obj) {
    const out = {};
    if (!obj || typeof obj !== 'object') return out;
    for (const k of SETTINGS_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
        const v = normalizeValue(k, obj[k]);
        if (v !== undefined) out[k] = v;
    }
    return out;
}

/** Effective settings: per-chat > global > default (OQ-E1). */
export function resolveSettings(global, perChat) {
    return { ...defaultSettings(), ...layer(global), ...layer(perChat) };
}

/** Where each effective value comes from: 'chat' | 'global' | 'default'. */
export function settingSources(global, perChat) {
    const g = layer(global), c = layer(perChat);
    return Object.fromEntries(SETTINGS_KEYS.map(k => [k, k in c ? 'chat' : k in g ? 'global' : 'default']));
}

/**
 * Set a key in one layer, storing only changed keys. `inherited` is the value the
 * layer would get without its own entry. Passing '' for a non-empty key, null or
 * undefined clears the entry. Mutates and returns `target`.
 */
export function setLayerValue(target, key, raw, inherited) {
    if (!SPEC_BY_KEY[key]) throw new Error(`unknown setting ${key}`);
    const spec = SPEC_BY_KEY[key];
    const clear = raw === null || raw === undefined || (raw === '' && !spec.empty);
    const v = clear ? undefined : normalizeValue(key, raw);
    if (v === undefined || v === inherited) delete target[key];
    else target[key] = v;
    return target;
}

/** Global layer: inherits the default. */
export function setGlobal(global, key, raw) {
    return setLayerValue(global, key, raw, defaultSettings()[key]);
}

/** Per-chat layer: inherits global > default. */
export function setChat(perChat, key, raw, global) {
    return setLayerValue(perChat, key, raw, resolveSettings(global, {})[key]);
}

/** Drop unknown, invalid and redundant keys from both layers (e.g. after a default changed). */
export function compactLayers(global, perChat) {
    const g = {};
    for (const [k, v] of Object.entries(layer(global))) setGlobal(g, k, v);
    const c = {};
    for (const [k, v] of Object.entries(layer(perChat))) setChat(c, k, v, g);
    return { global: g, perChat: c };
}

/** View model for the settings table: one row per key. */
export function settingsRows(global, perChat) {
    const eff = resolveSettings(global, perChat);
    const src = settingSources(global, perChat);
    const g = layer(global), c = layer(perChat);
    return SETTINGS_SPEC.map(s => ({
        key: s.key, label: s.label, type: s.type, min: s.min, max: s.max,
        def: s.def, global: k(g, s.key), chat: k(c, s.key), effective: eff[s.key], source: src[s.key],
    }));
    function k(o, key) { return key in o ? o[key] : null; }
}
