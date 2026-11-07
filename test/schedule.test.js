'use strict';
/**
 * Routines: a watch with a five-field cron instead of a source to fetch. The cron parser, the API route
 * that saves it (owner-only, 15-minute floor), the scheduled check that queues the watch's action once
 * per occurrence, the scheduler's due query, and the actor-agent delivery carrying the Actor trigger id.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, request, userToken, suite, newUser, newAgent } = require('./helpers');
const cron = require('../server/cron');

const t = suite('schedule');
let svc;
const person = newUser();
const other = newUser();
const ME = userToken(person);
const OTHER = userToken(other);
const agent = newAgent();
const actorCalls = [];
const actor = {
    async create(req) { actorCalls.push(req); return { id: ids.newId('task'), state: 'queued' }; },
    async runAgent(req) { actorCalls.push(req); return { id: ids.newId('task'), state: 'queued' }; },
};
const notifications = { async push() { return { sent: true }; } };
const api = (method, p, opts = {}) => request(svc.base, method, p, opts);

const routine = (overrides = {}) => ({
    name: 'Actor routine: summarise my inbox',
    status: 'paused',
    source: { kind: 'webhook' },
    cadence: null,
    extraction: { kind: 'text' },
    condition: { op: 'exists' },
    action: [{ kind: 'actor-agent', agent_id: agent, note: 'summarise my inbox' }],
    labels: { actor_trigger: 'trg_01M6VNTQD7NB3QH8K4R2S9T6VW' },
    ...overrides,
});

t('cron: weekdays at 9 in Berlin, Sunday evening, and the 15-minute floor', async () => {
    const monday = Date.UTC(2026, 10, 9, 9);   // Mon 9 Nov 2026 10:00 Berlin, after 09:00 local
    const next = new Date(cron.next('0 9 * * 1-5', 'Europe/Berlin', monday));
    assert.strictEqual(next.toISOString(), '2026-11-10T08:00:00.000Z', 'Tuesday 09:00 CET');
    // Friday 09:00 to Monday 09:00 is the weekend: still the next weekday occurrence.
    const friday = Date.UTC(2026, 10, 13, 8);
    assert.strictEqual(new Date(cron.next('0 9 * * 1-5', 'Europe/Berlin', friday)).toISOString(), '2026-11-16T08:00:00.000Z');
    assert.strictEqual(new Date(cron.next('0 19 * * 0', 'Europe/Berlin', Date.UTC(2026, 10, 8, 12))).toISOString(), '2026-11-08T18:00:00.000Z', 'Sunday 19:00 CET');
    assert.strictEqual(cron.validate('0 9 * * 1-5', 'Europe/Berlin').valid, true);
    const fast = cron.validate('*/5 * * * *', 'Europe/Berlin');
    assert.strictEqual(fast.valid, false);
    assert.match(fast.error, /15 minutes/);
    assert.strictEqual(cron.validate('0 9 * * 1-5', 'Mars/Olympus').valid, false, 'an unknown zone is refused');
    assert.strictEqual(cron.validate('0 9 * *', 'UTC').valid, false, 'five fields are required');
    assert.strictEqual(new Date(cron.next('30 8 * * *', 'UTC', Date.UTC(2026, 10, 9, 8, 0))).toISOString(), '2026-11-09T08:30:00.000Z');
});

t('boot', async () => {
    svc = await boot({ actor, notifications, worker: 'off' });
});

t('the schedule route is the person\'s, validates the cron and 404s another person', async () => {
    const made = await api('POST', '/api/v1/watches', { token: ME, body: routine() });
    assert.strictEqual(made.status, 201, made.text);
    const id = made.body.watch.id;
    assert.strictEqual(made.body.watch.status, 'paused');

    const bad = await api('POST', `/api/v1/watches/${id}/schedule`, { token: ME, body: { cron: '*/5 * * * *', timezone: 'Europe/Berlin' } });
    assert.strictEqual(bad.status, 422, bad.text);
    assert.match(bad.text, /15 minutes/);

    const ok = await api('POST', `/api/v1/watches/${id}/schedule`, { token: ME, body: { cron: '0 9 * * 1-5', timezone: 'Europe/Berlin' } });
    assert.strictEqual(ok.status, 200, ok.text);
    assert.deepStrictEqual(ok.body.schedule, { cron: '0 9 * * 1-5', timezone: 'Europe/Berlin' });
    assert.strictEqual(ok.body.next_due_at, null, 'a paused routine is not armed');

    assert.strictEqual((await api('POST', `/api/v1/watches/${id}/schedule`, { token: OTHER, body: { cron: '0 9 * * 1-5', timezone: 'Europe/Berlin' } })).status, 404, 'another person gets 404');
    assert.strictEqual((await api('POST', '/api/v1/watches/wch_01M6VNTQD796C68VF8B182VAGS/schedule', { token: ME, body: { cron: '0 9 * * 1-5', timezone: 'UTC' } })).status, 404, 'a ghost id is 404');

    const resumed = await api('POST', `/api/v1/watches/${id}/resume`, { token: ME });
    assert.strictEqual(resumed.status, 200, resumed.text);
    const view = await api('GET', `/api/v1/watches/${id}`, { token: ME });
    assert.ok(view.body.watch.health.next_due_at, 'a resumed routine shows its next run');
    assert.ok(view.body.watch.health.next_due_at > new Date().toISOString());
});

t('a scheduled check runs the action once and rearms for the next occurrence', async () => {
    const made = await api('POST', '/api/v1/watches', { token: ME, body: routine({ name: 'nightly brief', labels: { actor_trigger: 'trg_01M6VNTQD7NB3QH8K4R2S9T6VW' } }) });
    const id = made.body.watch.id;
    await api('POST', `/api/v1/watches/${id}/schedule`, { token: ME, body: { cron: '0 7 * * *', timezone: 'UTC' } });
    await api('POST', `/api/v1/watches/${id}/resume`, { token: ME });

    const out = await svc.check.run(id, { trigger: 'schedule' });
    assert.strictEqual(out.run.state, 'condition_met');
    assert.strictEqual(out.run.triggers, 1);
    assert.strictEqual(out.run.carrier, 'schedule');
    const runs = await svc.db.prepare('SELECT * FROM check_runs WHERE watch_id = ? ORDER BY rid').all(id);
    assert.strictEqual(runs.length, 1);
    const actions = await svc.db.prepare('SELECT * FROM action_runs WHERE watch_id = ?').all(id);
    assert.strictEqual(actions.length, 1);
    assert.strictEqual(actions[0].kind, 'actor-agent');
    const request = typeof actions[0].request === 'string' ? JSON.parse(actions[0].request) : actions[0].request;
    assert.strictEqual(request.trigger_id, 'trg_01M6VNTQD7NB3QH8K4R2S9T6VW');
    assert.strictEqual(request.watch_id, id);

    await svc.actions.tick();
    const call = actorCalls.find((c) => c.agentId === agent && c.triggerId === 'trg_01M6VNTQD7NB3QH8K4R2S9T6VW');
    assert.ok(call, 'the actor-agent delivery names the subscription and the Actor trigger');
    assert.strictEqual(call.watchId, id);

    const row = await svc.db.prepare('SELECT * FROM watches WHERE id = ?').get(id);
    assert.ok(row.next_due_at > Date.now(), 'the next occurrence is armed');
    assert.strictEqual(Number(row.consecutive_failures), 0);
});

t('the scheduler due query includes a routine and never a paused one', async () => {
    const made = await api('POST', '/api/v1/watches', { token: ME, body: routine({ name: 'due routine' }) });
    const id = made.body.watch.id;
    await api('POST', `/api/v1/watches/${id}/schedule`, { token: ME, body: { cron: '0 7 * * *', timezone: 'UTC' } });
    await api('POST', `/api/v1/watches/${id}/resume`, { token: ME });
    await svc.db.prepare('UPDATE watches SET next_due_at = 0 WHERE id = ?').run(id);
    assert.ok((await svc.registry.due(10)).some((w) => w.id === id), 'a due routine is in the scheduler queue');
    const idsRun = await svc.scheduler.tick();
    assert.ok(idsRun.includes(id));
    await new Promise((r) => setTimeout(r, 100));
    const row = await svc.db.prepare('SELECT status, next_due_at FROM watches WHERE id = ?').get(id);
    assert.strictEqual(row.status, 'active');
    assert.ok(row.next_due_at > Date.now());
});

t('a routine is not a webhook address anyone can push to', async () => {
    const made = await api('POST', '/api/v1/watches', { token: ME, body: routine({ name: 'not a hook' }) });
    assert.strictEqual(made.status, 201, made.text);
    const id = made.body.watch.id;
    await api('POST', `/api/v1/watches/${id}/schedule`, { token: ME, body: { cron: '0 7 * * *', timezone: 'UTC' } });
    const pushed = await fetch(`${svc.base}/hooks/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.strictEqual(pushed.status, 404);
});

t.done = true;
(async () => { await t.run(); await svc.stop(); })().catch((err) => { console.error(err); process.exit(1); });
