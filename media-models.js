/**
 * Media model catalog, per-item dropdown and badge view models (F3a, F14, F15, OQ-B4, OQ-E3).
 *
 * F15=c: there is no omni RP path; every item goes through a media model.
 * "Qwen (auto)" resolves to Q8 (F3a).
 * LS ids follow models.json keys in vastai-llmrunner [U: check against the live
 * llama-swap config before relying on them].
 *
 * Pure module: no SillyTavern imports.
 */

import { BADGE_NOT_KEPT, BADGE_NOT_ON_DEVICE } from './dossier-store.js';

export const MEDIA_MODELS = [
    { key: 'qwen-auto', label: 'Qwen (auto)', alias: 'qwen-q8' },
    { key: 'qwen-q8', label: 'Qwen3-Omni Q8', lsId: 'Qwen3-Omni-30B-A3B-Instruct-Q8_0', modelId: 'Qwen3-Omni-30B-A3B-Instruct', quant: 'Q8_0', family: 'qwen' },
    { key: 'qwen-q4', label: 'Qwen3-Omni Q4 (coexist)', lsId: 'Qwen3-Omni-30B-A3B-Instruct-Q4_K_M', modelId: 'Qwen3-Omni-30B-A3B-Instruct', quant: 'Q4_K_M', family: 'qwen' },
    { key: 'lfm3', label: 'LFM3-Omni 2B', lsId: 'LFM3-Omni-2B-Q8_0', modelId: 'LFM3-Omni-2B', quant: 'Q8_0', family: 'lfm3' },
    { key: 'lfm3-rp', label: 'LFM3-Omni 2B RP', lsId: 'LFM3-Omni-2B-RP-Q8_0', modelId: 'LFM3-Omni-2B-RP', quant: 'Q8_0', family: 'lfm3' },
];

export const DEFAULT_MEDIA_MODEL = 'qwen-auto';
const BY_KEY = Object.fromEntries(MEDIA_MODELS.map(m => [m.key, m]));

/** Resolve a dropdown key (aliases followed) to a concrete model, or null. */
export function resolveMediaModel(key) {
    let m = BY_KEY[key] || BY_KEY[DEFAULT_MEDIA_MODEL];
    for (let i = 0; m?.alias && i < 4; i++) m = BY_KEY[m.alias];
    return m && m.lsId ? m : null;
}

export function modelByLsId(lsId) {
    return MEDIA_MODELS.find(m => m.lsId === lsId) || null;
}

/** First-pass output cap by family (Q27a). */
export function mmMaxTokens(model, settings) {
    return model?.family === 'lfm3' ? settings.mmMaxTokensLfm3 : settings.mmMaxTokensQwen;
}

/** Dropdown view model. */
export function dropdownOptions(selectedKey) {
    const sel = BY_KEY[selectedKey] ? selectedKey : DEFAULT_MEDIA_MODEL;
    return MEDIA_MODELS.map(m => ({
        value: m.key,
        label: m.alias ? `${m.label} → ${BY_KEY[m.alias].label}` : m.label,
        selected: m.key === sel,
    }));
}

/**
 * Badge view model for an item.
 * @param {{lookup?: {status: 'hit'|'stale'|'miss'}, busy?: {label: string}|null, version?: object|null,
 *   transcriptBadge?: string|null, pending?: Array, error?: string|null}} s
 * @returns {Array<{text: string, tone: 'neutral'|'good'|'warn'|'bad'|'info', title?: string}>}
 */
export function itemBadges(s) {
    const out = [];
    if (s.busy) out.push({ text: s.busy.label || 'working…', tone: 'info' });
    if (s.error) out.push({ text: 'failed', tone: 'bad', title: s.error });
    const v = s.version;
    if (v) {
        const p = v.provenance || {};
        const m = modelByLsId(`${p.model_id}-${p.quant}`);
        out.push({ text: m ? m.label : `${p.model_id || '?'} ${p.quant || ''}`.trim(), tone: 'good', title: `dossier ${p.created || ''}` });
        if (p.status && p.status !== 'ok') out.push({ text: p.status, tone: 'warn' });
    } else if (!s.busy && !s.error) {
        out.push({ text: 'no dossier', tone: 'neutral' });
    }
    // F14: a soft-key mismatch is shown, never silently reused or dropped.
    if (s.lookup?.status === 'stale') out.push({ text: 'stale', tone: 'warn', title: 'Media model projector changed since this dossier; Regenerate to refresh.' });
    if (s.transcriptBadge === BADGE_NOT_KEPT) out.push({ text: BADGE_NOT_KEPT, tone: 'warn' });
    if (s.transcriptBadge === BADGE_NOT_ON_DEVICE) out.push({ text: BADGE_NOT_ON_DEVICE, tone: 'warn' });
    const n = (s.pending || []).length;
    if (n) out.push({ text: `${n} question${n === 1 ? '' : 's'} pending`, tone: (s.pending || []).some(q => q.blocking) ? 'warn' : 'neutral' });
    return out;
}

/** The three Regenerate choices (F10): one dialog. */
export const REGEN_CHOICES = [
    { value: 'same', label: 'Same model, fresh pass' },
    { value: 'model', label: 'Different model' },
    { value: 'questions', label: 'Ask extra questions' },
];
