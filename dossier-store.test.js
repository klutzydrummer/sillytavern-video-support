import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import {
    NS, MAX_VERSIONS, BADGE_NOT_KEPT, BADGE_NOT_ON_DEVICE, SELFTEST_META_KEY,
    createStore, makeKey, compareKey, splitDossier, shouldCopyFromParent, runStorageSelfTest,
} from './dossier-store.js';

/**
 * Stub of everything ST-facing: an in-memory /user/files (the stubbed
 * /api/files/upload) and saved chat files keyed by chat name.
 */
function fakeST({ upload = true, chatName = 'chat-A', metadata = {}, subtle = webcrypto.subtle } = {}) {
    const files = new Map();
    const chats = new Map();
    const st = {
        files, chats, uploads: [], saves: 0, parentReads: 0,
        metadata,
        getChatMetadata: () => st.metadata,
        getCurrentChatName: () => chatName,
        saveMetadata: async () => { st.saves++; chats.set(chatName, JSON.parse(JSON.stringify(st.metadata))); },
        readFile: async (path) => (files.has(path) ? new Uint8Array(files.get(path)) : null),
        readChatMetadata: async (name) => { st.parentReads++; return chats.has(name) ? JSON.parse(JSON.stringify(chats.get(name))) : null; },
        deleteFile: async (path) => { files.delete(path); },
        hashOptions: { subtle },
        now: (() => { let t = 0; return () => new Date(Date.UTC(2026, 10, 27, 12, 0, t++)).toISOString(); })(),
        nonce: (() => { let n = 0; return () => `n${n++}`; })(),
    };
    if (upload) {
        st.uploadFile = async (name, base64) => {
            assert.match(name, /^md-[0-9a-f]{64}\.json$/);
            const path = `/user/files/${name}`;
            files.set(path, Buffer.from(base64, 'base64'));
            st.uploads.push(path);
            return path;
        };
    }
    return st;
}

const PARTS = { media_sha256: 'a'.repeat(64), model_id: 'qwen3-omni', quant: 'Q8_0', prompt_version: 'E/1', mmproj_sha256: 'm1' };
const DOSSIER = {
    schema_version: 'dossier/1',
    summary: 'A cat knocks a cup over.',
    answers: [{ id: 'q1', answer: 'yes', confidence: 0.9 }],
    timeline: [
        { t0: 0, kind: 'visual', text: 'cat on table' },
        { t0: 1.5, kind: 'speech', speaker: 'A', text: 'No, don\'t!' },
        { t0: 3, kind: 'sound', text: 'crash' },
        { t0: 4, kind: 'speech', speaker: 'B', text: 'Too late.' },
    ],
    uncertain: [],
};
const pass = (over = {}) => ({ parts: PARTS, dossier: DOSSIER, llama_build: 'b8000', wall_s: 12, ...over });

test('key: five parts, mmproj soft, llama build not part of it (F7, Q21)', () => {
    assert.equal(makeKey(PARTS), makeKey({ ...PARTS }));
    assert.notEqual(makeKey(PARTS), makeKey({ ...PARTS, mmproj_sha256: 'm2' }));
    assert.throws(() => makeKey({ ...PARTS, quant: '' }), /quant/);
    assert.equal(compareKey(PARTS, { ...PARTS }), 'hit');
    for (const p of ['media_sha256', 'model_id', 'quant', 'prompt_version']) assert.equal(compareKey(PARTS, { ...PARTS, [p]: 'x' }), 'miss', p);
    assert.equal(compareKey(PARTS, { ...PARTS, mmproj_sha256: 'm2' }), 'stale');
    assert.equal(compareKey({ ...PARTS, llama_build: 'b1' }, { ...PARTS, llama_build: 'b2' }), 'hit');
});

test('splitDossier keeps only speech entries for the transcript (OQ-E2)', () => {
    const { summary, speech } = splitDossier(DOSSIER);
    assert.deepEqual(speech.map(e => e.text), ['No, don\'t!', 'Too late.']);
    assert.deepEqual(summary.timeline.map(e => e.kind), ['visual', 'sound']);
    assert.equal(summary.summary, DOSSIER.summary);
    assert.equal(DOSSIER.timeline.length, 4, 'input not mutated');
});

test('T-F5: transcript goes to an md-<hex>.json file; metadata holds summary + pointer only', async () => {
    const st = fakeST();
    const store = createStore(st);
    const [r] = await store.completePass([pass()]);
    assert.equal(r.badge, null);
    const v = st.metadata[NS].items[PARTS.media_sha256].versions[0];
    const ptr = v.provenance.transcript;
    assert.match(ptr.path, /^\/user\/files\/md-[0-9a-f]{64}\.json$/);
    const file = st.files.get(ptr.path);
    assert.equal(ptr.bytes, file.length);
    assert.equal(ptr.sha256, createHash('sha256').update(file).digest('hex'));
    assert.ok(!JSON.stringify(st.metadata).includes('Too late.'), 'no speech text in chatMetadata');
    assert.equal(v.provenance.llama_build, 'b8000');
    assert.equal(v.provenance.key, makeKey(PARTS));
    const t = await store.loadTranscript(v);
    assert.equal(t.status, 'ok');
    assert.deepEqual(t.speech.map(e => e.speaker), ['A', 'B']);
});

test('T-F5: no upload -> dossier only, pointer null, "transcript not kept", notice once', async () => {
    for (const st of [fakeST({ upload: false }), Object.assign(fakeST(), { uploadFile: async () => { throw new Error('HTTP 404'); } })]) {
        const store = createStore(st);
        const [r] = await store.completePass([pass()]);
        assert.equal(r.badge, BADGE_NOT_KEPT);
        const v = store.activeVersion(PARTS.media_sha256);
        assert.equal(v.provenance.transcript, null);
        assert.deepEqual(v.dossier.timeline.map(e => e.kind), ['visual', 'sound']);
        assert.deepEqual(await store.loadTranscript(v), { status: 'not_kept', badge: BADGE_NOT_KEPT });
        assert.equal(store.takeNotKeptNotice(), true);
        assert.equal(store.takeNotKeptNotice(), false);
        await store.completePass([pass()]);
        assert.equal(store.takeNotKeptNotice(), false, 'notice only once');
    }
});

test('T-F5: pointer set but file missing or sha256/bytes mismatch -> "transcript not on this device"', async () => {
    const st = fakeST();
    const store = createStore(st);
    await store.completePass([pass()]);
    const v = store.activeVersion(PARTS.media_sha256);
    const path = v.provenance.transcript.path;
    const good = st.files.get(path);

    const flipped = Buffer.from(good); flipped[10] ^= 1;
    st.files.set(path, flipped);
    assert.deepEqual(await store.loadTranscript(v), { status: 'not_on_device', badge: BADGE_NOT_ON_DEVICE, reason: 'sha256' });

    st.files.set(path, Buffer.concat([good, Buffer.from(' ')]));
    assert.equal((await store.loadTranscript(v)).reason, 'bytes');

    st.files.delete(path);
    assert.deepEqual(await store.loadTranscript(v), { status: 'not_on_device', badge: BADGE_NOT_ON_DEVICE, reason: 'missing' });

    st.readFile = async () => { throw new Error('network'); };
    assert.equal((await store.loadTranscript(v)).reason, 'missing');
});

test('T-F5: 3 versions kept, newest active; dropped versions keep their files (F10, Q24b, Q7a)', async () => {
    const st = fakeST();
    const store = createStore(st);
    for (let i = 0; i < 5; i++) await store.completePass([pass({ wall_s: i })]);
    const item = store.getItem(PARTS.media_sha256);
    assert.equal(item.versions.length, MAX_VERSIONS);
    assert.deepEqual(item.versions.map(v => v.provenance.wall_s), [4, 3, 2]);
    assert.deepEqual(item.versions.map(v => v.seq), [5, 4, 3]);
    assert.equal(store.activeVersion(PARTS.media_sha256).provenance.wall_s, 4);
    assert.equal(new Set(st.uploads).size, 5, 'every version got its own file');
    assert.equal(st.files.size, 5, 'no file deleted');
    for (const v of item.versions) assert.equal((await store.loadTranscript(v)).status, 'ok');
});

test('T-F5: lookup hit / miss / stale; build change is neither (F14, Q21)', async () => {
    const st = fakeST();
    const store = createStore(st);
    assert.equal(store.lookup(PARTS.media_sha256, PARTS).status, 'miss');
    await store.completePass([pass()]);
    assert.equal(store.lookup(PARTS.media_sha256, PARTS).status, 'hit');
    assert.equal(store.lookup(PARTS.media_sha256, { ...PARTS, quant: 'Q4_K_M' }).status, 'miss');
    const stale = store.lookup(PARTS.media_sha256, { ...PARTS, mmproj_sha256: 'm2' });
    assert.equal(stale.status, 'stale');
    assert.ok(stale.version, 'stale keeps the dossier (never silently dropped)');
    await store.completePass([pass({ llama_build: 'b9999' })]);
    assert.equal(store.lookup(PARTS.media_sha256, PARTS).status, 'hit');
    // different model regenerated: newest is active, the old model's version still matches its own key
    await store.completePass([pass({ parts: { ...PARTS, model_id: 'lfm3' } })]);
    assert.equal(store.activeVersion(PARTS.media_sha256).provenance.model_id, 'lfm3');
    assert.equal(store.lookup(PARTS.media_sha256, PARTS).status, 'hit');
});

test('T-F5: one batched saveMetadata per completed pass', async () => {
    const st = fakeST();
    const store = createStore(st);
    const other = { ...PARTS, media_sha256: 'b'.repeat(64) };
    await store.completePass([pass(), pass({ parts: other }), pass({ parts: other })]);
    assert.equal(st.saves, 1);
    assert.equal(st.uploads.length, 3);
    assert.deepEqual(store.getItem(other.media_sha256).versions.map(v => v.seq), [2, 1]);
    await store.completePass([]);
    assert.equal(st.saves, 1, 'empty pass does not save');
});

test('T-F5: on-open copy trigger only when main_chat is set and the namespace is absent (OQ-E5)', () => {
    assert.equal(shouldCopyFromParent({ main_chat: 'parent' }), true);
    assert.equal(shouldCopyFromParent({ main_chat: 'parent', [NS]: { items: {} } }), false);
    assert.equal(shouldCopyFromParent({ main_chat: '' }), false);
    assert.equal(shouldCopyFromParent({}), false);
    assert.equal(shouldCopyFromParent(null), false);
});

async function parentWithDossiers(st) {
    // Build the parent chat's saved metadata with the same stubs.
    const parentSt = fakeST({ chatName: 'parent' });
    const ps = createStore(parentSt);
    for (let i = 0; i < 3; i++) await ps.completePass([pass({ wall_s: i, message_id: 40 + i })]);
    st.chats.set('parent', parentSt.chats.get('parent'));
    for (const [k, v] of parentSt.files) st.files.set(k, v); // same user files dir
    return parentSt;
}

test('T-F5: branch on-open copies all versions from the parent with one read; pointers shared; no pruning', async () => {
    const st = fakeST({ chatName: 'branch', metadata: { main_chat: 'parent' } });
    const parentSt = await parentWithDossiers(st);
    const store = createStore(st);
    const r = await store.onChatOpened();
    assert.deepEqual(r, { copied: true, reason: 'copied from parent', items: 1 });
    assert.equal(st.parentReads, 1);
    assert.equal(st.saves, 1);
    const parentItem = parentSt.metadata[NS].items[PARTS.media_sha256];
    const item = store.getItem(PARTS.media_sha256);
    assert.equal(item.versions.length, 3, 'all versions (Q6a)');
    assert.deepEqual(item.versions.map(v => v.provenance.transcript), parentItem.versions.map(v => v.provenance.transcript), 'shared pointers (Q7a)');
    assert.equal(item.message_id, 42, 'dossiers past the branch point kept');
    assert.equal(st.metadata[NS].copied_from, 'parent');
    assert.equal((await store.loadTranscript(item.versions[0])).status, 'ok');
    // copy is independent of the parent object
    item.versions.pop();
    assert.equal(parentItem.versions.length, 3);
    // second open: namespace present, no further read
    assert.equal((await store.onChatOpened()).copied, false);
    assert.equal(st.parentReads, 1);
});

test('T-F5: soft-key check runs on copied items (Q9a)', async () => {
    const st = fakeST({ chatName: 'branch', metadata: { main_chat: 'parent' } });
    await parentWithDossiers(st);
    const store = createStore(st);
    await store.onChatOpened();
    assert.equal(store.lookup(PARTS.media_sha256, PARTS).status, 'hit');
    assert.equal(store.lookup(PARTS.media_sha256, { ...PARTS, mmproj_sha256: 'other' }).status, 'stale');
});

test('T-F5: no copy when ST already copied, when not a branch, or when the parent has none', async () => {
    const already = fakeST({ chatName: 'b', metadata: { main_chat: 'parent', [NS]: { schema: 'mdstore/1', items: {} } } });
    assert.deepEqual(await createStore(already).onChatOpened(), { copied: false, reason: 'namespace present' });
    assert.equal(already.parentReads, 0);

    const plain = fakeST({ metadata: {} });
    assert.deepEqual(await createStore(plain).onChatOpened(), { copied: false, reason: 'not a branch' });
    assert.equal(plain.parentReads, 0);

    const empty = fakeST({ chatName: 'b', metadata: { main_chat: 'parent' } });
    empty.chats.set('parent', { note: 'no dossiers' });
    assert.equal((await createStore(empty).onChatOpened()).reason, 'parent has no dossiers');
    assert.equal(empty.saves, 0);
    assert.equal(empty.metadata[NS], undefined, 'nothing written');

    const gone = fakeST({ chatName: 'b', metadata: { main_chat: 'parent' } });
    assert.equal((await createStore(gone).onChatOpened()).reason, 'parent unreadable');
    assert.equal(gone.parentReads, 1);
});

test('T-F5: the same media in another chat is processed again (F9=c, Q8a)', async () => {
    const a = fakeST({ chatName: 'A' });
    await createStore(a).completePass([pass()]);
    const b = fakeST({ chatName: 'B', metadata: {} });
    assert.equal(createStore(b).lookup(PARTS.media_sha256, PARTS).status, 'miss');
});

test('T-F10: storage self-test passes with stubs and reports the hash path', async () => {
    const st = fakeST({ metadata: { main_chat: 'parent' } });
    const r = await runStorageSelfTest(st);
    assert.equal(r.ok, true, JSON.stringify(r.checks));
    const by = Object.fromEntries(r.checks.map(c => [c.name, c]));
    assert.match(by['hash path'].detail, /^crypto\.subtle \(matches pure-js\)/);
    assert.match(by['transcript upload'].detail, /\/user\/files\/md-[0-9a-f]{64}\.json/);
    assert.equal(by['transcript read-back'].detail, 'sha256 and bytes match');
    assert.equal(by['chatMetadata save/reload'].ok, true);
    assert.match(by['branch copy trigger'].detail, /main_chat set, dossiers absent -> copy would fire/);
    assert.equal(st.files.size, 0, 'test file cleaned up');
    assert.equal(st.metadata[SELFTEST_META_KEY], undefined, 'marker removed');
    assert.equal(st.chats.get('chat-A')[SELFTEST_META_KEY], undefined, 'marker removed from the saved chat');
    assert.equal(st.metadata[NS], undefined, 'dossier namespace untouched');
});

test('T-F10: self-test reports the pure-JS path and failures', async () => {
    const st = fakeST({ upload: false, subtle: null });
    const r = await runStorageSelfTest(st);
    const by = Object.fromEntries(r.checks.map(c => [c.name, c]));
    assert.equal(by['hash path'].ok, true);
    assert.match(by['hash path'].detail, /^pure-js/);
    assert.equal(by['transcript upload'].ok, false);
    assert.match(by['transcript upload'].detail, /transcript not kept/);
    assert.equal(r.ok, false);

    const corrupt = fakeST();
    corrupt.readFile = async (p) => { const b = new Uint8Array(corrupt.files.get(p)); b[0] ^= 1; return b; };
    const rc = await runStorageSelfTest(corrupt);
    assert.equal(rc.checks.find(c => c.name === 'transcript read-back').ok, false);

    const noReload = fakeST();
    noReload.saveMetadata = async () => {}; // saves silently dropped
    const rn = await runStorageSelfTest(noReload);
    assert.equal(rn.checks.find(c => c.name === 'chatMetadata save/reload').ok, false);

    const noChat = fakeST();
    noChat.getChatMetadata = () => null;
    const rx = await runStorageSelfTest(noChat);
    assert.deepEqual(rx.checks.map(c => c.name), ['hash path', 'transcript upload', 'transcript read-back', 'chatMetadata save/reload']);
    assert.equal(rx.checks.at(-1).ok, false);
});
