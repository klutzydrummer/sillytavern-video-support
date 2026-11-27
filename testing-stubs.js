/**
 * Shared stubs for the P6 unit tests (not loaded by SillyTavern; the name keeps
 * it out of node --test's file patterns). Mirrors the P5 fakeST in dossier-store.test.js.
 */
import { webcrypto } from 'node:crypto';

export function fakeST({ upload = true, chatName = 'chat-A', metadata = {} } = {}) {
    const files = new Map();
    const st = {
        files, uploads: [], saves: 0, metadata,
        getChatMetadata: () => st.metadata,
        getCurrentChatName: () => chatName,
        saveMetadata: async () => { st.saves++; },
        readFile: async (path) => (files.has(path) ? new Uint8Array(files.get(path)) : null),
        hashOptions: { subtle: webcrypto.subtle },
        now: (() => { let t = 0; return () => new Date(Date.UTC(2026, 10, 27, 12, 0, t++)).toISOString(); })(),
        nonce: (() => { let n = 0; return () => `n${n++}`; })(),
    };
    if (upload) {
        st.uploadFile = async (name, base64) => {
            if (!/^md-[0-9a-f]{64}\.json$/.test(name)) throw new Error(`bad name ${name}`);
            const path = `/user/files/${name}`;
            files.set(path, Buffer.from(base64, 'base64'));
            st.uploads.push(path);
            return path;
        };
    }
    return st;
}

/** A dossier of n timeline entries with speech every third. */
export function sampleDossier(tag = 'x', n = 6) {
    return {
        schema_version: 'dossier/1',
        summary: `Clip ${tag} shows a cat on a table. It knocks a cup over. Someone laughs.`,
        anticipatory: [`cat ${tag} is orange`, 'the cup breaks', 'the owner is upset', 'fourth fact'],
        answers: [{ id: 'q1', answer: `the cat ${tag} jumps`, confidence: 0.9 }],
        timeline: Array.from({ length: n }, (_, i) => ({ t0: i * 2, kind: i % 3 === 1 ? 'speech' : 'visual', speaker: i % 3 === 1 ? 'Owner' : undefined, text: `${tag} moment ${i} ${i % 3 === 1 ? 'no stop' : 'cup wobbles'}` })),
        uncertain: ['breed'],
    };
}

/**
 * Stub RTR fetch. `handler(body)` returns {status, json}; default answers like
 * rtr.py in coexist mode. Records every request body.
 */
export function fakeRtrFetch(handler) {
    const calls = [];
    const fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        calls.push({ url, body });
        const r = await handler(body, calls.length);
        if (r instanceof Error) throw r;
        return { status: r.status ?? 200, json: async () => r.json };
    };
    return { fetch, calls };
}

export function rtrOk(res) {
    return { status: 200, json: { object: 'chat.completion', choices: [{ message: { content: JSON.stringify(res) } }], rtr: res } };
}

export function planRes(mode = 'coexist', extra = {}) {
    return rtrOk({ status: 'plan', plan: { mode, would_evict: mode === 'swap' ? ['rp'] : [], reason: mode === 'coexist' ? 'coexist set and live VRAM fit' : 'no coexist set for this RP and media model', rp_model: 'rp', ...extra } });
}
