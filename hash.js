/**
 * SHA-256 for the Video Support extension (Q14a: the extension hashes).
 *
 * Uses crypto.subtle when it exists and works. It is missing outside secure
 * contexts (plain-HTTP origins), so a pure-JS fallback is included. Both paths
 * return the same lowercase hex digest; `path` says which one ran.
 * No SillyTavern imports, so this runs under plain `node --test`.
 */

export const HASH_PATH_SUBTLE = 'crypto.subtle';
export const HASH_PATH_JS = 'pure-js';

const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const H0 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

/** Strings become UTF-8 bytes; ArrayBuffer / typed arrays become a Uint8Array view. */
export function toBytes(data) {
    if (typeof data === 'string') return new TextEncoder().encode(data);
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    throw new TypeError('sha256: expected a string, ArrayBuffer or typed array');
}

export function bytesToHex(bytes) {
    let s = '';
    for (const b of bytes) s += b.toString(16).padStart(2, '0');
    return s;
}

function compress(h, w, block, off) {
    for (let i = 0; i < 16; i++) {
        const j = off + i * 4;
        w[i] = (block[j] << 24) | (block[j + 1] << 16) | (block[j + 2] << 8) | block[j + 3];
    }
    for (let i = 16; i < 64; i++) {
        const a = w[i - 15], b = w[i - 2];
        const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
        const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const ch = (e & f) ^ (~e & g);
        const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0;
        d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
}

/** Pure-JS SHA-256 (FIPS 180-4). Processes whole blocks in place; only the tail is copied. */
export function sha256HexJs(data) {
    const bytes = toBytes(data);
    const h = H0.slice();
    const w = new Int32Array(64);
    const full = bytes.length - (bytes.length % 64);
    for (let off = 0; off < full; off += 64) compress(h, w, bytes, off);
    const rest = bytes.length - full;
    const tail = new Uint8Array(rest < 56 ? 64 : 128);
    tail.set(bytes.subarray(full));
    tail[rest] = 0x80;
    const bitLen = bytes.length * 8;
    const dv = new DataView(tail.buffer);
    dv.setUint32(tail.length - 8, Math.floor(bitLen / 0x100000000));
    dv.setUint32(tail.length - 4, bitLen >>> 0);
    for (let off = 0; off < tail.length; off += 64) compress(h, w, tail, off);
    const out = new Uint8Array(32);
    const odv = new DataView(out.buffer);
    h.forEach((v, i) => odv.setUint32(i * 4, v >>> 0));
    return bytesToHex(out);
}

/**
 * SHA-256 hex digest. Tries crypto.subtle first, falls back to pure JS if it is
 * absent or throws.
 * @param {string|ArrayBuffer|ArrayBufferView} data
 * @param {{subtle?: SubtleCrypto|null, forceJs?: boolean}} [opts] subtle defaults to globalThis.crypto.subtle
 * @returns {Promise<{hex: string, path: string}>}
 */
export async function sha256(data, { subtle = globalThis.crypto?.subtle, forceJs = false } = {}) {
    const bytes = toBytes(data);
    if (!forceJs && subtle && typeof subtle.digest === 'function') {
        try {
            const buf = await subtle.digest('SHA-256', bytes);
            return { hex: bytesToHex(new Uint8Array(buf)), path: HASH_PATH_SUBTLE };
        } catch { /* fall through to pure JS */ }
    }
    return { hex: sha256HexJs(bytes), path: HASH_PATH_JS };
}
