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
 * @param {{t0?: string, t1?: string, t2?: string, handles?: string[]}} tiers
 */
export function injectTiers(body, { t0 = '', t1 = '', t2 = '', handles = [] }) {
    if (!Array.isArray(body?.messages)) return false;
    const msgs = body.messages;
    let added = false;
    const near = [t1, t2, handles.length ? followUpInstruction(handles) : ''].filter(Boolean).join('\n\n');
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

/** Remove any media parts (video/frames/audio) the request may carry (Q26a no-resend). */
export function stripMediaParts(body) {
    if (!Array.isArray(body?.messages)) return 0;
    let n = 0;
    for (const m of body.messages) {
        if (!Array.isArray(m.content)) continue;
        const keep = m.content.filter(p => !['image_url', 'input_video', 'input_audio'].includes(p?.type));
        n += m.content.length - keep.length;
        m.content = keep;
    }
    return n;
}

/** One-line progress / cost text for a preview (estimate + $ + Q3b hint). */
export function progressText(preview, { kind = 'dossier' } = {}) {
    if (!preview) return '';
    const what = kind === 'delta' ? 'Follow-up' : 'Media pass';
    const mode = preview.mode === 'swap' ? 'model swap' : preview.mode === 'solo' ? 'load' : 'no swap';
    const cost = preview.dollars == null ? '' : ` · ${formatDollars(preview.dollars)}`;
    const hint = preview.hint ? ` · ${preview.hint}` : '';
    return `${what} (${mode}): ${preview.estimate?.label ?? ''}${cost}${hint}`;
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
