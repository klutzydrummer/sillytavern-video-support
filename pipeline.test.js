import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from './dossier-store.js';
import { createRtrClient } from './rtr-client.js';
import { createProtocol } from './pipeline.js';
import { defaultSettings } from './settings.js';
import { UNKNOWN_FIRST_RUN } from './estimate.js';
import { fakeST, fakeRtrFetch, rtrOk, planRes, sampleDossier } from './testing-stubs.js';

const Q8 = 'Qwen3-Omni-30B-A3B-Instruct-Q8_0';
const LFM = 'LFM3-Omni-2B-Q8_0';
const A = 'a'.repeat(64), B = 'b'.repeat(64);

/**
 * Whole protocol on stubs. `mode` drives the fake RTR (dry run and real calls);
 * `lfmReason` is the plan reason the fake gives for LFM3 dry runs.
 */
function harness({ mode = 'coexist', lfmReason = 'no coexist set for this RP and media model', settings = {}, fail = null } = {}) {
    const st = fakeST();
    const store = createStore(st);
    const rtrFetch = fakeRtrFetch((body) => {
        const r = body.rtr;
        if (r.dry_run) {
            if (r.media_model === LFM) return planRes('swap', { reason: lfmReason });
            return planRes(mode);
        }
        if (fail) return fail;
        const timings = mode === 'swap'
            ? { unload_rp_s: 2, load_mm_s: 20, extract_s: 30, unload_mm_s: 1, reload_rp_s: 10, total_s: 63, flush_s: 4 }
            : { extract_s: 8, total_s: 8, flush_s: 2 };
        const result = r.kind === 'dossier' ? sampleDossier(r.media_model.slice(0, 4))
            : { answers: [{ id: 'f1-1', answer: 'EXIT', confidence: 0.8 }], timeline_add: [{ t0: 7, kind: 'speech', speaker: 'Owner', text: 'Get out' }, { t0: 6, kind: 'visual', text: 'sign' }], uncertain: [] };
        const flushed = (r.flush || []).map(f => ({ id: f.id, status: 'ok', errors: [], delta: { answers: [{ id: 'pb', answer: `piggy ${f.id.slice(0, 2)}`, confidence: 0.5 }] } }));
        return rtrOk({ kind: r.kind, media_model: r.media_model, rp_model: 'rp', mode, plan: { mode, would_evict: [] }, timings, status: 'ok', result,
            usage: { completion_tokens: 400 }, llama_timings: { prompt_ms: 4000, predicted_ms: 4000, predicted_n: 400 }, flushed,
            mmproj_sha256: 'mm1', llama_build: 'b9000' });
    });
    const rtr = createRtrClient({ fetch: rtrFetch.fetch, baseUrl: 'http://box' });
    const asked = [];
    const mmproj = new Map();
    let stats = {};
    const statuses = [];
    const media = [];
    const proto = createProtocol({
        store, rtr,
        askQuestions: async (req) => { asked.push(req); return JSON.stringify({ questions: [{ id: 'q1', text: 'Who is in it?' }], needs_for_next_reply: 'names' }); },
        getMedia: async (id) => { media.push(id); return { mediaParts: [{ type: 'image_url', image_url: { url: `data:${id.slice(0, 2)}` } }], mediaSeconds: 10 }; },
        capsuleContext: () => ({ charName: 'Aria', messages: [{ name: 'User', text: 'look at this' }] }),
        settings: () => ({ ...defaultSettings(), ...settings }),
        getStats: () => stats, setStats: (s) => { stats = s; },
        gpu: () => 'RTX 4090',
        knownMmproj: (id) => mmproj.get(id), rememberMmproj: (id, sha) => mmproj.set(id, sha),
        onStatus: (id, s) => statuses.push([id, s]),
    });
    const runs = () => rtrFetch.calls.filter(c => !c.body.rtr.dry_run);
    return { st, store, proto, rtrFetch, runs, asked, mmproj, statuses, media, getStats: () => stats };
}

test('protocol: first pass, then cache hit never calls the media model (no re-send)', async () => {
    const h = harness();
    await h.proto.registerItem({ id: A, title: 'cat.mp4', mediaUrl: '/user/files/cat.mp4', messageId: 3 });
    const r = await h.proto.ensureDossier(A);
    assert.equal(r.status, 'created');
    assert.equal(h.asked.length, 1, 'one question pass');
    assert.equal(h.runs().length, 1);
    const body = h.runs()[0].body;
    assert.equal(body.rtr.media_model, Q8, 'Qwen (auto) → Q8');
    assert.equal(body.rtr.kind, 'dossier');
    assert.equal(body.max_tokens, 2500);
    assert.match(JSON.stringify(body.messages), /q1: Who is in it\?/);
    assert.match(JSON.stringify(body.messages), /Roleplay character: Aria/);
    assert.equal(h.mmproj.get(Q8), 'mm1');
    const v = h.store.activeVersion(A);
    assert.equal(v.provenance.mmproj_sha256, 'mm1');
    assert.equal(v.provenance.prompt_version.length > 0, true);
    assert.equal(h.store.getItem(A).message_id, 3);
    const again = await h.proto.ensureDossier(A);
    assert.equal(again.status, 'hit');
    assert.equal(h.runs().length, 1, 'no second media call');
    assert.equal(h.asked.length, 1);
    assert.equal(h.media.length, 1, 'media not even extracted on a hit');
});

test('protocol: unknown mmproj → hard-key hit; changed mmproj → stale, shown not dropped (F14)', async () => {
    const h = harness();
    await h.proto.registerItem({ id: A, title: 'cat.mp4' });
    await h.proto.ensureDossier(A);
    h.mmproj.clear();
    assert.equal((await h.proto.ensureDossier(A)).status, 'hit');
    h.mmproj.set(Q8, 'mm2');
    const r = await h.proto.ensureDossier(A);
    assert.equal(r.status, 'stale');
    assert.equal(h.runs().length, 1, 'stale is not silently re-extracted');
    assert.equal(h.proto.tierItems()[0].stale, true);
});

test('T-F6/T-F7: <media_q> queued, coexist + no eviction → one auto requery, delta merged', async () => {
    const h = harness({ mode: 'coexist' });
    await h.proto.registerItem({ id: A, title: 'cat.mp4' });
    await h.proto.ensureDossier(A);
    const out = await h.proto.afterRpTurn({ text: `Hmm. <media_q item="${A.slice(0, 8)}" blocking="true">What does the sign say?</media_q>`, turn: 1 });
    assert.equal(out.text, 'Hmm.');
    assert.equal(out.decisions[0].action, 'auto');
    await Promise.all(out.auto);
    const delta = h.runs()[1].body;
    assert.equal(delta.rtr.kind, 'delta');
    assert.equal(delta.max_tokens, 800);
    assert.match(JSON.stringify(delta.messages), /What does the sign say\?/);
    const item = h.store.getItem(A);
    assert.deepEqual(item.pending, []);
    assert.equal(item.auto_turn, 1);
    const v = h.store.activeVersion(A);
    assert.equal(v.dossier.answers.find(a => a.id === 'f1-1').answer, 'EXIT');
    assert.ok(v.dossier.timeline.some(e => e.text === 'sign'));
    assert.ok(!v.dossier.timeline.some(e => e.kind === 'speech'), 'speech stays out of chatMetadata');
    assert.equal(v.provenance.requeries.length, 1);
    assert.equal(v.provenance.requeries[0].trigger, 'auto');
    assert.ok(v.provenance.requeries[0].transcript.path.startsWith('/user/files/md-'));
    const sp = await h.store.loadSpeech(v);
    assert.ok(sp.speech.some(e => e.text === 'Get out'), 'delta speech readable for T2');
    // Same turn: a new blocking question no longer auto-runs (one per item per turn).
    const again = await h.proto.afterRpTurn({ text: `<media_q item="${A.slice(0, 8)}" blocking="true">Who wrote it?</media_q>`, turn: 1 });
    assert.equal(again.decisions[0].action, 'confirm');
    assert.equal(again.auto.length, 0);
    // Next turn it may.
    const next = await h.proto.afterRpTurn({ text: 'ok', turn: 2 });
    assert.equal(next.decisions[0].action, 'auto');
    await Promise.all(next.auto);
    assert.equal(h.runs().length, 3);
});

test('T-F7: swap mode never auto; user Ask flushes; below threshold nothing happens', async () => {
    const h = harness({ mode: 'swap' });
    await h.proto.registerItem({ id: A, title: 'cat.mp4' });
    await h.proto.ensureDossier(A);
    let out = await h.proto.afterRpTurn({ text: `<media_q item="${A.slice(0, 8)}">Is it raining?</media_q>`, turn: 1 });
    assert.deepEqual(out.decisions, [], 'one non-blocking question: under the trigger');
    out = await h.proto.afterRpTurn({ text: `<media_q item="${A.slice(0, 8)}" blocking="true">What colour is the car?</media_q>`, turn: 2 });
    assert.equal(out.decisions[0].action, 'confirm');
    assert.match(out.decisions[0].reason, /swap/);
    assert.equal(h.runs().length, 1, 'no requery without the user');
    const r = await h.proto.requery(A, 'confirm');
    assert.equal(r.status, 'ok');
    assert.equal(h.runs()[1].body.rtr.kind, 'delta');
    assert.deepEqual(h.store.getItem(A).pending, []);
    await h.proto.ask(A, ['Who drives?']);
    assert.equal(h.runs().length, 3);
    assert.match(JSON.stringify(h.runs()[2].body.messages), /Who drives\?/);
});

test('T-F7: piggyback flushes other items on the same model with no confirm (Q31a)', async () => {
    const h = harness({ mode: 'swap' });
    await h.proto.registerItem({ id: A, title: 'a.mp4' });
    await h.proto.registerItem({ id: B, title: 'b.mp4' });
    await h.proto.ensureDossier(A);
    await h.proto.ensureDossier(B);
    await h.proto.afterRpTurn({ text: `<media_q item="${B.slice(0, 8)}">Is there a dog?</media_q>`, turn: 1 });
    assert.equal(h.store.getItem(B).pending.length, 1);
    await h.proto.ask(A, ['What time is it?']);
    const last = h.runs().at(-1).body;
    assert.deepEqual(last.rtr.flush.map(f => f.id), [B]);
    assert.match(JSON.stringify(last.rtr.flush[0].messages), /Is there a dog\?/);
    assert.deepEqual(h.store.getItem(B).pending, [], 'B answered in the same load');
    assert.equal(h.store.activeVersion(B).dossier.answers.find(a => a.id === 'pb').answer, 'piggy bb');
    assert.match(h.store.activeVersion(B).provenance.requeries[0].trigger, /^piggyback:/);
    // The first pass of a new item also piggybacks.
    const C = 'c'.repeat(64);
    await h.proto.afterRpTurn({ text: `<media_q item="${A.slice(0, 8)}">Anything else?</media_q>`, turn: 2 });
    await h.proto.registerItem({ id: C, title: 'c.mp4' });
    await h.proto.ensureDossier(C);
    assert.deepEqual(h.runs().at(-1).body.rtr.flush.map(f => f.id), [A]);
});

test('T-F8: estimate unknown on first run, learned from RTR timings after; Q3b hint', async () => {
    const h = harness({ mode: 'swap', lfmReason: 'live free 1000 MiB < need 3000 + 512 MiB', settings: { pricePerHour: 0.5 } });
    await h.proto.registerItem({ id: A, title: 'a.mp4' });
    const first = await h.proto.ensureDossier(A);
    assert.equal(first.preview.estimate.label, UNKNOWN_FIRST_RUN);
    assert.equal(first.preview.dollars, null);
    assert.equal(first.preview.hint, 'LFM3 can answer without a swap');
    assert.ok(h.getStats()[`${Q8}|RTX 4090`].load_s.v === 20);
    const pv = await h.proto.preview(h.proto.itemModel(h.store.getItem(A)), 'dossier', 10);
    assert.equal(pv.estimate.known, false, 'RP re-prefill is not measured by RTR');
    assert.ok(pv.estimate.partial > 0);
    const co = harness({ mode: 'coexist' });
    await co.proto.registerItem({ id: A });
    await co.proto.ensureDossier(A);
    const pv2 = await co.proto.preview(co.proto.itemModel(co.store.getItem(A)), 'delta', 10);
    assert.equal(pv2.estimate.known, true);
    assert.equal(pv2.estimate.seconds, 10 * 0.4 + 800 * 0.01);
    assert.equal(pv2.hint, null, 'no hint without a swap');
    const noSet = harness({ mode: 'swap' });
    await noSet.proto.registerItem({ id: A });
    assert.equal((await noSet.proto.ensureDossier(A)).preview.hint, null, 'no hint without an LFM3 coexist set');
});

test('F10: regenerate same / other model / extra questions keeps 3 versions, newest active', async () => {
    const h = harness();
    await h.proto.registerItem({ id: A, title: 'a.mp4' });
    await h.proto.ensureDossier(A);
    await h.proto.regenerate(A, 'same');
    await h.proto.regenerate(A, 'model', { modelKey: 'lfm3' });
    assert.equal(h.runs().at(-1).body.rtr.media_model, LFM);
    assert.equal(h.runs().at(-1).body.max_tokens, 1200);
    await h.proto.regenerate(A, 'questions', { questions: ['Is the cup blue?'] });
    assert.match(JSON.stringify(h.runs().at(-1).body.messages), /Is the cup blue\?/);
    const item = h.store.getItem(A);
    assert.equal(item.versions.length, 3);
    assert.equal(item.versions[0].provenance.model_id, 'LFM3-Omni-2B');
    assert.equal(item.selected_model, 'lfm3');
});

test('protocol: RTR busy / step failure stores nothing and reports an error', async () => {
    const h = harness({ fail: { status: 503, json: { error: { message: 'media swap in progress' } } } });
    await h.proto.registerItem({ id: A });
    const r = await h.proto.ensureDossier(A);
    assert.equal(r.status, 'failed');
    assert.match(r.error, /swap in progress/);
    assert.equal(h.store.activeVersion(A), null);
    assert.ok(h.statuses.some(([, s]) => s?.error));
    const h2 = harness({ fail: { status: 502, json: { error: { message: 'x', step: 'load_mm' }, rtr: { media_model: Q8, mode: 'swap', timings: { load_mm_s: 9 } } } } });
    await h2.proto.registerItem({ id: A });
    assert.equal((await h2.proto.ensureDossier(A)).status, 'failed');
    assert.equal(h2.getStats()[`${Q8}|RTX 4090`].load_s.v, 9, 'timings of a failed step still feed the averages');
});
