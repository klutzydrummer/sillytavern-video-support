import test from 'node:test';
import assert from 'node:assert/strict';
import { ema, recordTimings, estimate, dollars, coexistSetExists, lfm3HintVisible, statKey, UNKNOWN_FIRST_RUN, EMA_ALPHA } from './estimate.js';

const MM = 'Qwen3-Omni-30B-A3B-Instruct-Q8_0', RP = 'rp-model', GPU = 'RTX 4090';

function swapRes(over = {}) {
    return {
        media_model: MM, rp_model: RP, mode: 'swap', status: 'ok',
        timings: { unload_rp_s: 2, load_mm_s: 20, extract_s: 30, unload_mm_s: 1, reload_rp_s: 10, total_s: 63 },
        llama_timings: { prompt_ms: 20000, predicted_ms: 10000, predicted_n: 500 },
        ...over,
    };
}

test('T-F8: "unknown, first run" before any measurement', () => {
    const e = estimate({}, { mode: 'swap', mediaModel: MM, rpModel: RP, gpu: GPU, mediaSeconds: 10, outTokens: 2500 });
    assert.equal(e.seconds, null);
    assert.equal(e.label, UNKNOWN_FIRST_RUN);
    assert.equal(dollars(e.seconds, 1), null);
});

test('T-F8: swap formula from RTR timings (all seven terms)', () => {
    let st = recordTimings({}, swapRes(), { gpu: GPU, mediaSeconds: 10 });
    // RP re-prefill is not timed by RTR: estimate stays unknown but the partial sum is right.
    const q = { mode: 'swap', mediaModel: MM, rpModel: RP, gpu: GPU, mediaSeconds: 10, outTokens: 1000 };
    let e = estimate(st, q);
    assert.deepEqual(e.terms.map(t => t.name), ['t_unload_rp', 't_load_mm', 't_mm_prefill', 't_mm_gen', 't_unload_mm', 't_load_rp', 't_rp_prefill']);
    assert.equal(e.known, false);
    // 2 + 20 + (20s/10s media)*10 + (10s/500 tok)*1000 + 1 + 10 = 73
    assert.equal(e.partial, 73);
    st[statKey(RP, GPU)].prefill_ctx_s = { v: 4, n: 1 };
    e = estimate(st, q);
    assert.equal(e.seconds, 77);
    assert.equal(e.label, '~1 min 17 s');
    assert.ok(Math.abs(dollars(e.seconds, 0.72) - 77 * 0.72 / 3600) < 1e-12);
    assert.equal(dollars(e.seconds, ''), null, '$ unknown without a $/h setting');
});

test('T-F8: coexist uses only MM prefill + gen', () => {
    const st = recordTimings({}, swapRes(), { gpu: GPU, mediaSeconds: 10 });
    const e = estimate(st, { mode: 'coexist', mediaModel: MM, rpModel: RP, gpu: GPU, mediaSeconds: 5, outTokens: 100 });
    assert.deepEqual(e.terms.map(t => t.name), ['t_mm_prefill', 't_mm_gen']);
    assert.equal(e.seconds, 2 * 5 + 0.02 * 100);
});

test('T-F8: moving averages per (model, quant, GPU)', () => {
    assert.deepEqual(ema(undefined, 10), { v: 10, n: 1 });
    assert.deepEqual(ema({ v: 10, n: 1 }, 20), { v: 10 + EMA_ALPHA * 10, n: 2 });
    let st = recordTimings({}, swapRes(), { gpu: GPU, mediaSeconds: 10 });
    st = recordTimings(st, swapRes({ timings: { ...swapRes().timings, load_mm_s: 30 } }), { gpu: GPU, mediaSeconds: 10 });
    assert.equal(st[statKey(MM, GPU)].load_s.v, 20 + EMA_ALPHA * 10);
    assert.equal(st[statKey(MM, 'A100')], undefined, 'GPU is part of the key');
    const q4 = 'Qwen3-Omni-30B-A3B-Instruct-Q4_K_M';
    assert.equal(st[statKey(q4, GPU)], undefined, 'quant is part of the key (in the LS id)');
    // coexist without a load leaves load_s alone; a failed step result still counts.
    const co = recordTimings(st, { media_model: MM, rp_model: RP, mode: 'coexist', timings: { extract_s: 5 }, llama_timings: { prompt_ms: 1000, predicted_ms: 1000, predicted_n: 100 } }, { gpu: GPU, mediaSeconds: 10 });
    assert.equal(co[statKey(MM, GPU)].load_s.v, st[statKey(MM, GPU)].load_s.v);
    assert.equal(co[statKey(MM, GPU)].unload_s.n, 2);
});

test('T-F8: Q3b hint only on a swap with an LFM3 coexist set (OQ-E6)', () => {
    const lfmPlan = (reason, mode = 'swap') => ({ mode, reason });
    assert.equal(coexistSetExists(lfmPlan('no coexist set for this RP and media model')), false);
    assert.equal(coexistSetExists(lfmPlan('no RP loaded', 'solo')), false);
    assert.equal(coexistSetExists(lfmPlan('live free 1000 MiB < need 3000 + 512 MiB')), true);
    assert.equal(coexistSetExists(lfmPlan('free VRAM or media size unknown')), true);
    assert.equal(coexistSetExists(lfmPlan('coexist set and live VRAM fit', 'coexist')), true);
    assert.equal(coexistSetExists(null), false);
    assert.equal(lfm3HintVisible({ mode: 'swap', mediaModel: MM, lfm3CoSet: true }), true);
    assert.equal(lfm3HintVisible({ mode: 'coexist', mediaModel: MM, lfm3CoSet: true }), false);
    assert.equal(lfm3HintVisible({ mode: 'swap', mediaModel: MM, lfm3CoSet: false }), false);
    assert.equal(lfm3HintVisible({ mode: 'swap', mediaModel: 'LFM3-Omni-2B-Q8_0', lfm3CoSet: true }), false);
});
