'use strict';
/** Conditions: every op, tolerance/percent, and the for_sec debounce over the observation trail. */
const assert = require('assert');
const { suite } = require('./helpers');
const { evaluate, asNumber, isAbsent } = require('../server/condition');

const t = suite('condition');
const prev = (value, { at = 0, met = false } = {}) => ({ value, observed_at: at, condition_met: met });

t('changed: the first observation changed, an equal one did not, tolerance and percent', () => {
    assert.strictEqual(evaluate({ condition: { op: 'changed' } }, { value: 'a' }).changed, true, 'nothing before it, so it changed');
    assert.strictEqual(evaluate({ condition: { op: 'changed' } }, { value: 'a', previous: prev('a') }).changed, false);
    assert.strictEqual(evaluate({ condition: { op: 'changed' } }, { value: 'b', previous: prev('a') }).changed, true);
    // objects compare by canonical JSON, key order does not matter
    assert.strictEqual(evaluate({ condition: { op: 'changed' } }, { value: { a: 1, b: [2, 3] }, previous: prev({ b: [2, 3], a: 1 }) }).changed, false);
    // tolerance: a move smaller than it is not a change
    const tolerance = { mode: 'threshold', tolerance: 0.5 };
    assert.strictEqual(evaluate({ comparison: tolerance, condition: { op: 'changed' } }, { value: 10.2, previous: prev(10) }).changed, false);
    assert.strictEqual(evaluate({ comparison: tolerance, condition: { op: 'changed' } }, { value: 10.6, previous: prev(10) }).changed, true);
    // percent: 20.00 → 18.00 is a 10 % move
    const percent = { mode: 'changed', percent: 5 };
    assert.strictEqual(evaluate({ comparison: percent, condition: { op: 'changed' } }, { value: 19, previous: prev(20) }).changed, false);
    assert.strictEqual(evaluate({ comparison: percent, condition: { op: 'changed' } }, { value: 18, previous: prev(20) }).changed, true);
    // mode none never changes
    assert.strictEqual(evaluate({ comparison: { mode: 'none' }, condition: { op: 'changed' } }, { value: 2, previous: prev(1) }).changed, false);
});

t('gt/gte/lt/lte: numbers, decimal strings, and no guessing', () => {
    const at = (op, v, value) => evaluate({ condition: { op, value: v } }, { value }).holds;
    assert.strictEqual(at('gt', 10, 11), true);
    assert.strictEqual(at('gt', 10, 10), false);
    assert.strictEqual(at('gte', 10, 10), true);
    assert.strictEqual(at('lt', 10, 9.99), true);
    assert.strictEqual(at('lte', 10, 10), true);
    assert.strictEqual(at('lt', 10, '9.5'), true, 'a decimal string compares as the number it states');
    assert.strictEqual(at('lt', 10, 'n/a'), false, 'a value that is not a number is never low');
    assert.strictEqual(at('gt', 10, null), false);
    assert.strictEqual(at('gt', 10, { price: 3 }), false);
    assert.strictEqual(at('gt', 'm', 'n'), true, 'strings compare as strings when the condition states one');
    // the target may come from the previous value instead of the condition
    assert.strictEqual(evaluate({ condition: { op: 'lt' } }, { value: 9, previous: prev(10) }).holds, true);
});

t('eq / ne: numbers and everything else', () => {
    const eq = (v, value) => evaluate({ condition: { op: 'eq', value: v } }, { value }).holds;
    assert.strictEqual(eq(10, 10), true);
    assert.strictEqual(eq(10, '10'), true, 'the same number stated as a string is the same number');
    assert.strictEqual(eq(10, 11), false);
    assert.strictEqual(eq('live', 'live'), true);
    assert.strictEqual(eq({ a: 1 }, { a: 1 }), true);
    assert.strictEqual(eq(null, null), true, 'eq null is "states nothing"');
    assert.strictEqual(evaluate({ condition: { op: 'ne', value: 10 } }, { value: 11 }).holds, true);
});

t('contains / matches', () => {
    const holds = (condition, value) => evaluate({ condition }, { value }).holds;
    assert.strictEqual(holds({ op: 'contains', value: 'sold' }, 'now sold out'), true);
    assert.strictEqual(holds({ op: 'contains', value: 'sold' }, 'in stock'), false);
    assert.strictEqual(holds({ op: 'contains', value: 'b' }, ['a', 'b']), true);
    assert.strictEqual(holds({ op: 'contains', value: 'price' }, { price: 3 }), true);
    assert.strictEqual(holds({ op: 'matches', value: '^v\\d+\\.\\d+' }, 'v2.3 released'), true);
    assert.strictEqual(holds({ op: 'matches', value: '^v\\d+' }, 'vX'), false);
    assert.strictEqual(holds({ op: 'matches', value: '([' }, 'anything'), false, 'an invalid pattern never throws');
    assert.strictEqual(holds({ op: 'matches', value: null }, 'anything'), false);
});

t('exists / absent', () => {
    const holds = (op, value) => evaluate({ condition: { op } }, { value }).holds;
    assert.strictEqual(holds('exists', 'x'), true);
    assert.strictEqual(holds('exists', 0), true, 'zero is a value the source stated');
    assert.strictEqual(holds('exists', false), true);
    assert.strictEqual(holds('exists', null), false);
    assert.strictEqual(holds('exists', ''), false);
    assert.strictEqual(holds('exists', []), false);
    assert.strictEqual(holds('absent', null), true);
    assert.strictEqual(holds('absent', 'x'), false);
    assert.strictEqual(isAbsent(undefined), true);
    assert.strictEqual(isAbsent({ a: 1 }), false);
});

t('for_sec: a condition must hold for that long before it is met', () => {
    const now = 1_000_000;
    const opts = { value: 11, now };
    const condition = { op: 'gt', value: 10, for_sec: 60 };
    // first sighting: holds, but the debounce has not run
    const first = evaluate({ condition }, { ...opts, previous: null, heldSince: null });
    assert.deepStrictEqual([first.holds, first.met, first.since], [true, false, now]);
    // the trail says it has held for 30 s: still not met
    assert.strictEqual(evaluate({ condition }, { ...opts, heldSince: now - 30_000 }).met, false);
    // 60 s: met
    assert.strictEqual(evaluate({ condition }, { ...opts, heldSince: now - 60_000 }).met, true);
    // a predicate that stopped holding never counts the earlier run
    const broken = evaluate({ condition }, { value: 9, now, heldSince: now - 120_000 });
    assert.deepStrictEqual([broken.holds, broken.met, broken.since], [false, false, null]);
    // for_sec 0 (or absent) fires at once
    assert.strictEqual(evaluate({ condition: { op: 'gt', value: 10, for_sec: 0 } }, opts).met, true);
    assert.strictEqual(evaluate({ condition: { op: 'gt', value: 10 } }, opts).met, true);
    // without a trail the debounce starts at this observation (never fires from nothing)
    assert.strictEqual(evaluate({ condition: { op: 'gt', value: 10, for_sec: 1 } }, { ...opts, heldSince: null }).met, false);
});

t('asNumber only reads what is stated', () => {
    assert.strictEqual(asNumber('12.50'), 12.5);
    assert.strictEqual(asNumber('-3'), -3);
    assert.strictEqual(asNumber('1e3'), 1000);
    assert.strictEqual(asNumber(''), null);
    assert.strictEqual(asNumber('free'), null);
    assert.strictEqual(asNumber('12 items'), null);
    assert.strictEqual(asNumber(true), null);
    assert.strictEqual(asNumber(Infinity), null);
});

t.run();
