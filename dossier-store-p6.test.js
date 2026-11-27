import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, BADGE_NOT_KEPT } from './dossier-store.js';
import { fakeST, sampleDossier } from './testing-stubs.js';

const ID = 'd'.repeat(64);
const parts = { media_sha256: ID, model_id: 'M', quant: 'Q8_0', prompt_version: 'p6-1', mmproj_sha256: 'mm' };

test('store P6: updateItem creates the item and saves once; listItems lists it', async () => {
    const st = fakeST();
    const store = createStore(st);
    const r = await store.updateItem(ID, (it) => { it.pending = [{ id: 'f1-1' }]; return 7; });
    assert.equal(r, 7);
    assert.equal(st.saves, 1);
    await store.updateItem(ID, (it) => { it.title = 't'; }, { save: false });
    assert.equal(st.saves, 1);
    const all = store.listItems();
    assert.deepEqual(all.map(x => x.id), [ID]);
    assert.equal(all[0].item.title, 't');
    assert.deepEqual(all[0].item.versions, []);
});

test('store P6: applyDelta stores delta speech as its own file; loadSpeech merges in time order', async () => {
    const st = fakeST();
    const store = createStore(st);
    assert.equal((await store.applyDelta(ID, { dossier: {} })).reason, 'no active version');
    await store.completePass([{ parts, dossier: sampleDossier('x') }]);
    const uploads = st.uploads.length;
    const v0 = store.activeVersion(ID);
    const r = await store.applyDelta(ID, { dossier: { ...v0.dossier, summary: 'merged' }, speech: [{ t0: 0.5, kind: 'speech', text: 'early' }], record: { trigger: 'auto' } });
    assert.equal(r.badge, null);
    assert.equal(st.uploads.length, uploads + 1);
    assert.equal(st.saves >= 2, true);
    const v = store.activeVersion(ID);
    assert.equal(v.dossier.summary, 'merged');
    assert.equal(v.provenance.requeries[0].trigger, 'auto');
    const sp = await store.loadSpeech(v);
    assert.equal(sp.status, 'ok');
    assert.equal(sp.speech[0].text, 'early');
    assert.deepEqual(sp.missing, []);
    // A requery file gone from this device: the base still loads, the reason is listed.
    st.files.delete(v.provenance.requeries[0].transcript.path);
    const sp2 = await store.loadSpeech(v);
    assert.equal(sp2.status, 'ok');
    assert.equal(sp2.missing.length, 1);
    assert.ok(!sp2.speech.some(e => e.text === 'early'));
});

test('store P6: applyDelta without upload support keeps the dossier and badges "not kept"', async () => {
    const st = fakeST({ upload: false });
    const store = createStore(st);
    await store.completePass([{ parts, dossier: sampleDossier('x') }]);
    const r = await store.applyDelta(ID, { dossier: { summary: 's' }, speech: [{ t0: 1, kind: 'speech', text: 'hi' }] });
    assert.equal(r.badge, BADGE_NOT_KEPT);
    assert.equal(store.activeVersion(ID).provenance.requeries[0].transcript, null);
});
