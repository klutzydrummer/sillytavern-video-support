import test from 'node:test';
import assert from 'node:assert/strict';
import { isMainGenerateUrl, isInjectableGenType, getOwnedVideoUrl, estimateTokens, formatTokenEstimate, ffmpegAssetUrls } from './video-utils.js';

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
