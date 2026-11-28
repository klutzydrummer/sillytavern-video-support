import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMediaQ, parseFramesTag, parseFrameTime, requeryRecord, enqueue, similarity, resolveItemRef, triggerMet, decideRequery, piggybackItems, mergeDelta, removeFlushed } from './queue.js';
import { defaultSettings } from './settings.js';

const S = defaultSettings();
const ctx = { turn: 4, now: () => 'T' };

test('T-F6: <media_q> parsed, stripped from shown text', () => {
    const msg = 'She looks at the screen.\n<media_q item="abcd1234" blocking="true">What does the sign say?</media_q>\n\n\n"Interesting," she says. <media_q item=\'abcd1234\'>Is it raining?</media_q>';
    const r = parseMediaQ(msg);
    assert.equal(r.text, 'She looks at the screen.\n\n"Interesting," she says.');
    assert.deepEqual(r.questions, [
        { item: 'abcd1234', blocking: true, text: 'What does the sign say?' },
        { item: 'abcd1234', blocking: false, text: 'Is it raining?' },
    ]);
    assert.equal(parseMediaQ('no tags').questions.length, 0);
    assert.equal(parseMediaQ('<media_q item="x">   </media_q>ok').text, 'ok');
});

test('T-F6: dedupe by text similarity, blocking ORed', () => {
    assert.ok(similarity('What does the sign say?', 'what does the sign say') >= 0.8);
    let { pending, added, merged } = enqueue([], [{ text: 'What does the sign say?' }, { text: 'Is it raining?' }], ctx);
    assert.deepEqual([added, merged], [2, 0]);
    ({ pending, added, merged } = enqueue(pending, [{ text: 'what does the sign say', blocking: true }, { text: 'Who is the man in red?' }], ctx));
    assert.deepEqual([added, merged], [1, 1]);
    assert.equal(pending.length, 3);
    assert.equal(pending[0].blocking, true);
    assert.deepEqual(Object.keys(pending[2]).sort(), ['asked_at', 'blocking', 'id', 'text', 'turn']);
    assert.notEqual(pending[0].id, pending[2].id);
});

test('T-F6: item refs by handle, full id or title; fallback to active', () => {
    const items = [{ id: 'abcd1234'.padEnd(64, '0'), title: 'cat.mp4' }, { id: 'ffff0000'.padEnd(64, '1'), title: 'dog.mp4' }];
    assert.equal(resolveItemRef('abcd1234', items, null), items[0].id);
    assert.equal(resolveItemRef('DOG.mp4', items, null), items[1].id);
    assert.equal(resolveItemRef('', items, items[1].id), items[1].id);
    assert.equal(resolveItemRef('zz', items, null), null);
});

test('T-F6: batched delta merged into the dossier', () => {
    const d = { summary: 's', answers: [{ id: 'q1', answer: 'old', confidence: 0.4 }], timeline: [{ t0: 5, kind: 'visual', text: 'b' }], uncertain: ['u1'] };
    const delta = {
        answers: [{ id: 'q1', answer: 'new', confidence: 0.9 }, { id: 'f4-1', answer: 'sign says EXIT', confidence: 0.8 }],
        timeline_add: [{ t0: 1, kind: 'visual', text: 'a' }, { t0: 5, kind: 'visual', text: 'b' }, { t0: 2, kind: 'speech', speaker: 'A', text: 'hi' }],
        uncertain: ['u1', 'u2'],
    };
    const { dossier, speech } = mergeDelta(d, delta);
    assert.deepEqual(dossier.answers.map(a => [a.id, a.answer]), [['q1', 'new'], ['f4-1', 'sign says EXIT']]);
    assert.deepEqual(dossier.timeline.map(e => e.text), ['a', 'b'], 'sorted, duplicate dropped, no speech');
    assert.deepEqual(speech.map(e => e.text), ['hi']);
    assert.deepEqual(dossier.uncertain, ['u1', 'u2']);
    assert.equal(d.answers[0].answer, 'old', 'input untouched');
    assert.deepEqual(removeFlushed([{ id: 'a' }, { id: 'b' }], ['a']), [{ id: 'b' }]);
});

const P = (n, blocking = 0) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, text: `q${i}`, blocking: i < blocking }));

test('T-F7: thresholds 1 blocking or 3 pending (Q11a), both settings', () => {
    assert.equal(triggerMet(P(1, 1), S), true);
    assert.equal(triggerMet(P(2), S), false);
    assert.equal(triggerMet(P(3), S), true);
    assert.equal(triggerMet(P(2), { ...S, triggerNonBlocking: 2 }), true);
    assert.equal(triggerMet(P(1, 1), { ...S, triggerBlocking: 2 }), false);
});

test('T-F7: auto only in coexist with no eviction (Q10a); never auto in swap (F6/F11)', () => {
    const base = { pending: P(1, 1), settings: S, turn: 4, lastAutoTurn: undefined, estimateS: 5 };
    assert.equal(decideRequery({ ...base, mode: 'coexist', wouldEvict: [] }).action, 'auto');
    assert.equal(decideRequery({ ...base, mode: 'coexist', wouldEvict: ['other'] }).action, 'confirm');
    assert.equal(decideRequery({ ...base, mode: 'swap', wouldEvict: ['rp'] }).action, 'confirm');
    assert.equal(decideRequery({ ...base, mode: 'swap', wouldEvict: [], settings: { ...S, autoRequeryCapS: 9999 } }).action, 'confirm');
    assert.equal(decideRequery({ ...base, mode: 'solo', wouldEvict: [] }).action, 'confirm');
    assert.equal(decideRequery({ ...base, pending: P(2), mode: 'coexist', wouldEvict: [] }).action, 'none');
});

test('T-F7: at most one auto requery per item per RP turn', () => {
    const base = { pending: P(3), settings: S, mode: 'coexist', wouldEvict: [], estimateS: 5 };
    assert.equal(decideRequery({ ...base, turn: 4, lastAutoTurn: 4 }).action, 'confirm');
    assert.equal(decideRequery({ ...base, turn: 5, lastAutoTurn: 4 }).action, 'auto');
});

test('T-F7: empty cap = no cap (OQ-E7); a set cap skips auto when over or unknown', () => {
    const base = { pending: P(3), mode: 'coexist', wouldEvict: [], turn: 1 };
    assert.equal(decideRequery({ ...base, settings: S, estimateS: 100000 }).action, 'auto');
    assert.equal(decideRequery({ ...base, settings: S, estimateS: null }).action, 'auto');
    const capped = { ...S, autoRequeryCapS: 15 };
    assert.equal(decideRequery({ ...base, settings: capped, estimateS: 14 }).action, 'auto');
    assert.equal(decideRequery({ ...base, settings: capped, estimateS: 16 }).action, 'confirm');
    assert.equal(decideRequery({ ...base, settings: capped, estimateS: null }).action, 'confirm');
});

test('T-F7: piggyback picks other items on the same model with a queue (Q31a)', () => {
    const items = [
        { id: 'a', mediaModel: 'M', pending: P(1) },
        { id: 'b', mediaModel: 'M', pending: [] },
        { id: 'c', mediaModel: 'N', pending: P(2) },
        { id: 'd', mediaModel: 'M', pending: P(1) },
    ];
    assert.deepEqual(piggybackItems(items, 'M', 'a'), ['d']);
    assert.deepEqual(piggybackItems(items, 'M'), ['a', 'd']);
});

test('F-B: parseFrameTime accepts seconds, "s" suffix and m:ss; rejects junk', () => {
    assert.equal(parseFrameTime('12.5'), 12.5);
    assert.equal(parseFrameTime('40s'), 40);
    assert.equal(parseFrameTime('1:05'), 65);
    for (const bad of ['x', '', '-3', '1:75', null]) assert.equal(parseFrameTime(bad), null, String(bad));
});

test('F-B: <frames/> tags are parsed and stripped (self-closing, paired, either quote, any order)', () => {
    const out = parseFramesTag(`She looks. <frames t="12.5, 40s,1:05,x" item="abcd1234"/> Then <frames item='ef01' t='3'></frames>done.`);
    assert.equal(out.text, 'She looks.  Then done.');
    assert.deepEqual(out.requests, [{ item: 'abcd1234', times: [12.5, 40, 65] }, { item: 'ef01', times: [3] }]);
    assert.deepEqual(parseFramesTag('<frames t="7"/>').requests, [{ item: '', times: [7] }]);
    const none = parseFramesTag('No tag. <frames t="later"/>');
    assert.deepEqual(none.requests, [], 'a tag with no valid time is dropped');
    assert.equal(none.text, 'No tag.', 'but still stripped');
    assert.deepEqual(parseFramesTag('plain text'), { text: 'plain text', requests: [] });
});

test('F-B: <frames> and <media_q> in one message: each parser strips only its own tag', () => {
    const msg = 'A <media_q item="abcd">Sign?</media_q> B <frames t="5"/>';
    const q = parseMediaQ(msg);
    assert.equal(q.questions.length, 1);
    assert.match(q.text, /<frames t="5"\/>/);
    const f = parseFramesTag(q.text);
    assert.deepEqual(f.requests, [{ item: '', times: [5] }]);
    assert.equal(f.text, 'A  B');
});

test('F-B: requeryRecord keeps RTR flushed[].repaired only when it is a boolean', () => {
    const base = { questions: [{ id: 'q', text: 'x' }], mediaModel: 'M', status: 'ok', at: 1, trigger: 't' };
    assert.equal(requeryRecord({ ...base, repaired: true }).repaired, true);
    assert.equal(requeryRecord({ ...base, repaired: false }).repaired, false);
    assert.equal('repaired' in requeryRecord(base), false);
    assert.equal('repaired' in requeryRecord({ ...base, repaired: 'yes' }), false);
});
