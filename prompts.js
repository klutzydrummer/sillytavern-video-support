/**
 * Prompts Q (question pass), E (media extraction) and F (follow-up instruction)
 * and the message builders around them (spec-v2 protocol).
 *
 * PROMPT_VERSION is part of the dossier hard key (dossier-store HARD_KEY_PARTS):
 * change it whenever Q or E text changes, so old dossiers stop matching.
 *
 * Pure module: no SillyTavern imports.
 */

import { tokens, clip, fmtTime } from './tiers.js';
import { itemHandle } from './queue.js';

export const PROMPT_VERSION = 'p6-1';

export const MAX_QUESTIONS = 8;

/** JSON schema for the question pass (sent through generateRaw's jsonSchema). */
export const QUESTION_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['questions', 'needs_for_next_reply'],
    properties: {
        questions: {
            type: 'array', maxItems: MAX_QUESTIONS,
            items: { type: 'object', additionalProperties: false, required: ['id', 'text'],
                properties: { id: { type: 'string' }, text: { type: 'string' } } },
        },
        needs_for_next_reply: { type: 'string' },
    },
};

export const PROMPT_Q = [
    'The user just attached a media file to the roleplay. You cannot see or hear it; a separate media model will watch it and answer for you.',
    `Write up to {max} short, concrete questions whose answers you need to continue the scene well: who and what is shown, what is said, tone, actions, details the user is likely to refer to.`,
    'Also say in one sentence what you most need for your next reply.',
    'Answer only with JSON: {"questions":[{"id":"q1","text":"..."}],"needs_for_next_reply":"..."}',
].join('\n');

export const PROMPT_E = [
    'You are a media analyst preparing a dossier for a roleplay model that cannot see or hear this media.',
    'Describe only what is in the media. Never invent; put anything you are unsure of in "uncertain", and things asked about but absent in "not_in_media".',
    'Timestamps are seconds from the start. Timeline kinds: speech for every spoken line (verbatim, with speaker), plus visual, action, sound, music and text-on-screen entries.',
    'summary: at most 600 characters, the most important first. anticipatory: facts the roleplay is likely to need next.',
    'Answer each listed question by its id with a confidence from 0 to 1 and evidence timestamps.',
    'Reply only with JSON matching the schema.',
].join('\n');

export const PROMPT_DELTA = [
    'You are answering follow-up questions about the same media for a roleplay model that cannot see or hear it.',
    'Answer each question by its id with confidence 0 to 1 and evidence timestamps. Add timeline entries only for moments the questions need and the earlier summary lacks.',
    'Never invent; list what you cannot tell in "uncertain".',
    'Reply only with JSON: {"answers":[...],"timeline_add":[...],"uncertain":[...]}',
].join('\n');

/** F: appended to the RP prompt while any item has a dossier. */
export function followUpInstruction(handles) {
    const list = (handles || []).map(h => `"${h}"`).join(', ');
    return [
        'If you need something about attached media that the dossier does not say, ask the media model by writing',
        '<media_q item="ID" blocking="true|false">your question</media_q>',
        `anywhere in your reply (ID is one of ${list || 'the media ids above'}). It is hidden from the user.`,
        'Use blocking="true" only when you cannot continue the scene well without the answer. Never guess at media details instead.',
    ].join(' ');
}

export function questionPrompt(maxQuestions = MAX_QUESTIONS, title = '') {
    const q = PROMPT_Q.replace('{max}', String(Math.min(MAX_QUESTIONS, Math.max(1, maxQuestions))));
    return title ? `${q}\nAttached file: "${title}".` : q;
}

function tryJson(text) {
    if (text && typeof text === 'object') return text;
    const s = String(text || '');
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    const cands = [s.trim(), fence?.[1]?.trim()];
    const i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i >= 0 && j > i) cands.push(s.slice(i, j + 1));
    for (const c of cands) {
        if (!c) continue;
        try { const v = JSON.parse(c); if (v && typeof v === 'object') return v; } catch { /* next */ }
    }
    return null;
}

/**
 * Parse the RP model's question pass. Tolerates fences and plain-string questions;
 * clamps to `max`, drops empties and duplicates, renumbers missing ids.
 * @returns {{questions: Array<{id: string, text: string}>, needs: string, ok: boolean}}
 */
export function parseQuestionPass(raw, max = MAX_QUESTIONS) {
    const v = tryJson(raw);
    if (!v) return { questions: [], needs: '', ok: false };
    const seen = new Set();
    const questions = [];
    for (const q of Array.isArray(v.questions) ? v.questions : []) {
        const text = String(typeof q === 'string' ? q : q?.text ?? '').replace(/\s+/g, ' ').trim();
        if (!text || seen.has(text.toLowerCase())) continue;
        seen.add(text.toLowerCase());
        questions.push({ id: '', text });
        if (questions.length >= Math.min(max, MAX_QUESTIONS)) break;
    }
    questions.forEach((q, i) => { q.id = `q${i + 1}`; });
    return { questions, needs: String(v.needs_for_next_reply || '').trim(), ok: true };
}

/**
 * Context capsule (≤ capsuleTokens): character card essentials and the last K
 * messages, newest kept when cutting. Never includes media.
 * @param {{charName?: string, charDescription?: string, userName?: string,
 *   messages: Array<{name: string, text: string}>, needs?: string}} ctx
 */
export function buildCapsule(ctx, { capsuleTokens, capsuleMessages }) {
    if (capsuleTokens <= 0) return '';
    const head = [];
    if (ctx.charName) head.push(`Roleplay character: ${ctx.charName}.`);
    if (ctx.charDescription) head.push(clip(ctx.charDescription, Math.floor(capsuleTokens / 4)));
    if (ctx.needs) head.push(`The roleplay model most needs: ${ctx.needs}`);
    const msgs = (ctx.messages || []).slice(-Math.max(0, capsuleMessages));
    const lines = [];
    let used = tokens(head.join('\n')) + 4;
    // Newest first so the most recent messages survive the cut.
    for (let i = msgs.length - 1; i >= 0; i--) {
        const line = `${msgs[i].name}: ${String(msgs[i].text || '').replace(/\s+/g, ' ').trim()}`;
        const budget = capsuleTokens - used;
        if (budget <= 8) break;
        const l = tokens(line) + 1 > budget ? clip(line, budget - 1) : line;
        lines.unshift(l);
        used += tokens(l) + 1;
    }
    const body = [...head, lines.length ? 'Recent chat:' : '', ...lines].filter(Boolean).join('\n');
    return clip(body, capsuleTokens);
}

/**
 * Media parts for the RTR media call. Frames are interleaved with timestamp text
 * parts so the model can date what it sees; audio goes last.
 * @param {{mode: 'frontend'|'backend', frames?: string[], fps?: number, audioB64?: string|null,
 *   videoUrl?: string}} m
 */
export function buildMediaParts(m) {
    if (m.mode === 'backend' && m.videoUrl) return [{ type: 'input_video', input_video: { url: m.videoUrl } }];
    const parts = [];
    const fps = Number(m.fps) > 0 ? Number(m.fps) : 1;
    (m.frames || []).forEach((url, i) => {
        parts.push({ type: 'text', text: `[t=${fmtTime(i / fps)}]` });
        parts.push({ type: 'image_url', image_url: { url } });
    });
    if (m.audioB64) parts.push({ type: 'input_audio', input_audio: { data: m.audioB64, format: 'wav' } });
    return parts;
}

function questionList(questions) {
    return (questions || []).map(q => `${q.id}: ${q.text}`).join('\n');
}

/** Messages for the first pass (kind "dossier"). */
export function extractionMessages({ capsule, mediaParts, questions, checklist = [], title = '' }) {
    const user = [
        ...(title ? [{ type: 'text', text: `File: "${title}"` }] : []),
        ...mediaParts,
        ...(capsule ? [{ type: 'text', text: `Roleplay context (for relevance only; describe the media, not this):\n${capsule}` }] : []),
        { type: 'text', text: `Questions:\n${questionList(questions) || '(none; give a general dossier)'}` },
        ...(checklist.length ? [{ type: 'text', text: `Also cover:\n- ${checklist.join('\n- ')}` }] : []),
    ];
    return [{ role: 'system', content: PROMPT_E }, { role: 'user', content: user }];
}

/** Messages for a requery (kind "delta"): [system][media][capsule][prior summary][questions]. */
export function deltaMessages({ capsule, mediaParts, dossier, questions }) {
    const prior = [
        dossier?.summary ? `Summary so far: ${dossier.summary}` : '',
        Array.isArray(dossier?.answers) && dossier.answers.length
            ? `Already answered: ${dossier.answers.map(a => `${a.id}: ${a.answer}`).join(' | ')}` : '',
    ].filter(Boolean).join('\n');
    const user = [
        ...mediaParts,
        ...(capsule ? [{ type: 'text', text: `Roleplay context:\n${capsule}` }] : []),
        ...(prior ? [{ type: 'text', text: prior }] : []),
        { type: 'text', text: `Questions:\n${questionList(questions)}` },
    ];
    return [{ role: 'system', content: PROMPT_DELTA }, { role: 'user', content: user }];
}

/** Default checklist for the first pass (the "checklist" in the media call). */
export const DEFAULT_CHECKLIST = [
    'every spoken line verbatim with speaker and time',
    'people, setting and on-screen text',
    'tone and emotions',
];

/** Media length in seconds from frames + fps (frontend) or null. */
export function mediaSeconds({ frames, fps }) {
    const n = Array.isArray(frames) ? frames.length : 0;
    return n && Number(fps) > 0 ? n / Number(fps) : null;
}

export { itemHandle };
