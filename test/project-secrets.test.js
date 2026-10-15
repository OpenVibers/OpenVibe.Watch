'use strict';
/**
 * Project secrets in Watch (ADR-056, Contracts 0.179.0): a watch in a project names a secret instead of an operator's
 * environment variable.
 *   - a source credential (auth.secret_ref) is revealed by Network for the source URL's origin at fetch time and sent as
 *     the mode says; a secret Network refuses leaves the credential missing (the check says so), never a guess;
 *   - a webhook action (secret_ref) is signed by Network over "<t>.<raw body>" in the usual headers, so the receiver
 *     verifies with verifyDeliveryV2 and its own secret; Watch never holds the value; a refused secret makes the action
 *     unavailable, Network unreachable is retried;
 *   - a watch naming a project secret must name its project; project_env is production by default and shown.
 */
const assert = require('assert');
const crypto = require('crypto');
const { verifyDeliveryV2 } = require('openvibe-sdk/events');
const { validate } = require('openvibe-contracts');
const { boot, site, suite, newUser } = require('./helpers');
const { SecretRefused } = require('../server/project-secrets');

const t = suite('project-secrets');
const PROJECT = 'prj_01JAB2C3D4E5F6G7H8J9K0MNPR';
const SIGNING = `ovs_${crypto.randomBytes(24).toString('hex')}`;
const TOKEN = 't'.repeat(40);
const person = { sub: newUser() };
let svc;
let web;
let price = '19.99';
const seen = [];          // what the source saw: its Authorization header
const posts = [];
const uses = [];
let networkDown = false;
// OpenVibe.Network's secrets/use, as the project granted them: api_token revealed to the source's origin only,
// webhook-signing for sign. Production only.
const projectSecrets = {
    async reveal({ project_id, environment, name, origin }) {
        uses.push({ purpose: 'reveal', project_id, environment, name, origin });
        if (networkDown) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        if (project_id !== PROJECT || environment !== 'production' || name !== 'api_token' || origin !== web.origin) throw new SecretRefused(`project secret ${name} is not granted to watch for reveal to ${origin}`);
        return { value: TOKEN, version: 1 };
    },
    async sign({ project_id, environment, name, message }) {
        uses.push({ purpose: 'sign', project_id, environment, name, message });
        if (networkDown) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        if (project_id !== PROJECT || environment !== 'production' || name !== 'webhook-signing') throw new SecretRefused(`project secret ${name} is not granted to watch for sign`);
        return { signature: crypto.createHmac('sha256', SIGNING).update(message).digest('hex'), version: 2 };
    },
};
async function post(url, { headers, body }) { posts.push({ url, headers, body }); return { status: 204 }; }
const projects = { async check() { return { ok: true }; } };

const def = (overrides = {}) => ({
    name: 'Private price',
    project_id: PROJECT,
    source: { kind: 'http', url: `${web.origin}/price`, format: null, auth: { mode: 'bearer', secret_ref: 'api_token' } },
    cadence: { every_sec: 900 },
    extraction: { kind: 'text' },
    condition: { op: 'lt', value: 10 },
    action: [{ kind: 'webhook', url: 'https://hooks.example.org/w', secret_ref: 'webhook-signing' }],
    ...overrides,
});
const check = async (id) => await svc.check.run(id, { trigger: 'schedule' });
const acts = async (id) => await svc.db.prepare('SELECT * FROM action_runs WHERE watch_id = ? ORDER BY rid').all(id);

t('boot', async () => {
    web = await site({
        '/price': (req) => { seen.push(req.headers.authorization || null); return { headers: { 'content-type': 'text/plain' }, body: price }; },
    });
    svc = await boot({ post, projects, projectSecrets });
});

t('a watch naming a project secret must name its project; project_env is production by default and shown', async () => {
    await assert.rejects(svc.registry.create(def({ project_id: undefined }), person), (e) => e.code === 'watch.project_required');
    const row = await svc.registry.create(def(), person);
    const view = svc.registry.view(row);
    assert.strictEqual(view.project_env, 'production');
    assert.ok(validate('watch.watch@1', view).valid, JSON.stringify(validate('watch.watch@1', view).errors));
    assert.strictEqual(view.source.auth.secret_ref, 'api_token');
    assert.ok(!JSON.stringify(view).includes(TOKEN), 'no value is stored or shown');
});

t('the source credential is revealed for the source\'s origin and sent as a bearer token', async () => {
    const row = await svc.registry.create(def({ name: 'Bearer check', action: [{ kind: 'notification', priority: 'low' }] }), person);
    seen.length = 0;
    const out = await check(row.id);
    assert.strictEqual(out.run.state === 'failed', false, JSON.stringify(out.run).slice(0, 300));
    assert.deepStrictEqual(seen, [`Bearer ${TOKEN}`]);
    const asked = uses.filter((u) => u.purpose === 'reveal').pop();
    assert.deepStrictEqual([asked.project_id, asked.environment, asked.name, asked.origin], [PROJECT, 'production', 'api_token', web.origin]);
    const stored = JSON.stringify(await svc.db.prepare('SELECT * FROM watches WHERE id = ?').get(row.id));
    assert.ok(!stored.includes(TOKEN));
});

t('a credential Network refuses is missing: nothing is sent with a guessed value, and the check says why', async () => {
    const row = await svc.registry.create(def({ name: 'Wrong env', project_env: 'sandbox', action: [{ kind: 'notification', priority: 'low' }] }), person);
    seen.length = 0;
    const out = await check(row.id);
    assert.deepStrictEqual(seen, [], 'the source was not asked without its credential');
    assert.match(JSON.stringify(out.run), /project secret api_token is not available/);
});

t('the webhook is signed by Network and verifies with the project secret; refused and unreachable behave', async () => {
    const row = await svc.registry.create(def({ name: 'Signed hook' }), person);
    price = '19.99'; await check(row.id);
    price = '7.50'; const out = await check(row.id);
    assert.strictEqual(out.run.state, 'condition_met');
    posts.length = 0;
    await svc.actions.tick();
    assert.strictEqual(posts.length, 1);
    const d = posts[0];
    assert.ok(verifyDeliveryV2(d.body, d.headers, SIGNING), 'verifies with the project secret');
    const signed = uses.filter((u) => u.purpose === 'sign').pop();
    assert.strictEqual(signed.message, `${d.headers['X-OpenVibe-Timestamp']}.${d.body}`, 'Network signed exactly what was sent');
    assert.strictEqual((await acts(row.id))[0].state, 'sent');

    const refused = await svc.registry.create(def({ name: 'Ungranted hook', action: [{ kind: 'webhook', url: 'https://hooks.example.org/w', secret_ref: 'not-granted' }] }), person);
    price = '19.99'; await check(refused.id);
    price = '7.50'; await check(refused.id);
    await svc.actions.tick();
    const r = (await acts(refused.id))[0];
    assert.strictEqual(r.state, 'unavailable');
    assert.match(r.last_error, /watch\.action_secret_not_granted/);

    const later = await svc.registry.create(def({ name: 'Network down hook' }), person);
    price = '19.99'; await check(later.id);
    price = '7.50'; await check(later.id);
    networkDown = true;
    posts.length = 0;
    await svc.actions.tick();
    networkDown = false;
    const l = (await acts(later.id))[0];
    assert.strictEqual(posts.length, 0, 'nothing unsigned was sent');
    assert.ok(['queued', 'retrying'].includes(l.state), `retried later (${l.state}: ${l.last_error})`);
});

t('done', async () => { await web.close(); await svc.stop(); });
t.run();
