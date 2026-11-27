/**
 * Follow-up questions from the RP model (spec-v2 F instruction, Q10a, Q11a, Q31a, F6, F11, OQ-E7).
 *
 * The RP model writes <media_q item="…" blocking="true|false">question</media_q>.
 * EXT strips these from the shown text, queues the question on the item, and
 * decides when the queue is flushed as one batched requery.
 *
 * Pure module: no SillyTavern imports.
 */

const MEDIA_Q_RE = /<media_q\b([^>]*)>([\s\S]*?)<\/media_q>/gi;
const ATTR_RE = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

/** Jaccard similarity on normalised words at or above which two questions are the same. [I] */
export const DEDUPE_THRESHOLD = 0.8;

function attrs(s) {
    const out = {};
    for (const m of String(s || '').matchAll(ATTR_RE)) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
    return out;
}

/**
 * Parse and strip <media_q> tags.
 * @returns {{text: string, questions: Array<{item: string, blocking: boolean, text: string}>}}
 * `text` is the message with every tag removed and the blank space it left tidied.
 */
export function parseMediaQ(message) {
    const src = String(message ?? '');
    const questions = [];
    for (const m of src.matchAll(MEDIA_Q_RE)) {
        const a = attrs(m[1]);
        const text = m[2].replace(/\s+/g, ' ').trim();
        if (!text) continue;
        questions.push({ item: a.item || '', blocking: String(a.blocking).toLowerCase() === 'true', text });
    }
    const text = src.replace(MEDIA_Q_RE, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return { text, questions };
}

/** Text without tags; a cheap check for callers that only display. */
export function stripMediaQ(message) {
    return parseMediaQ(message).text;
}

export function normalizeWords(s) {
    return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
}

export function similarity(a, b) {
    const A = new Set(normalizeWords(a)), B = new Set(normalizeWords(b));
    if (!A.size && !B.size) return 1;
    let inter = 0;
    for (const w of A) if (B.has(w)) inter++;
    return inter / (A.size + B.size - inter);
}

/**
 * Add questions to an item's pending list, deduping by text similarity. A
 * duplicate keeps the earlier entry and ORs `blocking` into it.
 * @param {Array} pending  existing [{id, text, blocking, asked_at, turn}]
 * @param {Array<{text: string, blocking?: boolean}>} questions
 * @param {{turn: number, now: () => string, id?: () => string}} ctx
 * @returns {{pending: Array, added: number, merged: number}}  a new array; input untouched
 */
export function enqueue(pending, questions, ctx) {
    const out = (pending || []).map(p => ({ ...p }));
    let added = 0, merged = 0;
    let n = out.length;
    for (const q of questions || []) {
        const text = String(q?.text || '').trim();
        if (!text) continue;
        const dup = out.find(p => similarity(p.text, text) >= DEDUPE_THRESHOLD);
        if (dup) {
            if (q.blocking && !dup.blocking) dup.blocking = true;
            merged++;
            continue;
        }
        n++;
        out.push({ id: ctx.id ? ctx.id() : `f${ctx.turn}-${n}`, text, blocking: !!q.blocking, asked_at: ctx.now(), turn: ctx.turn });
        added++;
    }
    return { pending: out, added, merged };
}

/**
 * Resolve the item a <media_q> names. The RP model sees item handles in T0
 * (first 8 hex chars of the media sha256); a full id or a title also matches.
 * Falls back to `fallbackId` (the active item) when the attribute is empty or unknown.
 */
export function resolveItemRef(ref, items, fallbackId = null) {
    const r = String(ref || '').trim().toLowerCase();
    if (r) {
        for (const it of items) {
            if (it.id.toLowerCase() === r || it.id.toLowerCase().startsWith(r) && r.length >= 6) return it.id;
        }
        for (const it of items) if (it.title && it.title.toLowerCase() === r) return it.id;
    }
    return fallbackId;
}

export function itemHandle(itemId) {
    return String(itemId || '').slice(0, 8);
}

/** Does the queue meet the trigger (Q11a: 1 blocking or 3 pending, both settings)? */
export function triggerMet(pending, settings) {
    const p = pending || [];
    const blocking = p.filter(q => q.blocking).length;
    return blocking >= settings.triggerBlocking || p.length >= settings.triggerNonBlocking;
}

/**
 * When to flush an item's queue after an RP turn.
 * - 'auto': coexist mode and RTR reports no eviction (Q10a), at most once per item
 *   per RP turn, and the estimate is within the cap. An empty cap means no cap (OQ-E7);
 *   an unknown estimate passes an empty cap but not a set one.
 * - 'confirm': trigger met but auto is not allowed (swap mode never auto: F6/F11),
 *   so the requery bar offers [Ask now] [Later].
 * - 'none': trigger not met.
 * @returns {{action: 'auto'|'confirm'|'none', reason: string}}
 */
export function decideRequery({ pending, mode, wouldEvict, settings, turn, lastAutoTurn, estimateS }) {
    if (!triggerMet(pending, settings)) return { action: 'none', reason: 'trigger not met' };
    if (mode !== 'coexist') return { action: 'confirm', reason: mode === 'swap' ? 'swap mode is never automatic' : `mode ${mode || 'unknown'}` };
    if (Array.isArray(wouldEvict) && wouldEvict.length) return { action: 'confirm', reason: 'would evict a model' };
    if (lastAutoTurn === turn) return { action: 'confirm', reason: 'already auto-requeried this turn' };
    const cap = settings.autoRequeryCapS;
    if (cap !== '' && cap !== null && cap !== undefined) {
        if (!Number.isFinite(estimateS)) return { action: 'confirm', reason: 'estimate unknown and a cap is set' };
        if (estimateS > Number(cap)) return { action: 'confirm', reason: `estimate ${Math.round(estimateS)} s over cap ${cap} s` };
    }
    return { action: 'auto', reason: 'coexist, no eviction' };
}

/**
 * Q31a piggyback: when a media model is being loaded anyway, flush the queues of
 * other items that use that model. No confirm.
 * @param {Array<{id: string, mediaModel: string, pending: Array}>} items
 * @returns {string[]} item ids
 */
export function piggybackItems(items, mediaModel, excludeId = null) {
    return (items || [])
        .filter(it => it.id !== excludeId && it.mediaModel === mediaModel && (it.pending || []).length > 0)
        .map(it => it.id);
}

function tlKey(e) {
    return `${Number(e.t0)}|${e.kind}|${String(e.text || '').trim().toLowerCase()}`;
}

/**
 * Merge a requery delta into a dossier (summary part; speech lives in the transcript).
 * - answers: replaced by id, new ids appended
 * - timeline_add: non-speech entries merged (exact duplicates dropped), sorted by t0;
 *   speech entries are returned separately for their own transcript file (Q22)
 * - uncertain: union; entries a new answer resolves are kept (EXT cannot tell) [I]
 * @returns {{dossier: object, speech: Array}}  new objects; inputs untouched
 */
export function mergeDelta(dossier, delta) {
    const d = JSON.parse(JSON.stringify(dossier || {}));
    const answers = Array.isArray(d.answers) ? d.answers : [];
    for (const a of delta?.answers || []) {
        if (!a || typeof a.id !== 'string') continue;
        const i = answers.findIndex(x => x?.id === a.id);
        if (i >= 0) answers[i] = { ...a };
        else answers.push({ ...a });
    }
    d.answers = answers;
    const add = Array.isArray(delta?.timeline_add) ? delta.timeline_add : [];
    const speech = add.filter(e => e?.kind === 'speech').map(e => ({ ...e }));
    const timeline = Array.isArray(d.timeline) ? d.timeline : [];
    const seen = new Set(timeline.map(tlKey));
    for (const e of add) {
        if (!e || e.kind === 'speech' || seen.has(tlKey(e))) continue;
        seen.add(tlKey(e));
        timeline.push({ ...e });
    }
    timeline.sort((a, b) => (Number(a.t0) || 0) - (Number(b.t0) || 0));
    d.timeline = timeline;
    const unc = Array.isArray(d.uncertain) ? d.uncertain : [];
    for (const u of delta?.uncertain || []) if (typeof u === 'string' && !unc.includes(u)) unc.push(u);
    d.uncertain = unc;
    return { dossier: d, speech };
}

/** The requeries[] record for one flushed batch. */
export function requeryRecord({ questions, mediaModel, status, at, wallS, trigger, transcript = null }) {
    return {
        at, media_model: mediaModel, status, trigger, wall_s: wallS ?? null,
        questions: (questions || []).map(q => ({ id: q.id, text: q.text, blocking: !!q.blocking })),
        transcript,
    };
}

/** Remove answered questions from the queue; ids not in `answeredIds` stay pending. */
export function removeFlushed(pending, flushedIds) {
    const ids = new Set(flushedIds || []);
    return (pending || []).filter(p => !ids.has(p.id));
}
