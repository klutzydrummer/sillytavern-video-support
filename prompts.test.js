import test from 'node:test';
import assert from 'node:assert/strict';
import { PROMPT_VERSION, QUESTION_SCHEMA, parseQuestionPass, buildCapsule, buildMediaParts, extractionMessages, deltaMessages, followUpInstruction, questionPrompt } from './prompts.js';
import { tokens } from './tiers.js';
import { defaultSettings } from './settings.js';
import { dropdownOptions, resolveMediaModel, itemBadges, mmMaxTokens, REGEN_CHOICES } from './media-models.js';
import { BADGE_NOT_KEPT, BADGE_NOT_ON_DEVICE } from './dossier-store.js';

const S = defaultSettings();

test('prompts: version and question schema', () => {
    assert.match(PROMPT_VERSION, /\S/);
    assert.equal(QUESTION_SCHEMA.properties.questions.maxItems, 8);
    assert.match(questionPrompt(5, 'a.mp4'), /up to 5 short/);
    assert.match(questionPrompt(99), /up to 8 short/);
});

test('prompts: question pass parsed, fenced, clamped to 8, deduped', () => {
    const qs = Array.from({ length: 12 }, (_, i) => ({ id: 'z', text: `Question ${i % 10}?` }));
    const r = parseQuestionPass('```json\n' + JSON.stringify({ questions: qs, needs_for_next_reply: 'who speaks' }) + '\n```');
    assert.equal(r.ok, true);
    assert.equal(r.questions.length, 8);
    assert.deepEqual(r.questions.map(q => q.id), ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8']);
    assert.equal(r.needs, 'who speaks');
    assert.equal(parseQuestionPass('{"questions":["a?","a?","b?"]}', 3).questions.length, 2);
    assert.deepEqual(parseQuestionPass('not json'), { questions: [], needs: '', ok: false });
});

test('prompts: capsule ≤ 600 tokens, newest messages kept', () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({ name: i % 2 ? 'Bot' : 'User', text: `message ${i} `.repeat(60) }));
    const c = buildCapsule({ charName: 'Aria', charDescription: 'A pilot. '.repeat(200), messages }, S);
    assert.ok(tokens(c) <= S.capsuleTokens, `${tokens(c)}`);
    assert.match(c, /message 19/);
    assert.doesNotMatch(c, /message 0 /);
    assert.equal(buildCapsule({ messages }, { ...S, capsuleTokens: 0 }), '');
});

test('prompts: media parts and message order', () => {
    const parts = buildMediaParts({ mode: 'frontend', frames: ['data:a', 'data:b'], fps: 0.5, audioB64: 'UklG' });
    assert.deepEqual(parts.map(p => p.type), ['text', 'image_url', 'text', 'image_url', 'input_audio']);
    assert.equal(parts[2].text, '[t=0:02]');
    assert.deepEqual(buildMediaParts({ mode: 'backend', videoUrl: 'u' }), [{ type: 'input_video', input_video: { url: 'u' } }]);
    const e = extractionMessages({ capsule: 'cap', mediaParts: parts, questions: [{ id: 'q1', text: 'who?' }], checklist: ['x'] });
    assert.equal(e[0].role, 'system');
    assert.match(e[1].content.at(-2).text, /q1: who\?/);
    const d = deltaMessages({ capsule: 'cap', mediaParts: parts, dossier: { summary: 'sum', answers: [{ id: 'q1', answer: 'A' }] }, questions: [{ id: 'f1', text: 'sign?' }] });
    const types = d[1].content.map(p => p.type === 'text' ? p.text.split(/[:\n]/)[0] : p.type);
    assert.deepEqual(types, ['[t=0', 'image_url', '[t=0', 'image_url', 'input_audio', 'Roleplay context', 'Summary so far', 'Questions']);
    assert.match(followUpInstruction(['abcd1234']), /<media_q item="ID" blocking="true\|false">/);
});

test('media models: auto → Q8 (F3a), dropdown and caps (Q27a)', () => {
    assert.equal(resolveMediaModel('qwen-auto').lsId, 'Qwen3-Omni-30B-A3B-Instruct-Q8_0');
    assert.equal(resolveMediaModel('nope').lsId, 'Qwen3-Omni-30B-A3B-Instruct-Q8_0');
    assert.equal(resolveMediaModel('lfm3').lsId, 'LFM3-Omni-2B-Q8_0');
    const opts = dropdownOptions('lfm3');
    assert.equal(opts.filter(o => o.selected).length, 1);
    assert.equal(opts.find(o => o.selected).value, 'lfm3');
    assert.match(opts[0].label, /Qwen \(auto\) → Qwen3-Omni Q8/);
    assert.equal(mmMaxTokens(resolveMediaModel('lfm3'), S), 1200);
    assert.equal(mmMaxTokens(resolveMediaModel('qwen-q4'), S), 2500);
    assert.deepEqual(REGEN_CHOICES.map(c => c.value), ['same', 'model', 'questions']);
});

test('badges: stale shown (F14), transcript badges (OQ-E3, OQ-B4), pending', () => {
    const version = { provenance: { model_id: 'Qwen3-Omni-30B-A3B-Instruct', quant: 'Q8_0', status: 'ok' } };
    const t = (b) => b.map(x => x.text);
    assert.deepEqual(t(itemBadges({ version, lookup: { status: 'stale' } })), ['Qwen3-Omni Q8', 'stale']);
    assert.deepEqual(t(itemBadges({ version, transcriptBadge: BADGE_NOT_KEPT })), ['Qwen3-Omni Q8', BADGE_NOT_KEPT]);
    assert.deepEqual(t(itemBadges({ version, transcriptBadge: BADGE_NOT_ON_DEVICE })), ['Qwen3-Omni Q8', BADGE_NOT_ON_DEVICE]);
    const p = itemBadges({ version, pending: [{ blocking: true }, {}] });
    assert.equal(p.at(-1).text, '2 questions pending');
    assert.equal(p.at(-1).tone, 'warn');
    assert.deepEqual(t(itemBadges({})), ['no dossier']);
    assert.deepEqual(t(itemBadges({ busy: { label: 'working' } })), ['working']);
    assert.equal(itemBadges({ error: 'boom' })[0].tone, 'bad');
});
