/**
 * Client for the RTR media router (vastai-llmrunner rtr.py, P3 contract).
 *
 * POST {base}/v1/chat/completions, model "media-dossier", top-level
 * rtr: {media_model, rp_model?, kind, dry_run?, flush?}. A 200 carries the result
 * in `rtr`; a failed step is 502 {error:{step}, rtr}; a held lock is 503; a bad
 * request is 400. Newer RTR adds rp_vision, co_set, gpu, timings.prefill_rp_s and
 * flushed[].repaired; all are optional here. Fetch is injected so tests stub it.
 *
 * Pure module: no SillyTavern imports.
 */

export const RTR_MODEL = 'media-dossier';

/** Top-level result fields newer RTR adds (vastai fa-report Item 4). Any may be missing. */
export const RTR_EXTRAS = ['rp_vision', 'co_set', 'gpu'];

/**
 * The RTR extras from a result or merged plan, normalised; missing → null.
 * @returns {{rpVision: boolean|null, coSet: string|null, gpu: object|null, prefillRpS: number|null}}
 */
export function rtrExtras(res) {
    const r = res && typeof res === 'object' ? res : {};
    const p = Number(r.timings?.prefill_rp_s);
    return {
        rpVision: typeof r.rp_vision === 'boolean' ? r.rp_vision : null,
        coSet: typeof r.co_set === 'string' && r.co_set ? r.co_set : null,
        gpu: r.gpu && typeof r.gpu === 'object' ? r.gpu : null,
        prefillRpS: r.timings?.prefill_rp_s != null && Number.isFinite(p) && p >= 0 ? p : null,
    };
}

export class RtrError extends Error {
    constructor(message, { kind, status = null, step = null, res = null } = {}) {
        super(message);
        this.name = 'RtrError';
        this.kind = kind;     // 'busy' | 'step' | 'request' | 'network' | 'protocol'
        this.status = status;
        this.step = step;
        this.res = res;       // the rtr result on 502 (timings, plan, partial result)
    }
}

/** User-facing text for an RtrError. */
export function describeRtrError(err) {
    switch (err?.kind) {
    case 'busy': return 'Media swap in progress; try again shortly.';
    case 'step': return `Media step failed${err.step ? ` (${err.step})` : ''}: ${err.message}`;
    case 'request': return `Media request rejected: ${err.message}`;
    case 'network': return 'Media server unreachable (instance gone or tunnel down).';
    default: return `Media server error: ${err?.message || err}`;
    }
}

/**
 * @param {{fetch: Function, baseUrl: string, headers?: () => object, timeoutMs?: number}} deps
 */
export function createRtrClient({ fetch, baseUrl, headers, timeoutMs = 0 }) {
    const url = `${String(baseUrl || '').replace(/\/+$/, '')}/v1/chat/completions`;

    async function post(body) {
        let resp;
        const ctl = timeoutMs && typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
        try {
            resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(headers ? headers() : {}) },
                body: JSON.stringify(body),
                ...(ctl ? { signal: ctl.signal } : {}),
            });
        } catch (err) {
            throw new RtrError(String(err?.message || err), { kind: 'network' });
        } finally {
            if (timer) clearTimeout(timer);
        }
        let data = null;
        try { data = await resp.json(); } catch { data = null; }
        if (resp.status === 200) {
            if (!data || typeof data !== 'object' || !data.rtr) throw new RtrError('response has no rtr result', { kind: 'protocol', status: 200 });
            return data.rtr;
        }
        const msg = data?.error?.message || `HTTP ${resp.status}`;
        if (resp.status === 503) throw new RtrError(msg, { kind: 'busy', status: 503 });
        if (resp.status === 502) throw new RtrError(msg, { kind: 'step', status: 502, step: data?.error?.step ?? null, res: data?.rtr ?? null });
        if (resp.status === 400) throw new RtrError(msg, { kind: 'request', status: 400 });
        throw new RtrError(msg, { kind: resp.status >= 500 ? 'network' : 'protocol', status: resp.status });
    }

    function body({ messages, mediaModel, rpModel, kind, maxTokens, dryRun, flush }) {
        const rtr = { media_model: mediaModel, kind };
        if (rpModel) rtr.rp_model = rpModel;
        if (dryRun) rtr.dry_run = true;
        if (flush?.length) rtr.flush = flush.map(f => ({ id: f.id, messages: f.messages, ...(f.maxTokens ? { max_tokens: f.maxTokens } : {}) }));
        return { model: RTR_MODEL, messages: messages || [{ role: 'user', content: 'plan' }], ...(maxTokens ? { max_tokens: maxTokens } : {}), stream: false, rtr };
    }

    return {
        url,
        /**
         * Dry run: the plan (mode, would_evict, reason) plus the RTR extras rp_vision,
         * co_set and gpu when this RTR reports them (older RTR: absent). No model is touched.
         */
        async plan({ mediaModel, rpModel }) {
            const res = await post(body({ mediaModel, rpModel, kind: 'dossier', dryRun: true }));
            if (!res.plan) return res;
            const out = { ...res.plan };
            for (const k of RTR_EXTRAS) if (k in res && !(k in out)) out[k] = res[k];
            return out;
        },
        /** First pass or requery. Returns the full rtr result. */
        async run({ messages, mediaModel, rpModel, kind, maxTokens, flush }) {
            return post(body({ messages, mediaModel, rpModel, kind, maxTokens, flush }));
        },
    };
}
