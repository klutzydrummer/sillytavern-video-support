import test from 'node:test';
import assert from 'node:assert/strict';
import { buildT0, buildT1, buildT2, pickActiveItem, parseTimestamps, tokens, createTranscriptCache, buildTiers } from './tiers.js';
import { defaultSettings } from './settings.js';
import { sampleDossier } from './testing-stubs.js';

const S = defaultSettings();
const hex = (i) => i.toString(16).padStart(8, '0').padEnd(64, 'a');
const long = (d) => ({ ...d, anticipatory: d.anticipatory.map(f => `${f}, seen clearly in the middle of the frame for several seconds while the camera pans across a cluttered kitchen counter`) });
function items(n) {
    return Array.from({ length: n }, (_, i) => ({
        id: hex(i + 1), title: `clip-${i + 1}.mp4`, order: i + 1,
        version: { version_id: `v${i}`, provenance: { model_id: 'Qwen3-Omni-30B-A3B-Instruct', quant: 'Q8_0' }, dossier: long(sampleDossier(`c${i + 1}`)) },
    }));
}

for (const n of [1, 10, 50]) {
    test(`T-F4: T0 within budget with ${n} item(s)`, () => {
        const r = buildT0(items(n), S);
        assert.ok(r.tokens <= S.t0Total, `${r.tokens} > ${S.t0Total}`);
        assert.equal(r.full.length + r.stubbed.length + r.dropped.length, n);
        for (const block of r.text.split('\n[media ').slice(1)) assert.ok(tokens(`[media ${block}`) <= S.t0PerItem);
        if (n === 1) assert.deepEqual(r.full, [hex(1)]);
    });
}

test('T-F4: over budget, the oldest items become stubs first, then are dropped', () => {
    for (const n of [10, 50, 80]) {
        const list = items(n);
        const r = buildT0(list, S);
        assert.ok(r.stubbed.length > 0, `${n}: some stubs`);
        if (n < 80) assert.ok(r.full.length > 0, `${n}: the newest stay full`);
        const order = (id) => list.find(x => x.id === id).order;
        const maxOf = (ids) => Math.max(-Infinity, ...ids.map(order));
        const minOf = (ids) => Math.min(Infinity, ...ids.map(order));
        assert.ok(maxOf(r.stubbed) < minOf(r.full), `${n}: every stub is older than every full entry`);
        assert.ok(maxOf(r.dropped) < minOf(r.stubbed), `${n}: every dropped item is older than every stub`);
        if (r.dropped.length) assert.match(r.text, new RegExp(`\\(${r.dropped.length} older media items omitted\\)`));
        assert.ok(r.tokens <= S.t0Total);
    }
    assert.ok(buildT0(items(80), S).dropped.length > 0, '80 items need drops at the default budget');
    assert.match(buildT0(items(1), S).text, /processed by Qwen3-Omni-30B-A3B-Instruct Q8_0/);
    // T0 content: 2 sentences, top 3 facts, uncertainty count.
    const one = buildT0(items(1), S).text;
    assert.match(one, /shows a cat on a table\. It knocks a cup over\./);
    assert.doesNotMatch(one, /Someone laughs/);
    assert.match(one, /- the owner is upset/);
    assert.doesNotMatch(one, /fourth fact/);
    assert.match(one, /\(1 uncertain point\)/);
});

test('T-F4: T1 and T2 stay within budget', () => {
    const list = items(3);
    const big = { ...list[0], version: { ...list[0].version, dossier: sampleDossier('big', 400) } };
    const t1 = buildT1(big, 'what does the owner say about the cup', S);
    assert.ok(t1.tokens <= S.t1Tokens && t1.tokens > 0);
    assert.match(t1.text.split('\n')[1], /^A q1:/);
    const speech = new Map([[big.id, Array.from({ length: 500 }, (_, i) => ({ t0: i, kind: 'speech', speaker: 'Owner', text: `line ${i} cup` }))]]);
    const t2 = buildT2([big], 'at 0:12 the cup falls', S, speech);
    assert.ok(t2.tokens <= S.t2Tokens && t2.hits > 0);
    assert.match(t2.text, /\[0:12\]/);
    assert.equal(buildT2([big], 'ok', S).text, '');
});

test('tiers: active item and timestamps', () => {
    const list = items(3);
    assert.equal(pickActiveItem(list, 'hello').id, hex(3));
    assert.equal(pickActiveItem(list, 'in clip-1.mp4 who is there').id, hex(1));
    assert.equal(pickActiveItem(list, `about ${hex(2).slice(0, 8)}`).id, hex(2));
    assert.deepEqual(parseTimestamps('at 1:05 and 01:02:03 and 45 seconds'), [65, 3723, 45]);
});

test('tiers: T2 transcript read once per session per version', async () => {
    let reads = 0;
    const store = { loadSpeech: async () => { reads++; return { status: 'ok', speech: [{ t0: 3, kind: 'speech', text: 'the password is swordfish' }] }; } };
    const cache = createTranscriptCache(store);
    const list = items(2);
    const a = await buildTiers(list, 'what was the password', S, cache);
    await buildTiers(list, 'password again', S, cache);
    assert.equal(reads, 2, 'one read per version, not per turn');
    assert.match(a.t2.text, /swordfish/);
    cache.clear(list[0].version.version_id);
    await buildTiers(list, 'password', S, cache);
    assert.equal(reads, 3);
    const nk = createTranscriptCache({ loadSpeech: async () => ({ status: 'not_kept', badge: 'transcript not kept', speech: [] }) });
    const b = await buildTiers(list, 'password', S, nk);
    assert.equal(b.badges.get(list[0].id), 'transcript not kept');
});
