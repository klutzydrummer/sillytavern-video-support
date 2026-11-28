import test from 'node:test';
import assert from 'node:assert/strict';
import { injectTiers, progressText, rtrExtrasText, rpVisionHint, requeryBarModel, itemCardModel, parseQuestionLines, routingMode } from './protocol-view.js';

const A = 'a'.repeat(64);

test('view: routing defaults to dossier; direct keeps the legacy path', () => {
    assert.equal(routingMode({}), 'dossier');
    assert.equal(routingMode({ routing: 'direct' }), 'direct');
    assert.equal(routingMode({ routing: 'x' }), 'dossier');
});

test('Q26a: tiers go in as text; T0 after the system block, T1/T2/F before the last user turn', () => {
    const body = { messages: [
        { role: 'system', content: 'sys' }, { role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'u2' },
    ] };
    assert.equal(injectTiers(body, { t0: 'T0', t1: 'T1', t2: 'T2', handles: ['aaaaaaaa'] }), true);
    assert.deepEqual(body.messages.map(m => m.role), ['system', 'system', 'user', 'assistant', 'system', 'user']);
    assert.equal(body.messages[1].content, 'T0');
    assert.match(body.messages[4].content, /^T1\n\nT2\n\n.*<media_q item="ID"/s);
    assert.match(body.messages[4].content, /"aaaaaaaa"/);
    assert.equal(injectTiers({ messages: [] }, {}), false);
    const only = { messages: [{ role: 'user', content: 'u' }] };
    injectTiers(only, { t0: 'T0' });
    assert.deepEqual(only.messages.map(m => m.content), ['T0', 'u']);
});

test('T-F7/T-F8 view: requery bar shows confirms only, with estimate, $ and hint', () => {
    const pv = { mode: 'swap', estimate: { label: 'unknown, first run' }, dollars: null, hint: 'LFM3 can answer without a swap' };
    const bar = requeryBarModel([{ itemId: A, action: 'confirm', reason: 'swap mode needs confirmation', preview: pv }, { itemId: 'b', action: 'auto' }], { [A]: 'cat.mp4' });
    assert.equal(bar.visible, true);
    assert.equal(bar.items.length, 1);
    assert.match(bar.items[0].text, /^cat\.mp4: .*Follow-up \(model swap\): unknown, first run · LFM3 can answer without a swap$/);
    assert.equal(requeryBarModel([{ itemId: A, action: 'none' }]).visible, false);
    assert.match(progressText({ mode: 'coexist', estimate: { label: '~12 s' }, dollars: 0.002 }), /^Media pass \(no swap\): ~12 s · \$/);
});

test('view: item card has dropdown, badges and actions only with a dossier', () => {
    const none = itemCardModel({ id: A, item: { title: 'cat.mp4', versions: [] } });
    assert.equal(none.handle, 'aaaaaaaa');
    assert.equal(none.canAsk, false);
    assert.equal(none.options.find(o => o.selected).value, 'qwen-auto');
    assert.deepEqual(none.badges.map(b => b.text), ['no dossier']);
    const v = { provenance: { model_id: 'LFM3-Omni-2B', quant: 'Q8_0', status: 'ok' } };
    const has = itemCardModel({ id: A, item: { selected_model: 'lfm3', versions: [v], pending: [{ blocking: true }] }, lookup: { status: 'stale' } });
    assert.equal(has.canRegenerate, true);
    assert.deepEqual(has.badges.map(b => b.text), ['LFM3-Omni 2B', 'stale', '1 question pending']);
    assert.deepEqual(parseQuestionLines(' a \n\n b\n'), ['a', 'b']);
});

test('F-B: injectTiers passes the frames flag to the follow-up instruction', () => {
    const on = { messages: [{ role: 'user', content: 'hi' }] };
    injectTiers(on, { handles: ['abcd1234'], frames: true });
    assert.match(on.messages[0].content, /<frames item=/);
    const off = { messages: [{ role: 'user', content: 'hi' }] };
    injectTiers(off, { handles: ['abcd1234'] });
    assert.doesNotMatch(off.messages[0].content, /<frames/);
});

test('F-B: rtrExtrasText shows co_set and GPU VRAM; empty for older RTR', () => {
    assert.equal(rtrExtrasText({ mode: 'swap' }), '');
    assert.equal(rtrExtrasText(null), '');
    assert.equal(rtrExtrasText({ co_set: null, gpu: null }), '');
    assert.equal(rtrExtrasText({ co_set: 'rp+lfm3', gpu: { name: 'RTX 4090', free_mb: 20480, need_mb: 9216 } }), 'set rp+lfm3 · RTX 4090 20 GiB free / 9 GiB needed');
    assert.equal(rtrExtrasText({ gpu: { name: 'A10', free_mb: 1024 } }), 'A10 1 GiB free / ? needed');
});

test('F-B: progressText appends the RTR extras when present', () => {
    const pv = { mode: 'swap', estimate: { label: '~1 min' }, dollars: null, plan: { mode: 'swap', co_set: 'rp+lfm3' } };
    assert.equal(progressText(pv), 'Media pass (model swap): ~1 min · set rp+lfm3');
    assert.equal(progressText({ ...pv, plan: { mode: 'swap' } }), 'Media pass (model swap): ~1 min');
});

test('F-B: rpVisionHint is advice only; the setting stays the authority', () => {
    assert.equal(rpVisionHint({ rpVision: true, rpAcceptsImages: false }).tone, 'info');
    assert.equal(rpVisionHint({ rpVision: false, rpAcceptsImages: true }).tone, 'warn');
    assert.equal(rpVisionHint({ rpVision: true, rpAcceptsImages: true }), null);
    assert.equal(rpVisionHint({ rpVision: false, rpAcceptsImages: false }), null);
    assert.equal(rpVisionHint({ rpVision: null, rpAcceptsImages: true }), null, 'older RTR: no hint');
});
