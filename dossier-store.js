/**
 * Media dossier storage (spec-v2 §1.2 step 10, §1.3; decisions F7+Q21, F8+Q22-Q24,
 * F9+Q5-Q9, F10, F14, OQ-E2/E3/E5, OQ-B4).
 *
 * - chatMetadata[NS] holds only the summary dossier + provenance + transcript pointer.
 * - The transcript (timeline entries of kind `speech` only) always goes to an
 *   uploaded user file `md-<hex>.json`; pointer {path, sha256, bytes}.
 * - No upload available -> dossier only, pointer null, badge "transcript not kept".
 * - Pointer set but file missing or sha256/bytes mismatch -> same fallback with
 *   badge "transcript not on this device".
 * - Up to 3 versions per item, newest first and active. Dropped versions' files are
 *   never deleted (Q7a).
 * - Branch: when main_chat is set and the namespace is absent, copy everything from
 *   the parent with one read of its metadata. Pointers are shared; nothing is pruned.
 * - One saveMetadata() per completed pass.
 *
 * Everything SillyTavern-facing goes through an adapter (see createStore), so the
 * module has no ST imports and runs under plain `node --test`.
 */

import { sha256, HASH_PATH_JS, HASH_PATH_SUBTLE } from './hash.js';
import { bytesToBase64 } from './video-utils.js';

export const NS = 'video_support_dossiers';
export const STORE_SCHEMA = 'mdstore/1';
export const TRANSCRIPT_SCHEMA = 'md-transcript/1';
export const MAX_VERSIONS = 3;
export const SELFTEST_META_KEY = 'video_support_storage_selftest';

export const BADGE_NOT_KEPT = 'transcript not kept';
export const BADGE_NOT_ON_DEVICE = 'transcript not on this device';

/** Five-part cache key (F7 amended by Q21). The first four are hard; mmproj is soft. */
export const HARD_KEY_PARTS = ['media_sha256', 'model_id', 'quant', 'prompt_version'];
export const SOFT_KEY_PARTS = ['mmproj_sha256'];
export const KEY_PARTS = [...HARD_KEY_PARTS, ...SOFT_KEY_PARTS];

/** Canonical key string. llama_build is deliberately not part of it (info only, Q21). */
export function makeKey(parts) {
    for (const p of HARD_KEY_PARTS) {
        if (typeof parts?.[p] !== 'string' || !parts[p]) throw new Error(`cache key part missing: ${p}`);
    }
    return JSON.stringify(['md1', ...KEY_PARTS.map(p => parts[p] ?? '')]);
}

/**
 * Compare stored provenance with the parts of a request.
 * @returns {'hit'|'stale'|'miss'} stale = hard parts match, mmproj hash differs
 */
export function compareKey(prov, parts) {
    for (const p of HARD_KEY_PARTS) if ((prov?.[p] ?? '') !== (parts?.[p] ?? '')) return 'miss';
    for (const p of SOFT_KEY_PARTS) if ((prov?.[p] ?? '') !== (parts?.[p] ?? '')) return 'stale';
    return 'hit';
}

/** Split a dossier into the metadata part and the transcript (speech entries only, OQ-E2). */
export function splitDossier(dossier) {
    const timeline = Array.isArray(dossier?.timeline) ? dossier.timeline : [];
    const speech = timeline.filter(e => e?.kind === 'speech');
    return { summary: { ...dossier, timeline: timeline.filter(e => e?.kind !== 'speech') }, speech };
}

/** The on-open copy trigger (OQ-E5): only when main_chat is set and the namespace is absent. */
export function shouldCopyFromParent(meta) {
    return !!meta && typeof meta.main_chat === 'string' && meta.main_chat !== '' && meta[NS] == null;
}

function clone(v) {
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function defaultNonce() {
    const b = new Uint8Array(8);
    if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(b);
    else for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
    return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

/**
 * @typedef {object} StoreAdapter
 * @property {() => object} getChatMetadata            live, mutable chatMetadata of the open chat
 * @property {() => Promise<void>} saveMetadata         persist chatMetadata
 * @property {(name: string, base64: string) => Promise<string>} [uploadFile]  /api/files/upload; returns the path
 * @property {(path: string) => Promise<Uint8Array|null>} [readFile]           null when the file is absent
 * @property {(chatName: string) => Promise<object|null>} [readChatMetadata]   metadata of a saved chat (parent / reload)
 * @property {() => string|null} [getCurrentChatName]
 * @property {(path: string) => Promise<void>} [deleteFile]                    self-test cleanup only
 * @property {{subtle?: any, forceJs?: boolean}} [hashOptions]
 * @property {() => string} [now]    ISO time
 * @property {() => string} [nonce]  random hex
 */

/** @param {StoreAdapter} adapter */
export function createStore(adapter) {
    const now = adapter.now || (() => new Date().toISOString());
    const nonce = adapter.nonce || defaultNonce;
    const hash = (data) => sha256(data, adapter.hashOptions || {});
    let notKeptNoticePending = false;
    let notKeptNoticeShown = false;

    function meta() {
        const m = adapter.getChatMetadata();
        if (!m || typeof m !== 'object') throw new Error('chatMetadata unavailable');
        return m;
    }

    function ns(create = false) {
        const m = meta();
        if (m[NS] == null && create) m[NS] = { schema: STORE_SCHEMA, items: {} };
        return m[NS] ?? null;
    }

    /** Upload the transcript. Returns the pointer, or null when upload is unavailable or fails. */
    async function writeTranscript(key, versionId, speech) {
        if (typeof adapter.uploadFile !== 'function') return { pointer: null, reason: 'upload unavailable' };
        try {
            const body = JSON.stringify({ schema: TRANSCRIPT_SCHEMA, key, version_id: versionId, speech });
            const bytes = new TextEncoder().encode(body);
            const nameHash = await hash(`${key}\n${versionId}`);
            const contentHash = await hash(bytes);
            const path = await adapter.uploadFile(`md-${nameHash.hex}.json`, bytesToBase64(bytes));
            if (typeof path !== 'string' || !path) throw new Error('no path returned');
            return { pointer: { path, sha256: contentHash.hex, bytes: bytes.length } };
        } catch (err) {
            return { pointer: null, reason: String(err?.message || err) };
        }
    }

    /**
     * Store the results of one completed pass: upload each transcript, write every
     * version into chatMetadata, then call saveMetadata() once.
     * @param {Array<{itemId?: string, parts: object, dossier: object, llama_build?: string,
     *   wall_s?: number, status?: string, requeries?: any[], message_id?: number}>} results
     * @returns {Promise<Array<{itemId: string, version: object, badge: string|null, reason?: string}>>}
     */
    async function completePass(results) {
        const prepared = [];
        const seqs = new Map();
        for (const r of results) {
            const key = makeKey(r.parts);
            const itemId = r.itemId || r.parts.media_sha256;
            const created = now();
            const seq = seqs.get(itemId) ?? ns()?.items?.[itemId]?.next_seq ?? 1;
            seqs.set(itemId, seq + 1);
            const versionId = `${seq}.${created}.${nonce()}`;
            const { summary, speech } = splitDossier(r.dossier);
            const { pointer, reason } = await writeTranscript(key, versionId, speech);
            const provenance = {
                key,
                ...Object.fromEntries(KEY_PARTS.map(p => [p, r.parts[p] ?? ''])),
                llama_build: r.llama_build ?? null,
                created,
                wall_s: r.wall_s ?? 0,
                status: r.status || 'ok',
                requeries: r.requeries || [],
                transcript: pointer,
            };
            prepared.push({ itemId, version: { version_id: versionId, seq, provenance, dossier: summary },
                message_id: r.message_id, badge: pointer ? null : BADGE_NOT_KEPT, reason });
        }
        const store = ns(true);
        for (const p of prepared) {
            const item = store.items[p.itemId] ?? (store.items[p.itemId] = { versions: [], next_seq: 1 });
            if (p.message_id !== undefined) item.message_id = p.message_id;
            item.versions.unshift(p.version);
            // Q7a: versions dropped here keep their transcript files; nothing is deleted.
            if (item.versions.length > MAX_VERSIONS) item.versions.length = MAX_VERSIONS;
            item.next_seq = Math.max(item.next_seq ?? 1, p.version.seq) + 1;
            if (p.badge && !notKeptNoticeShown) notKeptNoticePending = true;
        }
        if (prepared.length) await adapter.saveMetadata();
        return prepared.map(({ itemId, version, badge, reason }) => ({ itemId, version, badge, reason }));
    }

    function getItem(itemId) {
        return ns()?.items?.[itemId] ?? null;
    }

    function activeVersion(itemId) {
        return getItem(itemId)?.versions?.[0] ?? null;
    }

    /**
     * Cache lookup (same rule for copied and native items, Q9a). Scans versions
     * newest first; a full match wins over a soft (mmproj) mismatch.
     * @returns {{status: 'hit'|'stale'|'miss', version: object|null}}
     */
    function lookup(itemId, parts) {
        let stale = null;
        for (const v of getItem(itemId)?.versions ?? []) {
            const s = compareKey(v.provenance, parts);
            if (s === 'hit') return { status: 'hit', version: v };
            if (s === 'stale' && !stale) stale = v;
        }
        return stale ? { status: 'stale', version: stale } : { status: 'miss', version: null };
    }

    /**
     * Read a version's transcript back and check it against the pointer.
     * @returns {Promise<{status: 'ok', speech: any[]} | {status: 'not_kept'|'not_on_device', badge: string, reason?: string}>}
     */
    async function loadTranscript(version) {
        return readPointer(version?.provenance?.transcript);
    }

    async function readPointer(ptr) {
        if (!ptr) return { status: 'not_kept', badge: BADGE_NOT_KEPT };
        const notHere = (reason) => ({ status: 'not_on_device', badge: BADGE_NOT_ON_DEVICE, reason });
        let bytes = null;
        try {
            if (typeof adapter.readFile === 'function') bytes = await adapter.readFile(ptr.path);
        } catch { bytes = null; }
        if (!bytes) return notHere('missing');
        if (bytes.length !== ptr.bytes) return notHere('bytes');
        if ((await hash(bytes)).hex !== ptr.sha256) return notHere('sha256');
        try {
            const doc = JSON.parse(new TextDecoder().decode(bytes));
            return { status: 'ok', speech: Array.isArray(doc.speech) ? doc.speech : [] };
        } catch {
            return notHere('parse');
        }
    }

    /**
     * On chat open (Q5c backup check). Copies all versions from the parent with one
     * read of its metadata, only when main_chat is set and the namespace is absent.
     * @returns {Promise<{copied: boolean, reason: string, items?: number}>}
     */
    async function onChatOpened() {
        const m = meta();
        if (!shouldCopyFromParent(m)) {
            return { copied: false, reason: m?.main_chat ? 'namespace present' : 'not a branch' };
        }
        if (typeof adapter.readChatMetadata !== 'function') return { copied: false, reason: 'parent read unavailable' };
        let parent = null;
        try { parent = await adapter.readChatMetadata(m.main_chat); } catch { parent = null; }
        const src = parent?.[NS];
        if (!src || typeof src !== 'object') return { copied: false, reason: parent ? 'parent has no dossiers' : 'parent unreadable' };
        if (m[NS] != null) return { copied: false, reason: 'namespace present' }; // set while we awaited
        m[NS] = { ...clone(src), copied_from: m.main_chat };
        await adapter.saveMetadata();
        return { copied: true, reason: 'copied from parent', items: Object.keys(m[NS].items || {}).length };
    }

    /** True once after a pass stored a dossier without a transcript (one-time notice, OQ-E3). */
    function takeNotKeptNotice() {
        if (!notKeptNoticePending) return false;
        notKeptNoticePending = false;
        notKeptNoticeShown = true;
        return true;
    }

    /** All items in the open chat: [{id, item}] (P6). */
    function listItems() {
        return Object.entries(ns()?.items ?? {}).map(([id, item]) => ({ id, item }));
    }

    /**
     * Mutate one item's protocol state (pending queue, selected model, …) and save
     * once (P6). Creates the item with no versions when absent.
     */
    async function updateItem(itemId, fn, { save = true } = {}) {
        const store = ns(true);
        const item = store.items[itemId] ?? (store.items[itemId] = { versions: [], next_seq: 1 });
        const r = fn(item);
        if (save) await adapter.saveMetadata();
        return r;
    }

    /**
     * Apply a merged requery to the active version in place (P6, T-F6). `dossier`
     * is the already-merged summary part; `speech` (delta speech entries) goes to
     * its own md-<hex>.json file whose pointer lands in the record (Q22). The
     * record is appended to provenance.requeries. One saveMetadata().
     * @returns {Promise<{version: object|null, badge: string|null, reason?: string}>}
     */
    async function applyDelta(itemId, { dossier, speech = [], record = {} }) {
        const v = activeVersion(itemId);
        if (!v) return { version: null, badge: null, reason: 'no active version' };
        const rq = Array.isArray(v.provenance.requeries) ? v.provenance.requeries : (v.provenance.requeries = []);
        let badge = null, reason;
        let transcript = null;
        if (speech.length) {
            const w = await writeTranscript(v.provenance.key, `${v.version_id}#rq${rq.length + 1}`, speech);
            transcript = w.pointer;
            if (!w.pointer) { badge = BADGE_NOT_KEPT; reason = w.reason; if (!notKeptNoticeShown) notKeptNoticePending = true; }
        }
        rq.push({ ...record, transcript });
        v.dossier = dossier;
        await adapter.saveMetadata();
        return { version: v, badge, reason };
    }

    /**
     * Speech for a version: the first-pass transcript plus every requery's speech
     * file (P6, T2). The status and badge are the first-pass transcript's; a missing
     * requery file only adds its reason.
     */
    async function loadSpeech(version) {
        const base = await loadTranscript(version);
        const speech = base.status === 'ok' ? [...base.speech] : [];
        const missing = [];
        for (const rq of version?.provenance?.requeries ?? []) {
            if (!rq?.transcript) continue;
            const r = await readPointer(rq.transcript);
            if (r.status === 'ok') speech.push(...r.speech);
            else missing.push(r.reason || r.status);
        }
        speech.sort((a, b) => (Number(a?.t0) || 0) - (Number(b?.t0) || 0));
        return base.status === 'ok' ? { status: 'ok', speech, missing } : { ...base, speech, missing };
    }

    return { completePass, lookup, getItem, activeVersion, loadTranscript, loadSpeech, onChatOpened, takeNotKeptNotice,
        listItems, updateItem, applyDelta };
}

/**
 * Storage self-test (settings action). Reports which hash path ran, round-trips
 * a test md-<hex>.json through upload + read, checks chatMetadata save/reload and
 * evaluates the branch on-open copy trigger. Never touches the dossier namespace.
 * @param {StoreAdapter} adapter
 * @returns {Promise<{ok: boolean, checks: Array<{name: string, ok: boolean|null, detail: string}>}>}
 */
export async function runStorageSelfTest(adapter) {
    const checks = [];
    const add = (name, ok, detail) => checks.push({ name, ok, detail });
    const opts = adapter.hashOptions || {};
    const nonce = (adapter.nonce || defaultNonce)();

    // 1. Hash path, and agreement with the other path when both exist.
    try {
        const probe = `video-support self-test ${nonce}`;
        const used = await sha256(probe, opts);
        const js = await sha256(probe, { forceJs: true });
        const agree = used.hex === js.hex;
        add('hash path', used.path === HASH_PATH_SUBTLE ? agree : true,
            used.path === HASH_PATH_SUBTLE
                ? `${HASH_PATH_SUBTLE} (${agree ? 'matches' : 'DIFFERS from'} ${HASH_PATH_JS})`
                : `${HASH_PATH_JS} (crypto.subtle unavailable)`);
    } catch (err) {
        add('hash path', false, String(err?.message || err));
    }

    // 2. Upload a test file and read it back.
    if (typeof adapter.uploadFile !== 'function') {
        add('transcript upload', false, `upload unavailable: dossiers would be stored with "${BADGE_NOT_KEPT}"`);
    } else {
        let path = null;
        try {
            const body = JSON.stringify({ schema: TRANSCRIPT_SCHEMA, selftest: true, nonce, speech: [{ t0: 0, kind: 'speech', text: 'ok' }] });
            const bytes = new TextEncoder().encode(body);
            const name = `md-${(await sha256(`selftest\n${nonce}`, opts)).hex}.json`;
            const want = (await sha256(bytes, opts)).hex;
            path = await adapter.uploadFile(name, bytesToBase64(bytes));
            if (typeof path !== 'string' || !path) throw new Error('no path returned');
            add('transcript upload', true, `uploaded ${path} (${bytes.length} bytes)`);
            const back = typeof adapter.readFile === 'function' ? await adapter.readFile(path) : null;
            if (!back) add('transcript read-back', false, 'file not readable after upload');
            else {
                const got = (await sha256(back, opts)).hex;
                const ok = back.length === bytes.length && got === want;
                add('transcript read-back', ok, ok ? 'sha256 and bytes match'
                    : `mismatch: bytes ${back.length}/${bytes.length}, sha256 ${got.slice(0, 12)}…/${want.slice(0, 12)}…`);
            }
        } catch (err) {
            add('transcript upload', false, `upload failed (${String(err?.message || err)}): dossiers would be stored with "${BADGE_NOT_KEPT}"`);
        }
        if (path && typeof adapter.deleteFile === 'function') {
            try { await adapter.deleteFile(path); } catch { /* best effort; the test file is tiny */ }
        }
    }

    // 3. chatMetadata save and reload.
    let m = null;
    try { m = adapter.getChatMetadata(); } catch { m = null; }
    if (!m || typeof m !== 'object') {
        add('chatMetadata save/reload', false, 'no chat open');
    } else {
        try {
            m[SELFTEST_META_KEY] = { nonce, at: (adapter.now || (() => new Date().toISOString()))() };
            await adapter.saveMetadata();
            const chatName = adapter.getCurrentChatName?.();
            if (!chatName || typeof adapter.readChatMetadata !== 'function') {
                add('chatMetadata save/reload', null, 'saved; reload not checked (chat name or reader unavailable)');
            } else {
                const reloaded = await adapter.readChatMetadata(chatName);
                const ok = reloaded?.[SELFTEST_META_KEY]?.nonce === nonce;
                add('chatMetadata save/reload', ok, ok ? 'marker read back from the saved chat' : 'marker missing after reload');
            }
        } catch (err) {
            add('chatMetadata save/reload', false, String(err?.message || err));
        } finally {
            delete m[SELFTEST_META_KEY];
            try { await adapter.saveMetadata(); } catch { /* reported above if saving is broken */ }
        }

        // 4. Branch on-open copy trigger (evaluated, not run).
        const fires = shouldCopyFromParent(m);
        const logicOk = shouldCopyFromParent({ main_chat: 'p' }) && !shouldCopyFromParent({ main_chat: 'p', [NS]: {} })
            && !shouldCopyFromParent({});
        add('branch copy trigger', logicOk,
            `this chat: main_chat ${m.main_chat ? 'set' : 'not set'}, dossiers ${m[NS] != null ? 'present' : 'absent'} -> copy ${fires ? 'would fire' : 'would not fire'}`);
    }

    return { ok: checks.every(c => c.ok !== false), checks };
}
