import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MAX_KEY_FRAMES, framesBudget, dossierDuration, uniformFrameTimes, selectFrameTimes, frameCaption,
    decideFramesForTurn, requestedFrameTimes, REQUESTED_WHY, buildFrameParts, frameAtArgs, createKeyFrameCache, appendPartsToLastUser,
    AUTO_CONTINUE_MAX, decideAutoContinue,
} from './video-utils.js';
import { defaultSettings } from './settings.js';

const kf = (...ts) => ts.map((t, i) => ({ t, why: `w${i}` }));

test('P7 settings: K default 3, ctx for the cap 8192', () => {
    const d = defaultSettings();
    assert.equal(d.rpFrames, 3);
    assert.equal(d.rpFrameCtx, 8192);
});

test('selectFrameTimes: top K in the order given (not sorted by time)', () => {
    const sel = selectFrameTimes(kf(30, 5, 12, 40), 3, 60);
    assert.deepEqual(sel.map(f => f.t), [30, 5, 12]);
    assert.deepEqual(sel.map(f => f.why), ['w0', 'w1', 'w2']);
});

test('selectFrameTimes: capped at 6 key frames even when K and the list are larger', () => {
    assert.equal(MAX_KEY_FRAMES, 6);
    assert.equal(selectFrameTimes(kf(1, 2, 3, 4, 5, 6, 7, 8), 10, 100).length, 6);
    // only the first 6 of the list are considered (schema D maxItems 6)
    assert.deepEqual(selectFrameTimes(kf(-1, 'x', 1, 1.04, 2, 3, 99), 6, 100).map(f => f.t), [1, 2, 3]);
});

test('selectFrameTimes: drops invalid, duplicate and past-the-end times; rounds to 0.1 s', () => {
    const sel = selectFrameTimes([{ t: 12.04, why: ' a ' }, { t: 12.0, why: 'dup' }, { t: 80, why: 'late' }, { t: null }, { t: 3.26 }], 3, 60);
    assert.deepEqual(sel, [{ t: 12, why: 'a' }, { t: 3.3, why: '' }]);
});

test('selectFrameTimes: uniform fallback when key_frames is missing, empty or unusable', () => {
    assert.deepEqual(uniformFrameTimes(3, 30), [5, 15, 25]);
    for (const k of [undefined, null, [], [{ t: -2 }], [{ why: 'no t' }]]) {
        assert.deepEqual(selectFrameTimes(k, 3, 30).map(f => f.t), [5, 15, 25], JSON.stringify(k));
    }
    assert.deepEqual(selectFrameTimes([], 3, null), [], 'no duration, no key frames → nothing');
    assert.deepEqual(selectFrameTimes(kf(1), 0, 30), []);
});

test('dossierDuration from timeline and key frames', () => {
    assert.equal(dossierDuration({ timeline: [{ t0: 1, t1: 20 }, { t0: 25 }], key_frames: [{ t: 22 }] }), 25);
    assert.equal(dossierDuration({}), null);
});

test('framesBudget: K clamped by frames × tokens/frame + 4k ≤ ctx', () => {
    assert.equal(framesBudget(3, 1024, 8192), 3);          // room for 4
    assert.equal(framesBudget(6, 1024, 8192), 4);          // §5: ctx 8192 at 1024 → 4 frames
    assert.equal(framesBudget(3, 1024, 6144), 2);
    assert.equal(framesBudget(3, 1024, 4096), 0);          // no room
    assert.equal(framesBudget(3, 1024, 2000), 0);
    assert.equal(framesBudget(3, 280, 8192), 3);
    assert.equal(framesBudget(9, 280, 1e6), 6);            // never above 6
    assert.equal(framesBudget(3, 1024, 0), 3);             // unknown ctx: K only
});

test('caption format "t=12.0 s: why"', () => {
    assert.equal(frameCaption(12, 'door opens'), 't=12.0 s: door opens');
    assert.equal(frameCaption(3.26, ''), 't=3.3 s');
    const parts = buildFrameParts([{ t: 12, why: 'door opens', url: 'data:image/jpeg;base64,AA' }, { t: 5, why: 'x', url: null }]);
    assert.deepEqual(parts, [
        { type: 'text', text: 't=12.0 s: door opens' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AA' } },
    ]);
});

test('frameAtArgs: fast seek to one frame', () => {
    assert.deepEqual(frameAtArgs(12, { maxDimension: 512, qscale: 10 }),
        ['-ss', '12.0', '-i', 'input.mp4', '-frames:v', '1', '-vf', 'scale=512:-2', '-q:v', '10', 'at.jpg']);
});

test('key frame cache: miss extracts, hit does not, keyed by hash + t', async () => {
    const cache = createKeyFrameCache({ maxEntries: 10 });
    const calls = [];
    const extract = async (ts) => { calls.push(ts); return ts.map(t => `img@${t}`); };
    let r = await cache.getOrExtract('h1', [5, 12], extract);
    assert.deepEqual(r, { urls: ['img@5', 'img@12'], hits: 0, misses: 2 });
    r = await cache.getOrExtract('h1', [12, 20], extract);
    assert.deepEqual(r, { urls: ['img@12', 'img@20'], hits: 1, misses: 1 });
    assert.deepEqual(calls, [[5, 12], [20]]);
    r = await cache.getOrExtract('h2', [12], extract); // same t, other media → miss
    assert.equal(r.misses, 1);
    assert.ok(cache.has('h1', 12.04), 't keyed at 0.1 s');
    assert.equal(cache.size, 4);
});

test('key frame cache: failed extraction is not cached; LRU eviction', async () => {
    const cache = createKeyFrameCache({ maxEntries: 2 });
    let r = await cache.getOrExtract('h', [1], async () => [null]);
    assert.deepEqual(r.urls, [null]);
    assert.equal(cache.size, 0);
    cache.set('h', 1, 'a'); cache.set('h', 2, 'b');
    assert.equal(cache.get('h', 1), 'a'); // touch 1 → 2 is oldest
    cache.set('h', 3, 'c');
    assert.equal(cache.has('h', 2), false);
    assert.equal(cache.has('h', 1), true);
    assert.equal(cache.has('h', 3), true);
    assert.equal(cache.size, 2);
});

const sel = kf(30, 5, 12);
const base = { rpImages: true, enabled: true, k: 3, selected: sel };

test('decideFramesForTurn: non-image RP or toggle off sends nothing, in every case', () => {
    for (const extra of [{ replyToMedia: true }, { userAsked: true }, { citedTimes: [12], t2Hits: 1 }]) {
        assert.deepEqual(decideFramesForTurn({ ...base, ...extra, rpImages: false }), { reason: 'off', frames: [] });
        assert.deepEqual(decideFramesForTurn({ ...base, ...extra, enabled: false }), { reason: 'off', frames: [] });
    }
});

test('decideFramesForTurn: the reply right after processing gets the selected frames', () => {
    assert.deepEqual(decideFramesForTurn({ ...base, replyToMedia: true }), { reason: 'first', frames: sel });
    assert.deepEqual(decideFramesForTurn({ ...base, k: 2, replyToMedia: true }).frames, sel.slice(0, 2));
    assert.deepEqual(decideFramesForTurn({ ...base, k: 0, replyToMedia: true }), { reason: 'none', frames: [] });
});

test('decideFramesForTurn: later turns get nothing unless asked or a T2-matched timestamp is cited', () => {
    assert.deepEqual(decideFramesForTurn(base), { reason: 'none', frames: [] });
    assert.deepEqual(decideFramesForTurn({ ...base, citedTimes: [12], t2Hits: 0 }).frames, [], 'cited but T2 matched nothing');
    assert.deepEqual(decideFramesForTurn({ ...base, citedTimes: [], t2Hits: 2 }).frames, [], 'keyword-only T2 hit');
    assert.deepEqual(decideFramesForTurn({ ...base, userAsked: true }), { reason: 'asked', frames: sel });
});

test('decideFramesForTurn: a cited timestamp uses the nearest key frame, else that time', () => {
    const r = decideFramesForTurn({ ...base, citedTimes: [14, 13, 90], t2Hits: 1 });
    assert.equal(r.reason, 't2');
    assert.deepEqual(r.frames, [sel[2], { t: 90, why: 'cited in chat' }]); // 14 and 13 both → 12, deduped
    assert.equal(decideFramesForTurn({ ...base, k: 1, citedTimes: [5, 30], t2Hits: 1 }).frames.length, 1);
});

test('frame parts land on the last user message; no audio or video parts', () => {
    const body = { messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'look' }] };
    const d = decideFramesForTurn({ ...base, replyToMedia: true });
    appendPartsToLastUser(body, buildFrameParts(d.frames.map(f => ({ ...f, url: `u${f.t}` }))));
    const types = body.messages[1].content.map(p => p.type);
    assert.deepEqual(types, ['text', 'text', 'image_url', 'text', 'image_url', 'text', 'image_url']);
    assert.equal(body.messages[1].content[1].text, 't=30.0 s: w0');
    assert.ok(!types.includes('input_audio') && !types.includes('input_video'));
});

test('F-B: requestedFrameTimes clamps to K (max 6), dedupes, drops times past the end', () => {
    assert.deepEqual(requestedFrameTimes([12.5, 40], 3, 60), [{ t: 12.5, why: REQUESTED_WHY }, { t: 40, why: REQUESTED_WHY }]);
    assert.deepEqual(requestedFrameTimes([1, 2, 3, 4], 2, 60).map(f => f.t), [1, 2]);
    assert.equal(requestedFrameTimes([1, 2, 3, 4, 5, 6, 7, 8], 10, 100).length, 6);
    assert.deepEqual(requestedFrameTimes([5, 5.01, 5, 70, -1, 'x', 9], 6, 60).map(f => f.t), [5, 9]);
    assert.deepEqual(requestedFrameTimes([500], 3, null).map(f => f.t), [500], 'no duration → no end check');
    assert.deepEqual(requestedFrameTimes([1], 0, 60), []);
    assert.deepEqual(requestedFrameTimes(null, 3, 60), []);
});

test('F-B: decideFramesForTurn: tag-requested frames beat the button and t2; the first reply still wins', () => {
    const req = requestedFrameTimes([7, 8, 9, 10], 6, 60);
    assert.deepEqual(decideFramesForTurn({ ...base, requested: req }), { reason: 'requested', frames: req.slice(0, 3) });
    assert.equal(decideFramesForTurn({ ...base, requested: req, userAsked: true }).reason, 'requested');
    assert.equal(decideFramesForTurn({ ...base, requested: req, citedTimes: [12], t2Hits: 1 }).reason, 'requested');
    assert.deepEqual(decideFramesForTurn({ ...base, requested: req, replyToMedia: true }), { reason: 'first', frames: sel });
    assert.deepEqual(decideFramesForTurn({ ...base, requested: req, rpImages: false }), { reason: 'off', frames: [] });
    assert.equal(decideFramesForTurn({ ...base, requested: [], userAsked: true }).reason, 'asked', 'empty list = no tag');
});

test('F-C: decideAutoContinue fires on a resolved tag, capped at 2 per user message', () => {
    assert.equal(AUTO_CONTINUE_MAX, 2);
    const a = { resolved: 1, framesOn: true, genType: 'normal' };
    let r = decideAutoContinue({ ...a, count: 0 });
    assert.deepEqual(r, { fire: true, count: 1, why: 'frames requested' });
    r = decideAutoContinue({ ...a, count: r.count });
    assert.deepEqual(r, { fire: true, count: 2, why: 'frames requested' });
    r = decideAutoContinue({ ...a, count: r.count });
    assert.deepEqual(r, { fire: false, count: 2, why: 'cap reached' });
    // a real user message resets the caller's count to 0
    assert.equal(decideAutoContinue({ ...a, count: 0 }).fire, true);
    assert.equal(decideAutoContinue({ ...a, count: 0, max: 0 }).fire, false);
});

test('F-C: decideAutoContinue does not fire without a resolved tag, with frames off, or on quiet/dry runs', () => {
    const a = { resolved: 1, framesOn: true, genType: 'normal', count: 0 };
    assert.equal(decideAutoContinue({ ...a, resolved: 0 }).why, 'no resolved tag');
    assert.equal(decideAutoContinue({ ...a, framesOn: false }).why, 'frames off');
    assert.equal(decideAutoContinue({ ...a, genType: 'quiet' }).why, 'not a chat reply');
    assert.equal(decideAutoContinue({ ...a, dryRun: true }).why, 'not a chat reply');
    assert.equal(decideAutoContinue({ ...a, genType: null }).fire, true);   // unknown type = normal send
    assert.equal(decideAutoContinue({ ...a, count: -3 }).count, 1);
});
