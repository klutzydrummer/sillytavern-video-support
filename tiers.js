/**
 * What the RP reply sees (spec-v2 tiers). Media is never re-sent once a dossier exists.
 *
 * T0  every item, ≤ t0PerItem tokens each and ≤ t0Total overall: "processed by" line,
 *     the summary's first 2 sentences, top 3 anticipatory facts, uncertainty count.
 *     Over budget, the oldest items become 1-line stubs; if stubs still overflow,
 *     the oldest stubs are dropped and counted.
 * T1  the active item, ≤ t1Tokens: answers, uncertain, timeline ranked by question match.
 * T2  ≤ t2Tokens: timeline and transcript slices matching the user message's
 *     timestamps or keywords. The transcript comes from the dossier store and is
 *     cached per session by version id.
 *
 * Token counts are chars/4 [I]; nothing here calls a tokenizer.
 *
 * Pure module: no SillyTavern imports.
 */

import { itemHandle, normalizeWords } from './queue.js';

export function tokens(s) {
    return Math.ceil(String(s || '').length / 4);
}

/** Cut text to a token budget on a word boundary, with an ellipsis. */
export function clip(s, maxTokens) {
    const str = String(s || '');
    if (tokens(str) <= maxTokens) return str;
    const maxChars = Math.max(0, maxTokens * 4 - 1);
    const cut = str.slice(0, maxChars);
    const sp = cut.lastIndexOf(' ');
    return (sp > maxChars * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + '…';
}

export function firstSentences(s, n = 2) {
    const parts = String(s || '').replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]+(?:["')\]]+)?|[^.!?]+$/g) || [];
    return parts.slice(0, n).map(p => p.trim()).join(' ');
}

export function fmtTime(t) {
    const s = Math.max(0, Number(t) || 0);
    const m = Math.floor(s / 60), r = s - m * 60;
    return `${m}:${r < 10 ? '0' : ''}${r.toFixed(r % 1 ? 1 : 0)}`;
}

export function processedBy(prov) {
    const model = prov?.model_id || '?';
    const quant = prov?.quant ? ` ${prov.quant}` : '';
    return `processed by ${model}${quant}`;
}

/**
 * @typedef {object} TierItem
 * @property {string} id        media sha256 (item id)
 * @property {string} title
 * @property {number} order     attach order; lower is older
 * @property {object} version   the active dossier version {provenance, dossier}
 * @property {boolean} [stale]
 */

function t0Full(it, perItem) {
    const d = it.version?.dossier || {};
    const unc = Array.isArray(d.uncertain) ? d.uncertain.length : 0;
    const facts = (Array.isArray(d.anticipatory) ? d.anticipatory : []).slice(0, 3);
    const head = `[media ${itemHandle(it.id)} "${it.title || 'untitled'}"; ${processedBy(it.version?.provenance)}${it.stale ? '; STALE' : ''}]`;
    const lines = [head, firstSentences(d.summary, 2)];
    for (const f of facts) lines.push(`- ${f}`);
    if (unc) lines.push(`(${unc} uncertain point${unc === 1 ? '' : 's'})`);
    return clip(lines.filter(Boolean).join('\n'), perItem);
}

function t0Stub(it) {
    return `[media ${itemHandle(it.id)} "${clip(it.title || 'untitled', 12)}"; ${processedBy(it.version?.provenance)}]`;
}

/**
 * @param {TierItem[]} items
 * @param {{t0PerItem: number, t0Total: number}} budget
 * @returns {{text: string, tokens: number, full: string[], stubbed: string[], dropped: string[]}}
 */
export function buildT0(items, { t0PerItem, t0Total }) {
    const list = [...(items || [])].filter(it => it?.version).sort((a, b) => a.order - b.order);
    if (!list.length) return { text: '', tokens: 0, full: [], stubbed: [], dropped: [] };
    const header = 'Media in this chat (dossiers; ask with <media_q> if you need more):';
    const full = list.map(it => t0Full(it, t0PerItem));
    const stub = list.map(t0Stub);
    const mode = list.map(() => 'full');
    const cost = () => tokens(header) + list.reduce((a, _, i) => a + (mode[i] === 'full' ? tokens(full[i]) + 1 : mode[i] === 'stub' ? tokens(stub[i]) + 1 : 0), 0) + droppedLineTokens();
    const droppedLineTokens = () => (mode.includes('drop') ? tokens(droppedLine()) + 1 : 0);
    const droppedLine = () => `(${mode.filter(m => m === 'drop').length} older media items omitted)`;
    // Oldest first: full → stub. Never stub the newest while an older one is full.
    for (let i = 0; i < list.length && cost() > t0Total; i++) mode[i] = 'stub';
    for (let i = 0; i < list.length && cost() > t0Total; i++) mode[i] = 'drop';
    // Dropping may free room: give it back to the newest items, newest first.
    for (let i = list.length - 1; i >= 0 && mode[i] === 'stub'; i--) {
        mode[i] = 'full';
        if (cost() > t0Total) { mode[i] = 'stub'; break; }
    }
    const lines = [header];
    if (mode.includes('drop')) lines.push(droppedLine());
    list.forEach((_, i) => { if (mode[i] === 'full') lines.push(full[i]); else if (mode[i] === 'stub') lines.push(stub[i]); });
    const text = lines.join('\n');
    const pick = m => list.filter((_, i) => mode[i] === m).map(it => it.id);
    return { text, tokens: tokens(text), full: pick('full'), stubbed: pick('stub'), dropped: pick('drop') };
}

/** The active item: the most recent item whose title or handle the message mentions, else the newest. */
export function pickActiveItem(items, userMessage) {
    const list = [...(items || [])].filter(it => it?.version).sort((a, b) => b.order - a.order);
    if (!list.length) return null;
    const msg = String(userMessage || '').toLowerCase();
    const hit = list.find(it => (it.title && msg.includes(it.title.toLowerCase())) || msg.includes(itemHandle(it.id)));
    return hit || list[0];
}

function overlap(a, bSet) {
    let n = 0;
    for (const w of normalizeWords(a)) if (w.length > 2 && bSet.has(w)) n++;
    return n;
}

/**
 * @param {TierItem} item
 * @param {string} userMessage
 * @param {{t1Tokens: number}} budget
 */
export function buildT1(item, userMessage, { t1Tokens }) {
    if (!item?.version || t1Tokens <= 0) return { text: '', tokens: 0 };
    const d = item.version.dossier || {};
    const words = new Set(normalizeWords(userMessage).filter(w => w.length > 2));
    const lines = [`Active media ${itemHandle(item.id)} "${item.title || 'untitled'}" details:`];
    let used = tokens(lines[0]);
    const push = (s) => {
        const t = tokens(s) + 1;
        if (used + t > t1Tokens) return false;
        lines.push(s); used += t; return true;
    };
    const answers = (Array.isArray(d.answers) ? d.answers : []).map((a, i) => ({ a, i, score: overlap(`${a.question || ''} ${a.answer}`, words) }))
        .sort((x, y) => y.score - x.score || x.i - y.i);
    for (const { a } of answers) {
        const conf = Number.isFinite(a.confidence) ? ` (conf ${a.confidence.toFixed(2)})` : '';
        if (!push(`A ${a.id}: ${a.answer}${conf}`)) break;
    }
    for (const u of Array.isArray(d.uncertain) ? d.uncertain : []) if (!push(`Uncertain: ${u}`)) break;
    const tl = (Array.isArray(d.timeline) ? d.timeline : []).map((e, i) => ({ e, i, score: overlap(e.text, words) }))
        .sort((x, y) => y.score - x.score || x.i - y.i);
    for (const { e } of tl) if (!push(timelineLine(e))) break;
    const text = lines.length > 1 ? lines.join('\n') : '';
    return { text, tokens: tokens(text) };
}

function timelineLine(e) {
    const span = Number.isFinite(e.t1) ? `${fmtTime(e.t0)}-${fmtTime(e.t1)}` : fmtTime(e.t0);
    const who = e.speaker ? ` ${e.speaker}:` : '';
    return `[${span}] ${e.kind}${who} ${e.text}`;
}

/** Timestamps in a user message: "1:23", "01:02:03", "at 45s", "45 seconds". Returns seconds. */
export function parseTimestamps(msg) {
    const out = [];
    const s = String(msg || '');
    for (const m of s.matchAll(/\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\.\d+)?\b/g)) {
        out.push((Number(m[1] || 0) * 3600) + Number(m[2]) * 60 + Number(m[3]));
    }
    for (const m of s.matchAll(/\b(\d{1,4})\s*(?:s|sec|secs|seconds?)\b/gi)) out.push(Number(m[1]));
    return [...new Set(out)];
}

/** Window around a timestamp mention (seconds). [I] */
export const T2_WINDOW_S = 10;

/**
 * @param {TierItem[]} items
 * @param {string} userMessage
 * @param {{t2Tokens: number}} budget
 * @param {Map<string, Array>} speechById  item id → speech entries (from the transcript cache)
 */
export function buildT2(items, userMessage, { t2Tokens }, speechById = new Map()) {
    if (t2Tokens <= 0) return { text: '', tokens: 0, hits: 0 };
    const times = parseTimestamps(userMessage);
    const words = new Set(normalizeWords(userMessage).filter(w => w.length > 3));
    if (!times.length && !words.size) return { text: '', tokens: 0, hits: 0 };
    const cands = [];
    for (const it of items || []) {
        if (!it?.version) continue;
        const d = it.version.dossier || {};
        const entries = [...(Array.isArray(d.timeline) ? d.timeline : []), ...(speechById.get(it.id) || [])];
        for (const e of entries) {
            const t0 = Number(e.t0) || 0, t1 = Number.isFinite(e.t1) ? e.t1 : t0;
            const timeHit = times.some(t => t >= t0 - T2_WINDOW_S && t <= t1 + T2_WINDOW_S);
            const kw = overlap(e.text, words);
            if (!timeHit && !kw) continue;
            cands.push({ it, e, score: (timeHit ? 10 : 0) + kw });
        }
    }
    cands.sort((a, b) => b.score - a.score || (a.e.t0 - b.e.t0));
    const header = 'Relevant media moments:';
    const lines = [header];
    let used = tokens(header);
    let hits = 0;
    for (const { it, e } of cands) {
        const line = `${itemHandle(it.id)} ${timelineLine(e)}`;
        const t = tokens(line) + 1;
        if (used + t > t2Tokens) continue;
        lines.push(line); used += t; hits++;
    }
    if (!hits) return { text: '', tokens: 0, hits: 0 };
    const text = lines.join('\n');
    return { text, tokens: tokens(text), hits };
}

/**
 * Transcript cache for one session: version_id → speech (or a badge). Loads each
 * version's speech once through the store's loadSpeech (first pass + requeries).
 * A requery adds speech under the same version_id, so call clear(id) after one.
 */
export function createTranscriptCache(store) {
    const cache = new Map();
    return {
        async get(version) {
            const id = version?.version_id;
            if (!id) return { status: 'not_kept', speech: [] };
            if (!cache.has(id)) cache.set(id, Promise.resolve(store.loadSpeech ? store.loadSpeech(version) : store.loadTranscript(version)).catch(err => ({ status: 'not_on_device', reason: String(err?.message || err) })));
            const r = await cache.get(id);
            return r.status === 'ok' ? r : { ...r, speech: r.speech || [] };
        },
        clear(versionId) { if (versionId) cache.delete(versionId); else cache.clear(); },
        get size() { return cache.size; },
    };
}

/**
 * All tiers for one RP turn. Returns the texts; the glue decides where they go.
 * @returns {Promise<{t0: object, t1: object, t2: object, active: TierItem|null, badges: Map<string,string>}>}
 */
export async function buildTiers(items, userMessage, settings, transcriptCache) {
    const t0 = buildT0(items, settings);
    const active = pickActiveItem(items, userMessage);
    const t1 = buildT1(active, userMessage, settings);
    const speechById = new Map();
    const badges = new Map();
    if (transcriptCache && settings.t2Tokens > 0) {
        for (const it of items || []) {
            if (!it?.version) continue;
            const r = await transcriptCache.get(it.version);
            speechById.set(it.id, r.speech || []);
            if (r.status !== 'ok' && r.badge) badges.set(it.id, r.badge);
        }
    }
    const t2 = buildT2(items, userMessage, settings, speechById);
    return { t0, t1, t2, active, badges };
}
