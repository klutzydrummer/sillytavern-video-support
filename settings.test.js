import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings, resolveSettings, settingSources, setGlobal, setChat, compactLayers, settingsRows, normalizeValue } from './settings.js';

test('settings: §1.6 defaults (Q27a caps, OQ-E7 empty cap)', () => {
    const d = defaultSettings();
    assert.equal(d.questionMaxTokens, 400);
    assert.equal(d.capsuleTokens, 600);
    assert.equal(d.mmMaxTokensQwen, 2500);
    assert.equal(d.mmMaxTokensLfm3, 1200);
    assert.equal(d.deltaMaxTokens, 800);
    assert.deepEqual([d.t0PerItem, d.t0Total, d.t1Tokens, d.t2Tokens], [150, 1200, 900, 1500]);
    assert.deepEqual([d.triggerBlocking, d.triggerNonBlocking], [1, 3]);
    assert.equal(d.autoRequeryCapS, '', 'auto requery cap ships empty = no cap, not 15 s');
});

test('settings: per-chat > global > default (OQ-E1)', () => {
    const g = { t1Tokens: 700, deltaMaxTokens: 1000 };
    const c = { t1Tokens: 500 };
    const r = resolveSettings(g, c);
    assert.equal(r.t1Tokens, 500);
    assert.equal(r.deltaMaxTokens, 1000);
    assert.equal(r.t2Tokens, 1500);
    assert.deepEqual([settingSources(g, c).t1Tokens, settingSources(g, c).deltaMaxTokens, settingSources(g, c).t2Tokens], ['chat', 'global', 'default']);
});

test('settings: only changed keys are stored (Q28b)', () => {
    const g = {};
    setGlobal(g, 't1Tokens', 900); // equals default
    assert.deepEqual(g, {});
    setGlobal(g, 't1Tokens', '700');
    assert.deepEqual(g, { t1Tokens: 700 });
    const c = {};
    setChat(c, 't1Tokens', 700, g); // equals global
    assert.deepEqual(c, {});
    setChat(c, 't1Tokens', 600, g);
    assert.deepEqual(c, { t1Tokens: 600 });
    setChat(c, 't1Tokens', '', g); // clearing a non-empty key removes the override
    assert.deepEqual(c, {});
    // A stored override follows later global changes only when not stored.
    setGlobal(g, 't1Tokens', 800);
    assert.equal(resolveSettings(g, c).t1Tokens, 800);
});

test('settings: empty cap is a real value; clamping and junk', () => {
    const g = { autoRequeryCapS: 30 };
    const c = {};
    setChat(c, 'autoRequeryCapS', '', g);
    assert.deepEqual(c, { autoRequeryCapS: '' }, 'chat can clear a global cap back to no cap');
    assert.equal(resolveSettings(g, c).autoRequeryCapS, '');
    assert.equal(normalizeValue('maxQuestions', 20), 8);
    assert.equal(normalizeValue('t0Total', 'abc'), undefined);
    assert.deepEqual(resolveSettings({ bogus: 1, t0Total: 'x' }, null).t0Total, 1200);
    const { global, perChat } = compactLayers({ t1Tokens: 900, t2Tokens: 100, zz: 1 }, { t2Tokens: 100, t0Total: 999 });
    assert.deepEqual(global, { t2Tokens: 100 });
    assert.deepEqual(perChat, { t0Total: 999 });
    const rows = settingsRows({ t2Tokens: 100 }, { t0Total: 999 });
    assert.equal(rows.find(r => r.key === 't0Total').source, 'chat');
    assert.equal(rows.find(r => r.key === 't2Tokens').global, 100);
});
