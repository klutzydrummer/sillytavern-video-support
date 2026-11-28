/**
 * View models and request-body edits for the P6 protocol UI (pure, testable).
 * index.js only turns these into DOM and calls them from ST events.
 *
 * Pure module: no SillyTavern imports.
 */

import { followUpInstruction } from './prompts.js';
import { itemHandle } from './queue.js';
import { dropdownOptions, itemBadges } from './media-models.js';
import { formatDollars } from './estimate.js';
import { rtrExtras } from './rtr-client.js';

export const ROUTING_DOSSIER = 'dossier';
export const ROUTING_DIRECT = 'direct';

/** Routing (Open fork): 'dossier' = P6 protocol, 'direct' = legacy media re-send. Unknown → dossier. */
export function routingMode(globalSettings) {
    return globalSettings?.routing === ROUTING_DIRECT ? ROUTING_DIRECT : ROUTING_DOSSIER;
}

/**
 * Put the tiers into a chat-completions body (Q26a: text only, never media).
 * T0 → a system message right after the leading system block; T1/T2/F → a system
 * message just before the last user message. Mutates and returns whether anything
 * was added. Placement is an Open fork.
 * @param {{messages: Array}} body
 * `frames`: the RP may ask for frames with the <frames> tag (images on and frames toggle on).
 * @param {{t0?: string, t1?: string, t2?: string, handles?: string[], frames?: boolean}} tiers
 */
export function injectTiers(body, { t0 = '', t1 = '', t2 = '', handles = [], frames = false }) {
    if (!Array.isArray(body?.messages)) return false;
    const msgs = body.messages;
    let added = false;
    const near = [t1, t2, handles.length ? followUpInstruction(handles, { frames }) : ''].filter(Boolean).join('\n\n');
    if (near) {
        let i = msgs.length - 1;
        while (i >= 0 && msgs[i].role !== 'user') i--;
        const at = i >= 0 ? i : msgs.length;
        msgs.splice(at, 0, { role: 'system', content: near });
        added = true;
    }
    if (t0) {
        let j = 0;
        while (j < msgs.length && msgs[j].role === 'system' && msgs[j].content !== near) j++;
        msgs.splice(j, 0, { role: 'system', content: t0 });
        added = true;
    }
    return added;
}

/**
 * Short text for the RTR extras on a plan: the coexist set and the GPU's free / needed
 * VRAM. Older RTR reports none of them → ''.
 */
export function rtrExtrasText(plan) {
    const { coSet, gpu } = rtrExtras(plan);
    const bits = [];
    if (coSet) bits.push(`set ${coSet}`);
    if (gpu) {
        const mb = (v) => (Number.isFinite(Number(v)) && v !== null ? `${Math.round(Number(v) / 1024 * 10) / 10} GiB` : '?');
        const vram = gpu.free_mb != null || gpu.need_mb != null ? `${mb(gpu.free_mb)} free / ${mb(gpu.need_mb)} needed` : '';
        const g = [gpu.name || '', vram].filter(Boolean).join(' ');
        if (g) bits.push(g);
    }
    return bits.join(' · ');
}

/** One-line progress / cost text for a preview (estimate + $ + Q3b hint + RTR extras). */
export function progressText(preview, { kind = 'dossier' } = {}) {
    if (!preview) return '';
    const what = kind === 'delta' ? 'Follow-up' : 'Media pass';
    const mode = preview.mode === 'swap' ? 'model swap' : preview.mode === 'solo' ? 'load' : 'no swap';
    const cost = preview.dollars == null ? '' : ` · ${formatDollars(preview.dollars)}`;
    const hint = preview.hint ? ` · ${preview.hint}` : '';
    const extras = rtrExtrasText(preview.plan);
    return `${what} (${mode}): ${preview.estimate?.label ?? ''}${cost}${hint}${extras ? ` · ${extras}` : ''}`;
}

/**
 * Settings hint from RTR's rp_vision (P7 #1). The "accepts images" setting stays the
 * authority: this only suggests ticking it, or warns that RTR sees no projector.
 * @param {{rpVision: boolean|null, rpAcceptsImages: boolean}} s
 * @returns {{text: string, tone: 'info'|'warn'}|null}
 */
export function rpVisionHint({ rpVision, rpAcceptsImages }) {
    if (rpVision === true && !rpAcceptsImages) {
        return { tone: 'info', text: 'RTR reports an image projector on the running roleplay model, so key frames can be sent. Tick "The roleplay model accepts images" to send them.' };
    }
    if (rpVision === false && rpAcceptsImages) {
        return { tone: 'warn', text: 'RTR reports no image projector on the running roleplay model; it may reject frames. Your setting still applies.' };
    }
    return null;
}

/**
 * Requery bar (T-F7): only 'confirm' decisions show it. Auto runs are announced
 * separately; 'none' shows nothing.
 * @returns {{visible: boolean, items: Array<{itemId, title, text, reason}>}}
 */
export function requeryBarModel(decisions, titles = {}) {
    const items = (decisions || []).filter(d => d.action === 'confirm').map(d => ({
        itemId: d.itemId,
        title: titles[d.itemId] || itemHandle(d.itemId),
        reason: d.reason,
        text: `${titles[d.itemId] || itemHandle(d.itemId)}: the roleplay model has questions about this media. ${progressText(d.preview, { kind: 'delta' })}`.trim(),
    }));
    return { visible: items.length > 0, items };
}

/**
 * Item card: handle, title, dropdown and badges.
 * @param {{id: string, item: object, lookup?: object, busy?: object|null, error?: string|null, transcriptBadge?: string|null}} s
 */
export function itemCardModel({ id, item, lookup = null, busy = null, error = null, transcriptBadge = null }) {
    return {
        id,
        handle: itemHandle(id),
        title: item?.title || itemHandle(id),
        options: dropdownOptions(item?.selected_model),
        badges: itemBadges({ lookup, busy, version: item?.versions?.[0] ?? null, transcriptBadge, pending: item?.pending, error }),
        canAsk: !!item?.versions?.length,
        canRegenerate: !!item?.versions?.length,
    };
}

/** Parse the Ask/Regenerate dialog's question box: one question per line. */
export function parseQuestionLines(text, max = 8) {
    return String(text || '').split('\n').map(s => s.trim()).filter(Boolean).slice(0, max);
}
