'use strict';
/** safe-regex: nested quantifiers and oversized patterns refused at compile time; a slow pattern cut
 * off by the deadline (no match, a timeout, never a hang); a normal pattern still matches. */
const assert = require('assert');
const { suite } = require('./helpers');
const safe = require('../server/safe-regex');

const t = suite('safe-regex');

t('a quantified group holding a quantifier is refused; a normal pattern compiles', () => {
    for (const bad of ['(a+)+$', '(a*)*', '(\\w+\\s?)*', '((a+)x)+', '(a?)+']) {
        assert.ok(safe.validate(bad), `${bad} is refused`);
        assert.throws(() => safe.compile(bad), (err) => err.code === 'unsafe_pattern' && err.reason === 'nested');
    }
    for (const ok of ['(\\d+\\.\\d+) EUR', '\\d{4}-\\d{2}-\\d{2}', '(cat|dog)', '^v\\d+\\.\\d+', 'a{2,4}', '[a+]+']) {
        assert.strictEqual(safe.validate(ok), null, `${ok} is accepted`);
    }
});

t('an oversized, empty or invalid pattern is refused', () => {
    assert.match(safe.validate('x'.repeat(501)), /1–500/);
    assert.match(safe.validate(''), /1–500/);
    assert.match(safe.validate('('), /not a valid/);
});

t('a slow pattern that slips past the static check is cut off by the deadline', () => {
    // alternation, no nested quantifier: the static scan accepts it, the deadline stops it
    const re = safe.compile('^(\\w|\\w\\w)*$');
    const start = Date.now();
    const out = safe.test(re, 'a'.repeat(40) + '!');
    const elapsed = Date.now() - start;
    assert.deepStrictEqual(out, { matched: false, timedOut: true }, 'the deadline was hit, so no match');
    assert.ok(elapsed < 200, `returned in ~${elapsed}ms rather than hanging`);
});

t('a normal pattern still matches, under the deadline (test and exec)', () => {
    assert.strictEqual(safe.test(safe.compile('^v\\d+\\.\\d+'), 'v2.3 released').matched, true);
    assert.strictEqual(safe.test(safe.compile('^v\\d+\\.\\d+'), 'vX').matched, false);
    const { match, timedOut } = safe.exec(safe.compile('/(\\d+\\.\\d+) EUR/'), 'now 12.50 EUR');
    assert.strictEqual(timedOut, false);
    assert.strictEqual(match[1], '12.50');
});

t.run();
