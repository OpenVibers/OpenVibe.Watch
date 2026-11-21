'use strict';
/**
 * The usage carrier (plan AD.37, Contracts 0.450.0; the owner, 11-21: "detect your usage limit and … use that on Watch …
 * if the weekly reset's coming up and there's still usage available"): a person's watch reads their coding agents' plan
 * windows from OpenVibe.Codes as Watch (the owner in X-OV-Subject); the check states every window and, at the top, the
 * one that resets soonest with room left, so `left_pct` and `hours_to_reset` are what a condition reads. A watch that
 * is not a person's is refused when it is saved; Codes' refusal is a recorded failure.
 */
const assert = require('assert');
const { boot, suite, newUser } = require('./helpers');
const { windowsOf, choose, windowKind } = require('../server/carriers/usage');

const t = suite('usage-carrier');
const PERSON = { sub: newUser() };
const NOW = Date.parse('2026-11-21T04:00:00Z');
const H = 3600e3;
const asked = [];
let reply = null;
const codes = {
    start: async () => ({}),
    usage: async (subject) => { asked.push(subject); if (reply instanceof Error) throw reply; return reply; },
};
let svc;
const VIEW = { agents: [
    { agent: 'claude-code', windows: [{ name: 'Current session (5h)', pct: 40, resets_at: new Date(NOW + 2 * H).toISOString() }, { name: 'Current week (all models)', pct: 70, resets_at: new Date(NOW + 9 * H).toISOString() }] },
    { agent: 'codex', windows: [{ name: 'weekly', used: 10, limit: 100, resets_at: new Date(NOW + 120 * H).toISOString() }, { name: '5h', pct: 100, resets_at: new Date(NOW + 1 * H).toISOString() }] },
] };

t('windows are read flat, and the one that resets soonest with room left is chosen', () => {
    assert.deepStrictEqual(['Current session (5h)', 'Current week (all models)', 'weekly', 'hourly'].map(windowKind), ['5h', 'week', 'week', '5h']);
    const w = windowsOf(VIEW, NOW);
    assert.strictEqual(w.length, 4);
    assert.deepStrictEqual(w.find((x) => x.agent === 'codex' && x.window === 'week'), { agent: 'codex', window: 'week', used_pct: 10, left_pct: 90, resets_at: new Date(NOW + 120 * H).toISOString(), hours_to_reset: 120 });
    assert.deepStrictEqual([choose(w).agent, choose(w).window], ['claude-code', '5h'], 'soonest with room: the full codex 5h is passed over');
    assert.deepStrictEqual([choose(w, { window: 'week' }).agent, choose(w, { window: 'week' }).left_pct], ['claude-code', 30]);
    assert.deepStrictEqual([choose(w, { agent: 'codex', window: 'week' }).hours_to_reset], [120]);
    assert.strictEqual(choose(w, { agent: 'nobody' }), null);
    const passed = windowsOf({ agents: [{ agent: 'x', windows: [{ name: 'week', pct: 95, resets_at: new Date(NOW - H).toISOString() }] }] }, NOW);
    assert.strictEqual(passed[0].left_pct, 100, 'a window whose reset has passed is whole again');
});

t('boot with a stand-in for Codes', async () => {
    svc = await boot({ codes, now: () => NOW });
});

const create = async (source, owner = PERSON) => (await svc.registry.create({
    name: 'use my week', source, cadence: { every_sec: 3600 }, extraction: { kind: 'json', value_path: 'left_pct' }, condition: { op: 'gte', value: 15 }, action: [{ kind: 'notification' }],
}, owner)).id;
const lastRun = async (id) => (await svc.db.prepare('SELECT * FROM check_runs WHERE watch_id = ? ORDER BY rid DESC').get(id));
const lastValue = async (id) => {
    const o = await svc.db.prepare('SELECT * FROM observations WHERE watch_id = ? ORDER BY rid DESC').get(id);
    return o ? (typeof o.value === 'string' ? JSON.parse(o.value) : o.value) : undefined;
};

t('a person\'s watch reads their windows from Codes as them; the chosen window is at the top', async () => {
    reply = VIEW;
    const id = await create({ kind: 'usage', window: 'week' });
    await svc.check.run(id, { trigger: 'manual' });
    assert.strictEqual(asked.at(-1), PERSON.sub, 'asked for the owner');
    const run = await lastRun(id);
    assert.deepStrictEqual([run.carrier, run.state === 'http_error'], ['usage', false]);
    assert.strictEqual(await lastValue(id), 30, 'claude-code\'s week: 30% left');
});

t('Codes\' refusal is a recorded failure; an agent\'s watch is refused when it is saved', async () => {
    const id = await create({ kind: 'usage' });
    reply = Object.assign(new Error('capability codes.task.read is not granted'), { code: 'capability.denied', status: 403 });
    await svc.check.run(id, { trigger: 'manual' });
    const run = await lastRun(id);
    assert.deepStrictEqual([run.state, run.error_code], ['http_error', 'capability.denied']);
    await assert.rejects(create({ kind: 'usage' }, { sub: 'agt_01M4XTHNFFAWWZQHB4XTMSN1YB' }), /must belong to a person/);
    await assert.rejects(create({ kind: 'usage', window: 'month' }), /window|usage|source/i);
});

t('done', async () => { await svc.stop(); });

t.run();
