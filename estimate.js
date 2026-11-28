/**
 * Time and cost estimates (spec-v2 §estimate, Q13a, Q3b, OQ-E6).
 *
 * swap:    t_unload_rp + t_load_mm + t_mm_prefill(media_s) + t_mm_gen(out_tokens)
 *          + t_unload_mm + t_load_rp + t_rp_prefill(ctx)
 * coexist: t_mm_prefill(media_s) + t_mm_gen(out_tokens)
 *
 * Each term is a moving average per (model, quant, GPU), fed by RTR timings and
 * stored in extension settings. Before any measurement a term is unknown and the
 * estimate reads "unknown, first run". Rates (per media second, per output token)
 * are averaged so they scale with the item.
 *
 * Pure module: no SillyTavern imports.
 */

/** EMA weight of a new sample. [I] */
export const EMA_ALPHA = 0.3;

export const UNKNOWN_FIRST_RUN = 'unknown, first run';

export function statKey(model, gpu) {
    return `${model || '?'}|${gpu || '?'}`;
}

/** The model id carries the quant (LS ids end in -Q8_0 / -Q4_K_M), so model|gpu is model|quant|gpu. */
export function ema(prev, sample, alpha = EMA_ALPHA) {
    if (!Number.isFinite(sample) || sample < 0) return prev;
    if (!prev || !Number.isFinite(prev.v)) return { v: sample, n: 1 };
    return { v: prev.v + alpha * (sample - prev.v), n: (prev.n || 1) + 1 };
}

function num(x) {
    const n = Number(x);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Fold one RTR response into the averages. Returns a new stats object.
 * @param {object} stats  { [statKey]: { load_s, unload_s, prefill_per_media_s, gen_per_token_s, ... } }
 * @param {object} res    the `rtr` result from a 200 or 502 response
 * @param {{gpu: string, mediaSeconds?: number}} ctx
 */
export function recordTimings(stats, res, ctx) {
    const out = JSON.parse(JSON.stringify(stats || {}));
    if (!res || typeof res !== 'object') return out;
    const t = res.timings || {};
    const gpu = ctx?.gpu || '';
    const put = (model, field, sample) => {
        if (!model || sample === null) return;
        const k = statKey(model, gpu);
        out[k] = out[k] || {};
        out[k][field] = ema(out[k][field], sample);
    };
    const mm = res.media_model, rp = res.rp_model;
    const swap = res.mode === 'swap';
    // Load/unload terms only mean something when the step actually ran.
    if (swap) {
        put(rp, 'unload_s', num(t.unload_rp_s));
        put(rp, 'load_s', num(t.reload_rp_s));
        put(mm, 'unload_s', num(t.unload_mm_s));
    }
    if (res.mode !== 'coexist' || num(t.load_mm_s) > 0) put(mm, 'load_s', num(t.load_mm_s));
    const lt = res.llama_timings || {};
    const usage = res.usage || {};
    const promptS = num(lt.prompt_ms) !== null ? lt.prompt_ms / 1000 : null;
    const genS = num(lt.predicted_ms) !== null ? lt.predicted_ms / 1000 : null;
    const outTok = num(lt.predicted_n) ?? num(usage.completion_tokens);
    const mediaS = num(ctx?.mediaSeconds);
    if (promptS !== null && mediaS) put(mm, 'prefill_per_media_s', promptS / mediaS);
    if (genS !== null && outTok) put(mm, 'gen_per_token_s', genS / outTok);
    // Without llama timings, fall back to extract_s as one lump for this model.
    if (promptS === null && genS === null) put(mm, 'extract_s', num(t.extract_s));
    // Newer RTR times the RP re-read after a swap reload (null in coexist / when kept).
    if (swap) put(rp, 'prefill_ctx_s', num(t.prefill_rp_s));
    return out;
}

/**
 * @param {object} stats
 * @param {{mode: 'swap'|'coexist'|'solo', mediaModel: string, rpModel?: string, gpu: string,
 *   mediaSeconds: number, outTokens: number}} q
 * @returns {{seconds: number|null, known: boolean, terms: Array<{name: string, s: number|null}>, label: string}}
 */
export function estimate(stats, q) {
    const s = stats || {};
    const mm = s[statKey(q.mediaModel, q.gpu)] || {};
    const rp = q.rpModel ? s[statKey(q.rpModel, q.gpu)] || {} : {};
    const v = (o, f) => (o[f] && Number.isFinite(o[f].v) ? o[f].v : null);
    const terms = [];
    if (q.mode === 'swap') {
        terms.push({ name: 't_unload_rp', s: v(rp, 'unload_s') });
        terms.push({ name: 't_load_mm', s: v(mm, 'load_s') });
    } else if (q.mode === 'solo') {
        terms.push({ name: 't_load_mm', s: v(mm, 'load_s') });
    }
    const pre = v(mm, 'prefill_per_media_s'), gen = v(mm, 'gen_per_token_s'), lump = v(mm, 'extract_s');
    if (pre === null && gen === null && lump !== null) {
        terms.push({ name: 't_mm_extract', s: lump });
    } else {
        terms.push({ name: 't_mm_prefill', s: pre === null ? null : pre * (q.mediaSeconds || 0) });
        terms.push({ name: 't_mm_gen', s: gen === null ? null : gen * (q.outTokens || 0) });
    }
    if (q.mode === 'swap') {
        terms.push({ name: 't_unload_mm', s: v(mm, 'unload_s') });
        terms.push({ name: 't_load_rp', s: v(rp, 'load_s') });
        // Learned from RTR timings.prefill_rp_s when RTR re-reads the chat; unknown until then.
        terms.push({ name: 't_rp_prefill', s: v(rp, 'prefill_ctx_s') });
    }
    const known = terms.every(t => t.s !== null);
    const partial = terms.reduce((a, t) => a + (t.s || 0), 0);
    const seconds = known ? partial : null;
    return { seconds, known, partial, terms, label: known ? formatSeconds(seconds) : UNKNOWN_FIRST_RUN };
}

export function formatSeconds(s) {
    if (!Number.isFinite(s)) return UNKNOWN_FIRST_RUN;
    if (s < 60) return `~${Math.max(1, Math.round(s))} s`;
    const m = Math.floor(s / 60), r = Math.round(s % 60);
    return `~${m} min${r ? ` ${r} s` : ''}`;
}

/** $ = seconds × $/h. Null when either is unknown. */
export function dollars(seconds, pricePerHour) {
    const p = Number(pricePerHour);
    if (!Number.isFinite(seconds) || pricePerHour === '' || pricePerHour === null || !Number.isFinite(p)) return null;
    return seconds * p / 3600;
}

export function formatDollars(d) {
    return d === null ? '' : `$${d < 0.01 ? d.toFixed(4) : d.toFixed(2)}`;
}

/**
 * Does an LFM3 coexist set exist for this RP? Newer RTR reports `co_set` (the set
 * name, or null for none); older RTR does not, so this falls back to the plan
 * reason [U]. `coSets` from settings wins when given.
 */
export function coexistSetExists(plan, { coSets } = {}) {
    if (Array.isArray(coSets)) return coSets.length > 0;
    if (plan && typeof plan.co_set === 'boolean') return plan.co_set;
    if (plan && typeof plan.co_set === 'string') return plan.co_set.length > 0;
    if (plan && 'co_set' in plan && plan.co_set === null) return false;
    // rtr.py plan(): only 'no coexist set…' and 'no RP loaded' say nothing about a set;
    // every later branch ('free VRAM … unknown', 'live free …', 'coexist set and live
    // VRAM fit') is reached only when the set exists, even when it falls back to swap.
    if (!plan) return false;
    const r = String(plan.reason || '');
    if (/no coexist set|no RP loaded/i.test(r)) return false;
    return plan.mode === 'coexist' || /free VRAM|live free|coexist set/i.test(r);
}

/**
 * Q3b / OQ-E6: show "LFM3 can answer without a swap" on any swap when an LFM3
 * coexist set exists for this RP. No threshold.
 * @param {{mode: string, mediaModel: string, lfm3Plan?: object, lfm3CoSet?: boolean}} p
 */
export function lfm3HintVisible({ mode, mediaModel, lfm3CoSet }) {
    if (mode !== 'swap') return false;
    if (/^LFM3/i.test(String(mediaModel || ''))) return false;
    return lfm3CoSet === true;
}

export const LFM3_HINT = 'LFM3 can answer without a swap';
