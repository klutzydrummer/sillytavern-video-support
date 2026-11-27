import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { sha256, sha256HexJs, toBytes, HASH_PATH_JS, HASH_PATH_SUBTLE } from './hash.js';

// FIPS 180-2 / NIST CSRC example vectors; also cross-checked against node:crypto below.
const VECTORS = [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
    ['a'.repeat(1000000), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
];

test('T-F10: pure-JS SHA-256 matches the NIST vectors and node:crypto', () => {
    for (const [msg, hex] of VECTORS) {
        assert.equal(sha256HexJs(msg), hex);
        assert.equal(createHash('sha256').update(msg).digest('hex'), hex);
    }
});

test('T-F10: pure-JS equals crypto.subtle on block-boundary and random inputs', async () => {
    for (const n of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 65537]) {
        const b = randomBytes(n);
        const sub = await sha256(b, { subtle: webcrypto.subtle });
        const js = await sha256(b, { forceJs: true });
        assert.equal(sub.path, HASH_PATH_SUBTLE);
        assert.equal(js.path, HASH_PATH_JS);
        assert.equal(js.hex, sub.hex, `length ${n}`);
    }
});

test('T-F10: falls back to pure JS when crypto.subtle is missing or throws', async () => {
    const missing = await sha256('abc', { subtle: null });
    assert.deepEqual(missing, { hex: VECTORS[1][1], path: HASH_PATH_JS });
    const throwing = await sha256('abc', { subtle: { digest: async () => { throw new Error('insecure context'); } } });
    assert.deepEqual(throwing, { hex: VECTORS[1][1], path: HASH_PATH_JS });
});

test('toBytes: UTF-8 strings, buffers and typed-array views', () => {
    assert.deepEqual([...toBytes('é')], [0xc3, 0xa9]);
    const buf = new Uint8Array([1, 2, 3, 4]);
    assert.deepEqual([...toBytes(buf.buffer)], [1, 2, 3, 4]);
    assert.deepEqual([...toBytes(new DataView(buf.buffer, 1, 2))], [2, 3]);
    assert.throws(() => toBytes(42), TypeError);
    assert.equal(sha256HexJs('é'), createHash('sha256').update('é').digest('hex'));
});
