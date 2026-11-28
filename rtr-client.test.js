import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRtrClient, RtrError, describeRtrError, RTR_MODEL, rtrExtras } from './rtr-client.js';
import { fakeRtrFetch, rtrOk, planRes } from './testing-stubs.js';

test('rtr client: request body follows the P3 contract', async () => {
    const f = fakeRtrFetch(() => rtrOk({ status: 'ok', result: { answers: [] } }));
    const c = createRtrClient({ fetch: f.fetch, baseUrl: 'http://box:9/' });
    const flush = [{ id: 'b', messages: [{ role: 'user', content: 'x' }], maxTokens: 800 }];
    const res = await c.run({ messages: [{ role: 'user', content: 'm' }], mediaModel: 'LFM3-Omni-2B-Q8_0', rpModel: 'rp', kind: 'delta', maxTokens: 800, flush });
    assert.equal(res.status, 'ok');
    const { url, body } = f.calls[0];
    assert.equal(url, 'http://box:9/v1/chat/completions');
    assert.equal(body.model, RTR_MODEL);
    assert.deepEqual(body.rtr, { media_model: 'LFM3-Omni-2B-Q8_0', kind: 'delta', rp_model: 'rp', flush: [{ id: 'b', messages: flush[0].messages, max_tokens: 800 }] });
    assert.equal(body.max_tokens, 800);
    const f2 = fakeRtrFetch(() => planRes('swap'));
    const plan = await createRtrClient({ fetch: f2.fetch, baseUrl: 'http://box' }).plan({ mediaModel: 'M' });
    assert.equal(plan.mode, 'swap');
    assert.equal(f2.calls[0].body.rtr.dry_run, true);
});

test('rtr client: 502 / 503 / 400 / network map to typed errors', async () => {
    const cases = [
        [{ status: 503, json: { error: { message: 'media swap in progress' } } }, 'busy'],
        [{ status: 502, json: { error: { message: 'boom', step: 'load_mm' }, rtr: { timings: { load_mm_s: 3 } } } }, 'step'],
        [{ status: 400, json: { error: { message: 'rtr.media_model is required' } } }, 'request'],
        [new TypeError('fetch failed'), 'network'],
        [{ status: 200, json: { choices: [] } }, 'protocol'],
    ];
    for (const [reply, kind] of cases) {
        const c = createRtrClient({ fetch: fakeRtrFetch(() => reply).fetch, baseUrl: 'http://box' });
        const err = await c.run({ messages: [], mediaModel: 'M', kind: 'dossier' }).then(() => null, e => e);
        assert.ok(err instanceof RtrError, kind);
        assert.equal(err.kind, kind);
        if (kind === 'step') { assert.equal(err.step, 'load_mm'); assert.equal(err.res.timings.load_mm_s, 3); }
        assert.ok(describeRtrError(err).length > 5);
    }
});

test('rtr client: real HTTP round trip against a tiny in-process server', async () => {
    const seen = [];
    const server = http.createServer((req, res) => {
        let b = '';
        req.on('data', d => { b += d; });
        req.on('end', () => {
            seen.push({ path: req.url, body: JSON.parse(b) });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(rtrOk({ status: 'ok', mode: 'coexist', result: { schema_version: 'dossier/1' } }).json));
        });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    try {
        const c = createRtrClient({ fetch: globalThis.fetch, baseUrl: `http://127.0.0.1:${server.address().port}` });
        const res = await c.run({ messages: [{ role: 'user', content: 'x' }], mediaModel: 'M', kind: 'dossier' });
        assert.equal(res.mode, 'coexist');
        assert.equal(seen[0].path, '/v1/chat/completions');
        assert.equal(seen[0].body.rtr.kind, 'dossier');
    } finally {
        server.close();
    }
});

test('F-B: plan() merges RTR top-level extras into the plan; older RTR plans are unchanged', async () => {
    const gpu = { name: 'RTX 4090', total_mb: 24564, free_mb: 20000, need_mb: 9000, margin_mb: 1024 };
    const f = fakeRtrFetch(() => rtrOk({ status: 'plan', plan: { mode: 'coexist', reason: 'coexist set and live VRAM fit' }, rp_vision: true, co_set: 'rp+lfm3', gpu }));
    const plan = await createRtrClient({ fetch: f.fetch, baseUrl: 'http://box' }).plan({ mediaModel: 'M' });
    assert.equal(plan.mode, 'coexist');
    assert.equal(plan.rp_vision, true);
    assert.equal(plan.co_set, 'rp+lfm3');
    assert.deepEqual(plan.gpu, gpu);
    const old = fakeRtrFetch(() => planRes('swap'));
    const p2 = await createRtrClient({ fetch: old.fetch, baseUrl: 'http://box' }).plan({ mediaModel: 'M' });
    for (const k of ['rp_vision', 'co_set', 'gpu']) assert.equal(k in p2, false, k);
});

test('F-B: rtrExtras reads the extras and gives null for anything missing or malformed', () => {
    assert.deepEqual(rtrExtras(undefined), { rpVision: null, coSet: null, gpu: null, prefillRpS: null });
    assert.deepEqual(rtrExtras({ rp_vision: 'yes', co_set: '', gpu: 'x', timings: { prefill_rp_s: null } }), { rpVision: null, coSet: null, gpu: null, prefillRpS: null });
    assert.deepEqual(rtrExtras({ rp_vision: false, co_set: 'a+b', gpu: { name: 'g' }, timings: { prefill_rp_s: 2.5 } }), { rpVision: false, coSet: 'a+b', gpu: { name: 'g' }, prefillRpS: 2.5 });
});
