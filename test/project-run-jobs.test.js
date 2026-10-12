'use strict';
/**
 * Project-scoped watches and the run-job action (project delegation, ADR-003 amendment 2026-10-12):
 *   - a watch names a project only when Network says its owner is an admin or owner of it (403 project.not_delegated,
 *     503 when Network cannot answer), checked when the project is named or changed;
 *   - a run-job action needs a project and run.job-create-request@1's class and limits (artifact for function and
 *     code); the contract draft's runtime/command/workload are refused;
 *   - a fired run-job action submits one Run job for the owner in the project, the firing under args[firing_arg], with
 *     the idempotency key watch.<check run>.<action index>; Run's final refusals fail at once, anything else retries.
 */
const assert = require('assert');
const { boot, request, site, suite, userToken, newUser, newAgent } = require('./helpers');

const t = suite('project-run-jobs');
let svc;
let web;
let price = '19.99';

const person = { sub: newUser() };
const viewer = { sub: newUser() };
const agent = { sub: newAgent() };
const P = 'prj_01JAB2C3D4E5F6G7H8J9K0MNPS';
const Q = 'prj_01JAB2C3D4E5F6G7H8J9K0MNPT';

// Network, as server/run-jobs.js createProjects would ask it: who is an admin or owner of which project.
const checks = [];
let networkDown = false;
const projects = {
    async check(project, subject) {
        checks.push([project, subject]);
        if (networkDown) throw Object.assign(new Error('Network answered 503'), { status: 503 });
        return { ok: (project === P || project === Q) && subject === person.sub };
    },
};
// OpenVibe.Run, as server/run-jobs.js createRunJobs would reach it: every submit recorded; runMode decides the answer.
const submits = [];
let runMode = 'ok';
const run = {
    async submit(req) {
        submits.push(req);
        if (runMode === 'busy') throw Object.assign(new Error('Network could not confirm'), { status: 503, code: 'project.check_unavailable' });
        if (runMode === 'refuse') throw Object.assign(new Error('not delegated'), { status: 403, code: 'project.not_delegated', detail: 'a project is named only by a first-party service acting for an admin or owner' });
        if (runMode === 'caps') throw Object.assign(new Error('over the cap'), { status: 422, code: 'run.limits.exceeded', detail: 'limits.wall_ms is at most 900000 ms for a project' });
        return { id: `job_01JAB2C3D4E5F6G7H8J9K0MN${String(submits.length).padStart(2, '0')}`, state: 'queued', created: submits.length !== 3 };
    },
};

const job = (over = {}) => ({
    kind: 'run-job', class: 'function', artifact: { name: 'restock', version: '1.0.0' },
    args: { sku: 'w-1' }, limits: { wall_ms: 60000, cpu_ms: 30000, mem_bytes: 134217728 }, egress: 'openvibe-only', ...over,
});
const def = (overrides = {}) => ({
    name: 'Widget price',
    source: { kind: 'http', url: `${web.origin}/price`, format: null },
    cadence: { every_sec: 900 },
    extraction: { kind: 'text' },
    condition: { op: 'lt', value: 10 },
    action: [job({ firing_arg: 'firing' })],
    project_id: P,
    ...overrides,
});
const refusedWith = (code, status) => (err) => { assert.strictEqual(err.code, code, err.message); if (status) assert.strictEqual(err.status, status); return true; };
const acts = async (id) => await svc.db.prepare('SELECT * FROM action_runs WHERE watch_id = ? ORDER BY rid').all(id);
const setPrice = async (v) => { await fetch(`${web.origin}/set?v=${v}`); };
async function fire(w) {
    await setPrice('19.99');
    await svc.check.run(w.id, { trigger: 'schedule' });
    await setPrice('7.50');
    const out = await svc.check.run(w.id, { trigger: 'schedule' });
    assert.strictEqual(out.run.state, 'condition_met');
    return out;
}

t('boot', async () => {
    web = await site({
        '/price': () => ({ headers: { 'content-type': 'text/plain' }, body: price }),
        '/set': (req, _res, ctx) => { price = ctx.url.searchParams.get('v') || price; return { body: 'ok' }; },
    });
    const notifications = { async push() { return { sent: true }; } };
    svc = await boot({ notifications, run, projects });
});

t('a watch names a project its owner is an admin or owner of; anyone else, and an agent, is refused', async () => {
    const w = await svc.registry.create(def(), person);
    assert.strictEqual(w.project_id, P);
    assert.deepStrictEqual(checks.pop(), [P, person.sub], 'checked with Network when named');
    assert.strictEqual(svc.registry.view(w).project_id, P, 'the view carries it (watch.watch@1)');
    await assert.rejects(() => svc.registry.create(def(), viewer), refusedWith('project.not_delegated', 403));
    await assert.rejects(() => svc.registry.create(def({ project_id: 'prj_01JAB2C3D4E5F6G7H8J9K0MNPV' }), person), refusedWith('project.not_delegated', 403), 'a project they do not run');
    await assert.rejects(() => svc.registry.create(def(), agent), refusedWith('project.not_delegated', 403), 'an agent never names a project');
    networkDown = true;
    try { await assert.rejects(() => svc.registry.create(def(), person), refusedWith('watch.project_check_unavailable', 503)); }
    finally { networkDown = false; }
    // A watch without run-job actions may name a project or not.
    const plain = await svc.registry.create(def({ action: [{ kind: 'notification' }], project_id: undefined }), person);
    assert.strictEqual(plain.project_id, null);
});

t('a run-job action needs a project and Run\'s job fields; the draft\'s fields are refused', async () => {
    await assert.rejects(() => svc.registry.create(def({ project_id: undefined }), person), refusedWith('watch.project_required'));
    await assert.rejects(() => svc.registry.create(def({ project_id: null }), person), refusedWith('watch.project_required'));
    for (const [action, re] of [
        [{ kind: 'run-job', runtime: 'function', command: 'node x.js' }, /runtime is not accepted/],
        [job({ workload: {} }), /workload is not accepted/],
        [job({ class: undefined }), /class is required/],
        [job({ limits: undefined }), /limits is required/],
        [job({ artifact: undefined }), /artifact is required for a function job/],
        [job({ firing_arg: 'sku' }), /firing_arg names a key args already has/],
    ]) {
        await assert.rejects(() => svc.registry.create(def({ action: [action] }), person), (err) => {
            assert.strictEqual(err.code, 'watch.invalid', err.message);
            assert.match(err.message, re);
            return true;
        });
    }
    // A class that runs no artifact needs none (browser, linux…): Run places it when a node offers it.
    const browser = await svc.registry.create(def({ action: [job({ class: 'browser', artifact: undefined })] }), person);
    assert.ok(browser.id);
});

t('patch: clearing the project of a run-job watch is refused; a new project is checked, an untouched one is not', async () => {
    const w = await svc.registry.create(def(), person);
    await assert.rejects(() => svc.registry.patch(w.id, { project_id: null }, person), refusedWith('watch.project_required'));
    const before = checks.length;
    await svc.registry.patch(w.id, { name: 'renamed' }, person);
    assert.strictEqual(checks.length, before, 'the project the watch already has is not asked about again (Run asks at every job)');
    const moved = await svc.registry.patch(w.id, { project_id: Q }, person);
    assert.strictEqual(moved.project_id, Q);
    assert.deepStrictEqual(checks.pop(), [Q, person.sub]);
    await assert.rejects(() => svc.registry.patch(w.id, { project_id: 'prj_01JAB2C3D4E5F6G7H8J9K0MNPV' }, person), refusedWith('project.not_delegated', 403));
    const plain = await svc.registry.patch(w.id, { action: [{ kind: 'notification' }], project_id: null }, person);
    assert.strictEqual(plain.project_id, null, 'without run-job actions the project may go');
});

t('the API answers the refusals with their own status', async () => {
    const token = userToken(viewer.sub);
    const r = await request(svc.base, 'POST', '/api/v1/watches', { token, body: def() });
    assert.strictEqual(r.status, 403, r.text);
    assert.strictEqual(r.body.code, 'project.not_delegated');
    const missing = await request(svc.base, 'POST', '/api/v1/watches', { token: userToken(person.sub), body: def({ project_id: undefined }) });
    assert.strictEqual(missing.status, 422, missing.text);
    assert.strictEqual(missing.body.code, 'watch.project_required');
});

t('a fired run-job action submits one job for the owner in the project, with the firing, under one key', async () => {
    submits.length = 0; runMode = 'busy';
    const w = await svc.registry.create(def({ name: 'restock' }), person);
    const out = await fire(w);
    let r = await svc.actions.tick();
    assert.deepStrictEqual(r, { sent: 0, skipped: 0, retried: 1, failed: 0 }, 'Run (or Network behind it) unavailable: retried');
    runMode = 'ok';
    await svc.db.prepare('UPDATE action_runs SET next_attempt_at = 0 WHERE watch_id = ?').run(w.id);
    r = await svc.actions.tick();
    assert.deepStrictEqual(r, { sent: 1, skipped: 0, retried: 0, failed: 0 });
    const [first, second] = submits;
    assert.strictEqual(first.subjectId, person.sub, 'for the owner');
    assert.strictEqual(first.projectId, P, 'in the watch\'s project');
    assert.strictEqual(first.idempotencyKey, `watch.${out.run.id}.0`);
    assert.strictEqual(second.idempotencyKey, first.idempotencyKey, 'the retry is the same job');
    assert.deepStrictEqual({ ...first.job, args: undefined }, {
        class: 'function', artifact: { name: 'restock', version: '1.0.0' }, limits: { wall_ms: 60000, cpu_ms: 30000, mem_bytes: 134217728 }, egress: 'openvibe-only', args: undefined,
    }, 'run.job-create-request@1 fields only (no kind, no firing_arg)');
    assert.strictEqual(first.job.args.sku, 'w-1');
    const firing = first.job.args.firing;
    assert.deepStrictEqual([firing.watch_id, firing.check_run_id, firing.value, firing.previous_value], [w.id, out.run.id, '7.50', '19.99']);
    assert.ok(firing.watch_url.endsWith(`/watches/${w.id}`) && firing.observed_at);
    const [row] = await acts(w.id);
    assert.deepStrictEqual([row.state, row.last_error], ['sent', 'Run job job_01JAB2C3D4E5F6G7H8J9K0MN02']);
    const req = typeof row.request === 'string' ? JSON.parse(row.request) : row.request;
    assert.strictEqual(req.project_id, P, 'the project is fixed when the action is queued');
});

t('Run\'s final refusals fail at once; an agent-owned or project-less row never reaches Run', async () => {
    for (const mode of ['refuse', 'caps']) {
        runMode = mode;
        const w = await svc.registry.create(def({ name: `refused ${mode}` }), person);
        await fire(w);
        const r = await svc.actions.tick();
        assert.deepStrictEqual(r, { sent: 0, skipped: 0, retried: 0, failed: 1 }, mode);
        assert.match((await acts(w.id))[0].last_error, mode === 'refuse' ? /watch\.action_refused: project\.not_delegated/ : /watch\.action_refused: run\.limits\.exceeded/);
    }
    runMode = 'ok';
    // A row queued for a watch whose project was cleared behind the registry's back (or never set): not sent.
    const w = await svc.registry.create(def({ name: 'no project' }), person);
    await svc.db.prepare('UPDATE watches SET project_id = NULL WHERE id = ?').run(w.id);
    const before = submits.length;
    await fire(w);
    const [row] = await acts(w.id);
    assert.deepStrictEqual([row.state, /project_required/.test(row.last_error)], ['unavailable', true]);
    await svc.actions.tick();
    assert.strictEqual(submits.length, before, 'nothing submitted');
});

t('server/run-jobs.js asks Network and Run as Watch, for the owner, once', async () => {
    const { createProjects, createRunJobs } = require('../server/run-jobs');
    const calls = [];
    let answer = { project_id: P, subject: person.sub, role: 'admin', archived: false, added_at: null };
    let fail = null;
    const client = { async json(o) { calls.push(o); if (fail) throw fail; return answer; } };
    const projectsLive = createProjects(client, { networkUrl: 'http://127.0.0.1:4000' });
    assert.deepStrictEqual(await projectsLive.check(P, person.sub), { ok: true });
    const c = calls[0];
    assert.deepStrictEqual([c.service, c.baseUrl, c.audience, c.method, c.path, c.retries],
        ['network', 'http://127.0.0.1:4000', 'openvibe.network', 'GET', `/internal/projects/${P}/members/${person.sub}`, 0]);
    for (const [a, why] of [
        [{ ...answer, role: 'developer' }, 'a developer'], [{ ...answer, role: 'viewer' }, 'a viewer'],
        [{ ...answer, archived: true }, 'an archived project'], [{ ...answer, subject: viewer.sub }, 'an answer about someone else'],
    ]) { answer = a; assert.deepStrictEqual(await projectsLive.check(P, person.sub), { ok: false }, why); }
    answer = { ...answer, role: 'owner', archived: false, subject: person.sub };
    assert.deepStrictEqual(await projectsLive.check(P, person.sub), { ok: true }, 'an owner');
    fail = Object.assign(new Error('not found'), { status: 404 });
    assert.deepStrictEqual(await projectsLive.check(P, person.sub), { ok: false }, 'a non-member');
    fail = Object.assign(new Error('down'), { status: 503 });
    await assert.rejects(() => projectsLive.check(P, person.sub), /down/, 'Network down: the caller answers 503');
    fail = null;

    answer = { created: true, job: { id: 'job_X', state: 'queued' } };
    const runLive = createRunJobs(client, { baseUrl: 'http://127.0.0.1:4920' });
    const outJob = await runLive.submit({ subjectId: person.sub, projectId: P, job: { class: 'function', limits: { wall_ms: 1, cpu_ms: 1, mem_bytes: 1 } }, idempotencyKey: 'watch.r.0' });
    assert.deepStrictEqual(outJob, { id: 'job_X', state: 'queued', created: true });
    const s = calls[calls.length - 1];
    assert.deepStrictEqual([s.service, s.baseUrl, s.audience, s.method, s.path, s.retries, s.idempotencyKey],
        ['run', 'http://127.0.0.1:4920', 'openvibe.run', 'POST', '/api/v1/jobs', 0, false]);
    assert.deepStrictEqual(s.headers, { 'X-OV-Subject': person.sub, 'X-OV-Project': P });
    assert.deepStrictEqual(s.json, { class: 'function', limits: { wall_ms: 1, cpu_ms: 1, mem_bytes: 1 }, idempotency_key: 'watch.r.0' });
});

t('done', async () => { await web.close(); await svc.stop(); });

t.run();
