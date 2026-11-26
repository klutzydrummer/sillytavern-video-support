import test from 'node:test';
import assert from 'node:assert/strict';
import { isMainGenerateUrl, isInjectableGenType, getOwnedVideoUrl, estimateTokens, formatTokenEstimate, ffmpegAssetUrls, encodeWav16, bytesToBase64, makeAudioPart, appendPartsToLastUser } from './video-utils.js';

test('isMainGenerateUrl matches only chat-completions generate', () => {
    assert.ok(isMainGenerateUrl('/api/backends/chat-completions/generate'));
    assert.ok(isMainGenerateUrl('http://localhost:8000/api/backends/chat-completions/generate?x=1'));
    assert.ok(!isMainGenerateUrl('/api/backends/chat-completions/status'));
    assert.ok(!isMainGenerateUrl('/api/backends/kobold/generate'));
    assert.ok(!isMainGenerateUrl('/api/textgenerationwebui/generate'));
    assert.ok(!isMainGenerateUrl(undefined));
});

test('generation types', () => {
    for (const t of [undefined, '', 'normal', 'regenerate', 'swipe', 'continue']) assert.ok(isInjectableGenType(t), String(t));
    for (const t of ['quiet', 'impersonate', 'first_message']) assert.ok(!isInjectableGenType(t), t);
    assert.ok(!isInjectableGenType('normal', true));
});

test('getOwnedVideoUrl: stale video is not reused by later turns', () => {
    const v = { extra: { media: [{ type: 'video', url: 'u1' }] } };
    const chat = [{ is_user: true, ...v }, { is_user: false }];
    assert.equal(getOwnedVideoUrl(chat), 'u1'); // regenerate/swipe of owner
    chat.push({ is_user: true, extra: {} }, { is_user: false });
    assert.equal(getOwnedVideoUrl(chat), null); // later turn
    assert.equal(getOwnedVideoUrl(null), null);
});

test('token estimate', () => {
    assert.equal(estimateTokens(24, 1024), 24576);
    assert.match(formatTokenEstimate(24, 1024), /24\.6k/);
});

test('ffmpeg urls', () => {
    assert.match(ffmpegAssetUrls().ffmpegModule, /\+esm$/);
    assert.equal(ffmpegAssetUrls('https://x/y/').coreBase, 'https://x/y/@ffmpeg/core@0.12.9/dist/esm');
});

test('encodeWav16 writes a mono 16 kHz PCM header and clamps samples', () => {
    const wav = encodeWav16(new Float32Array([0, 1, -1, 2]));
    const v = new DataView(wav.buffer);
    const tag = (o) => String.fromCharCode(...wav.subarray(o, o + 4));
    assert.equal(tag(0), 'RIFF'); assert.equal(tag(8), 'WAVE'); assert.equal(tag(36), 'data');
    assert.equal(wav.length, 44 + 8);
    assert.equal(v.getUint32(4, true), 36 + 8);
    assert.equal(v.getUint16(22, true), 1); // mono
    assert.equal(v.getUint32(24, true), 16000);
    assert.equal(v.getInt16(46, true), 0x7fff);
    assert.equal(v.getInt16(48, true), -0x8000);
    assert.equal(v.getInt16(50, true), 0x7fff); // clamped
});

test('bytesToBase64 handles buffers larger than one chunk', () => {
    const bytes = new Uint8Array(100000).map((_, i) => i % 251);
    assert.deepEqual(new Uint8Array(Buffer.from(bytesToBase64(bytes), 'base64')), bytes);
});

test('audio part and message shape: frames then input_audio on the last user message', () => {
    const body = { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'hi' }] };
    const msg = appendPartsToLastUser(body, [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AA' } }, makeAudioPart('QUJD')]);
    assert.equal(msg, body.messages[2]);
    assert.equal(body.messages[0].content, 'a');
    assert.deepEqual(msg.content.map(p => p.type), ['text', 'image_url', 'input_audio']);
    assert.deepEqual(msg.content[2].input_audio, { data: 'QUJD', format: 'wav' });
    assert.equal(appendPartsToLastUser({ messages: [{ role: 'assistant', content: 'x' }] }, []), null);
    assert.equal(appendPartsToLastUser({}, []), null);
});
