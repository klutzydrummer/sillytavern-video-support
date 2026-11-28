/**
 * The media protocol (spec-v2): attach → hash → cache lookup → route by the item's
 * dropdown → question pass (RP) → RTR media call → store → badge. RP replies then
 * get tiers, never media. Follow-up questions are queued and flushed as batched
 * requeries (auto, confirm bar, user Ask, or piggyback).
 *
 * Everything outside this module comes in through `deps`, so the whole flow runs
 * under `node --test` with a stub store, a stub RTR fetch and a stub question pass.
 *
 * Pure module: no SillyTavern imports.
 */

import { compareKey } from './dossier-store.js';
import { PROMPT_VERSION, QUESTION_SCHEMA, questionPrompt, parseQuestionPass, buildCapsule,
    extractionMessages, deltaMessages, DEFAULT_CHECKLIST } from './prompts.js';
import { parseMediaQ, parseFramesTag, enqueue, resolveItemRef, decideRequery, piggybackItems, mergeDelta,
    requeryRecord, removeFlushed, triggerMet } from './queue.js';
import { recordTimings, estimate, dollars, coexistSetExists, lfm3HintVisible, LFM3_HINT } from './estimate.js';
import { resolveMediaModel, modelByLsId, mmMaxTokens, MEDIA_MODELS, DEFAULT_MEDIA_MODEL } from './media-models.js';
import { RtrError, describeRtrError, rtrExtras } from './rtr-client.js';

/**
 * @typedef {object} ProtocolDeps
 * @property {object} store        dossier-store createStore() result
 * @property {object} rtr          rtr-client createRtrClient() result
 * @property {(req: {prompt: string, schema: object, maxTokens: number}) => Promise<string>} askQuestions
 * @property {(itemId: string, item: object) => Promise<{mediaParts: any[], mediaSeconds: number|null}>} getMedia
 * @property {() => object} capsuleContext   {charName, charDescription, messages:[{name,text}]}
 * @property {() => object} settings         resolved settings (settings.js)
 * @property {() => object} getStats
 * @property {(s: object) => void} setStats
 * @property {() => string} [gpu]
 * @property {() => string|null} [rpModel]   LS id of the RP model; null lets RTR pick
 * @property {(lsId: string) => string|undefined} knownMmproj   last mmproj sha seen for a model
 * @property {(lsId: string, sha: string) => void} rememberMmproj
 * @property {(itemId: string, status: object|null) => void} [onStatus]  progress / error for badges
 * @property {(extras: {rpVision: boolean|null, coSet: string|null, gpu: object|null, prefillRpS: number|null}) => void} [onRtrInfo]
 *           RTR extras from each plan or result (newer RTR; all null from older RTR)
 * @property {() => string} [now]
 */

/** @param {ProtocolDeps} deps */
export function createProtocol(deps) {
    const now = deps.now || (() => new Date().toISOString());
    const status = (id, s) => deps.onStatus?.(id, s);
    const gpu = () => deps.gpu?.() || '';
    const inflight = new Map();

    function itemModel(item) {
        const v = item?.versions?.[0];
        if (v) {
            const m = modelByLsId(`${v.provenance.model_id}-${v.provenance.quant}`);
            if (m) return m;
        }
        return resolveMediaModel(item?.selected_model || DEFAULT_MEDIA_MODEL);
    }

    function partsFor(itemId, model) {
        return { media_sha256: itemId, model_id: model.modelId, quant: model.quant, prompt_version: PROMPT_VERSION,
            mmproj_sha256: deps.knownMmproj(model.lsId) ?? '' };
    }

    /**
     * Cache lookup. Before RTR has ever reported this model's mmproj hash, the soft
     * key cannot be checked; a hard-key match then counts as a hit (Open fork).
     */
    function lookupFor(itemId, model) {
        const parts = partsFor(itemId, model);
        if (deps.knownMmproj(model.lsId) === undefined) {
            for (const v of deps.store.getItem(itemId)?.versions ?? []) {
                if (compareKey(v.provenance, { ...parts, mmproj_sha256: v.provenance.mmproj_sha256 }) === 'hit') {
                    return { status: 'hit', version: v, mmprojUnverified: true };
                }
            }
            return { status: 'miss', version: null };
        }
        return deps.store.lookup(itemId, parts);
    }

    /** Register an attached item (idempotent). Item id = media sha256. */
    async function registerItem({ id, title, mediaUrl, messageId, mediaKey }) {
        const order = Math.max(0, ...deps.store.listItems().map(x => x.item.order ?? 0)) + 1;
        await deps.store.updateItem(id, it => {
            if (it.order === undefined) it.order = order;
            if (title && !it.title) it.title = title;
            if (mediaUrl) it.media_url = mediaUrl;
            if (messageId !== undefined) it.message_id = messageId;
            if (!it.selected_model) it.selected_model = mediaKey || DEFAULT_MEDIA_MODEL;
            if (!Array.isArray(it.pending)) it.pending = [];
        });
    }

    async function setSelectedModel(itemId, key) {
        if (!MEDIA_MODELS.some(m => m.key === key)) throw new Error(`unknown media model ${key}`);
        await deps.store.updateItem(itemId, it => { it.selected_model = key; });
    }

    function rtrInfo(res) {
        if (res && typeof res === 'object') deps.onRtrInfo?.(rtrExtras(res));
    }

    async function planFor(model) {
        let plan;
        try { plan = await deps.rtr.plan({ mediaModel: model.lsId, rpModel: deps.rpModel?.() || undefined }); }
        catch { return null; }
        rtrInfo(plan);
        return plan;
    }

    /** Estimate + the Q3b hint for one call. */
    async function preview(model, kind, mediaSeconds) {
        const s = deps.settings();
        const plan = await planFor(model);
        const mode = plan?.mode || 'swap';
        const outTokens = kind === 'delta' ? s.deltaMaxTokens : mmMaxTokens(model, s);
        const est = estimate(deps.getStats(), { mode, mediaModel: model.lsId, rpModel: plan?.rp_model, gpu: gpu(), mediaSeconds: mediaSeconds || 0, outTokens });
        let hint = null;
        if (mode === 'swap' && model.family !== 'lfm3') {
            const lfm3 = MEDIA_MODELS.find(m => m.key === 'lfm3');
            const lp = await planFor(lfm3);
            if (lfm3HintVisible({ mode, mediaModel: model.lsId, lfm3CoSet: coexistSetExists(lp) })) hint = LFM3_HINT;
        }
        return { plan, mode, estimate: est, dollars: dollars(est.seconds, s.pricePerHour), hint };
    }

    function capsule(needs) {
        const s = deps.settings();
        return buildCapsule({ ...deps.capsuleContext(), needs }, s);
    }

    /** Flush entries for other items queued on the same model (Q31a, no confirm). */
    async function piggyback(model, excludeId, cap) {
        const s = deps.settings();
        const items = deps.store.listItems().map(({ id, item }) => ({ id, item, mediaModel: itemModel(item)?.lsId, pending: item.pending || [] }))
            .filter(x => x.item.versions?.length);
        const ids = piggybackItems(items, model.lsId, excludeId);
        const flush = [];
        for (const id of ids) {
            const { item } = items.find(x => x.id === id);
            try {
                const media = await deps.getMedia(id, item);
                flush.push({ id, questions: [...item.pending], messages: deltaMessages({ capsule: cap, mediaParts: media.mediaParts, dossier: item.versions[0].dossier, questions: item.pending }), maxTokens: s.deltaMaxTokens });
            } catch { /* media unavailable here: leave it queued */ }
        }
        return flush;
    }

    /** Apply one delta (main call or flushed) to an item and clear what it answered. */
    async function applyDeltaTo(itemId, delta, { questions, mediaModel, status: st, wallS, trigger, repaired }) {
        const v = deps.store.activeVersion(itemId);
        if (!v || !delta) return null;
        const { dossier, speech } = mergeDelta(v.dossier, delta);
        const record = requeryRecord({ questions, mediaModel, status: st, at: now(), wallS, trigger, repaired });
        delete record.transcript;
        const r = await deps.store.applyDelta(itemId, { dossier, speech, record });
        const ids = questions.map(q => q.id);
        await deps.store.updateItem(itemId, it => { it.pending = removeFlushed(it.pending, ids); });
        return r;
    }

    async function applyFlushed(res, flush, trigger) {
        for (const f of res?.flushed || []) {
            const sent = flush.find(x => x.id === f.id);
            if (!sent || f.status === 'failed' || !f.delta) continue;
            await applyDeltaTo(f.id, f.delta, { questions: sent.questions, mediaModel: res.media_model, status: f.status, wallS: res.timings?.flush_s, trigger: `piggyback:${trigger}`, repaired: f.repaired });
        }
    }

    function learn(res, mediaSeconds) {
        if (!res) return;
        rtrInfo(res);
        deps.setStats(recordTimings(deps.getStats(), res, { gpu: gpu(), mediaSeconds }));
        if (typeof res.mmproj_sha256 === 'string' && res.mmproj_sha256) deps.rememberMmproj(res.media_model, res.mmproj_sha256);
    }

    /**
     * Make sure an item has a dossier. A hit never calls the media model; stale is
     * returned as stale (F14) unless `force`.
     * @returns {Promise<{status: 'hit'|'stale'|'created'|'failed', version?: object, error?: string, preview?: object}>}
     */
    async function ensureDossier(itemId, { force = false, extraQuestions = [], modelKey } = {}) {
        const key = `d:${itemId}`;
        if (inflight.has(key)) return inflight.get(key);
        const p = (async () => {
            const item = deps.store.getItem(itemId);
            const model = resolveMediaModel(modelKey || item?.selected_model || DEFAULT_MEDIA_MODEL);
            if (!model) return { status: 'failed', error: 'no media model' };
            if (!force) {
                const hit = lookupFor(itemId, model);
                if (hit.status === 'hit' || hit.status === 'stale') return { status: hit.status, version: hit.version };
            }
            const s = deps.settings();
            let media;
            try { media = await deps.getMedia(itemId, item); }
            catch (err) { status(itemId, { error: `media unavailable: ${err?.message || err}` }); return { status: 'failed', error: 'media unavailable' }; }
            status(itemId, { busy: { label: 'asking the RP model what to look for…' } });
            let qp = { questions: [], needs: '', ok: false };
            try {
                const raw = await deps.askQuestions({ prompt: questionPrompt(s.maxQuestions, item?.title), schema: QUESTION_SCHEMA, maxTokens: s.questionMaxTokens });
                qp = parseQuestionPass(raw, s.maxQuestions);
            } catch { /* no questions: the media model gives a general dossier */ }
            const questions = [...qp.questions];
            for (const t of extraQuestions) if (t && String(t).trim()) questions.push({ id: `x${questions.length + 1}`, text: String(t).trim() });
            const pv = await preview(model, 'dossier', media.mediaSeconds);
            status(itemId, { busy: { label: `${model.label}: ${pv.estimate.label}` }, preview: pv });
            const cap = capsule(qp.needs);
            const flush = await piggyback(model, itemId, cap);
            const messages = extractionMessages({ capsule: cap, mediaParts: media.mediaParts, questions, checklist: DEFAULT_CHECKLIST, title: item?.title });
            let res;
            try {
                res = await deps.rtr.run({ messages, mediaModel: model.lsId, rpModel: deps.rpModel?.() || undefined, kind: 'dossier', maxTokens: mmMaxTokens(model, s), flush });
            } catch (err) {
                if (err instanceof RtrError && err.res) learn(err.res, media.mediaSeconds);
                const msg = describeRtrError(err);
                status(itemId, { error: msg });
                return { status: 'failed', error: msg, preview: pv };
            }
            learn(res, media.mediaSeconds);
            if (!res.result || (res.status !== 'ok' && res.status !== 'partial')) {
                const msg = `media model returned ${res.status || 'nothing'}`;
                status(itemId, { error: msg });
                return { status: 'failed', error: msg, preview: pv };
            }
            const parts = { ...partsFor(itemId, model), mmproj_sha256: res.mmproj_sha256 || '' };
            const [stored] = await deps.store.completePass([{ itemId, parts, dossier: res.result, llama_build: res.llama_build ?? null,
                wall_s: res.timings?.total_s ?? 0, status: res.status, message_id: item?.message_id }]);
            await deps.store.updateItem(itemId, it => {
                it.questions = questions;
                if (modelKey) it.selected_model = modelKey;
            });
            await applyFlushed(res, flush, 'first-pass');
            status(itemId, null);
            return { status: 'created', version: stored.version, badge: stored.badge, preview: pv };
        })();
        inflight.set(key, p);
        try { return await p; } finally { inflight.delete(key); }
    }

    /**
     * Flush an item's pending queue as one batched requery (kind "delta").
     * @param {'auto'|'user'|'confirm'} trigger
     */
    async function requery(itemId, trigger = 'user', { turn } = {}) {
        const key = `r:${itemId}`;
        if (inflight.has(key)) return inflight.get(key);
        const p = (async () => {
            const item = deps.store.getItem(itemId);
            const pending = [...(item?.pending || [])];
            if (!pending.length || !item.versions?.length) return { status: 'none' };
            const model = itemModel(item);
            const s = deps.settings();
            let media;
            try { media = await deps.getMedia(itemId, item); }
            catch (err) { status(itemId, { error: `media unavailable: ${err?.message || err}` }); return { status: 'failed', error: 'media unavailable' }; }
            if (trigger === 'auto') await deps.store.updateItem(itemId, it => { it.auto_turn = turn; });
            status(itemId, { busy: { label: `asking ${model.label} ${pending.length} question${pending.length === 1 ? '' : 's'}…` } });
            const cap = capsule('');
            const flush = await piggyback(model, itemId, cap);
            const messages = deltaMessages({ capsule: cap, mediaParts: media.mediaParts, dossier: item.versions[0].dossier, questions: pending });
            let res;
            try {
                res = await deps.rtr.run({ messages, mediaModel: model.lsId, rpModel: deps.rpModel?.() || undefined, kind: 'delta', maxTokens: s.deltaMaxTokens, flush });
            } catch (err) {
                if (err instanceof RtrError && err.res) learn(err.res, media.mediaSeconds);
                const msg = describeRtrError(err);
                status(itemId, { error: msg });
                return { status: 'failed', error: msg };
            }
            learn(res, media.mediaSeconds);
            if (res.result && (res.status === 'ok' || res.status === 'partial')) {
                await applyDeltaTo(itemId, res.result, { questions: pending, mediaModel: res.media_model, status: res.status, wallS: res.timings?.total_s, trigger });
            }
            await applyFlushed(res, flush, trigger);
            status(itemId, null);
            return { status: res.status };
        })();
        inflight.set(key, p);
        try { return await p; } finally { inflight.delete(key); }
    }

    /**
     * After an RP reply: strip <media_q> and <frames>, queue the questions, decide per item.
     * Frame requests are only resolved to items here (an empty or unknown item falls back
     * to the active item, else the only item); the caller decides whether frames are on.
     * Auto requeries are started (not awaited) and returned as promises.
     * @returns {Promise<{text: string, decisions: Array<{itemId, action, reason, preview?}>, auto: Promise[],
     *   frames: Array<{itemId: string, times: number[]}>}>}
     */
    async function afterRpTurn({ text, turn, activeItemId = null }) {
        const { text: noQ, questions } = parseMediaQ(text);
        const { text: shown, requests } = parseFramesTag(noQ);
        const items = deps.store.listItems().filter(x => x.item.versions?.length)
            .map(x => ({ id: x.id, title: x.item.title }));
        const frameFallback = activeItemId ?? (items.length === 1 ? items[0].id : null);
        const framesByItem = new Map();
        for (const r of requests) {
            const id = resolveItemRef(r.item, items, frameFallback);
            if (!id) continue;
            framesByItem.set(id, [...(framesByItem.get(id) || []), ...r.times]);
        }
        const frames = [...framesByItem].map(([itemId, times]) => ({ itemId, times }));
        const byItem = new Map();
        for (const q of questions) {
            const id = resolveItemRef(q.item, items, activeItemId);
            if (!id) continue;
            if (!byItem.has(id)) byItem.set(id, []);
            byItem.get(id).push(q);
        }
        for (const [id, qs] of byItem) {
            await deps.store.updateItem(id, it => { it.pending = enqueue(it.pending, qs, { turn, now }).pending; }, { save: false });
        }
        // One save for the queue change when anything was queued.
        if (byItem.size) await deps.store.updateItem([...byItem.keys()][0], () => {});
        const decisions = [];
        const auto = [];
        const s = deps.settings();
        for (const { id, item } of deps.store.listItems()) {
            if (!item.versions?.length || !triggerMet(item.pending, s)) continue;
            const model = itemModel(item);
            const pv = await preview(model, 'delta', null);
            const d = decideRequery({ pending: item.pending, mode: pv.mode, wouldEvict: pv.plan?.would_evict ?? null, settings: s,
                turn, lastAutoTurn: item.auto_turn, estimateS: pv.estimate.seconds });
            decisions.push({ itemId: id, ...d, preview: pv });
            if (d.action === 'auto') auto.push(requery(id, 'auto', { turn }));
        }
        return { text: shown, questions, decisions, auto, frames };
    }

    /** Add user questions to an item's queue (Ask). */
    async function ask(itemId, texts, { blocking = true, turn = 0 } = {}) {
        await deps.store.updateItem(itemId, it => { it.pending = enqueue(it.pending, texts.map(text => ({ text, blocking })), { turn, now }).pending; });
        return requery(itemId, 'user', { turn });
    }

    /**
     * Regenerate (F10): one dialog, three choices. Each makes a new version (max 3,
     * newest active). 'questions' reruns the first pass with the extra questions added.
     */
    async function regenerate(itemId, choice, { modelKey, questions = [] } = {}) {
        if (choice === 'model') return ensureDossier(itemId, { force: true, modelKey });
        if (choice === 'questions') return ensureDossier(itemId, { force: true, extraQuestions: questions });
        return ensureDossier(itemId, { force: true });
    }

    /** Items for the tiers: active version + stale flag (F14) + order + title. */
    function tierItems() {
        return deps.store.listItems().filter(x => x.item.versions?.length).map(({ id, item }) => {
            const v = item.versions[0];
            const model = modelByLsId(`${v.provenance.model_id}-${v.provenance.quant}`);
            const known = model ? deps.knownMmproj(model.lsId) : undefined;
            const stale = known !== undefined && compareKey(v.provenance, { ...v.provenance, mmproj_sha256: known }) === 'stale';
            return { id, title: item.title || '', order: item.order ?? 0, version: v, stale };
        });
    }

    return { registerItem, setSelectedModel, ensureDossier, requery, afterRpTurn, ask, regenerate, tierItems, lookupFor, preview, itemModel };
}
