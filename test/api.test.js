'use strict';
/**
 * The API: one capability per route (service and person tokens), owner scoping (404, never 403),
 * the released validator behind 422, the check/observations/checks reads, and per-actor limits.
 */
const assert = require('assert');
const { validate } = require('openvibe-contracts');
const { boot, request, serviceToken, userToken, site, suite, watchDef, newUser } = require('./helpers');

const t = suite('api');
let svc;
let web;
let price = '19.99';

const READER = serviceToken('news', ['watch.watch.read']);
const OBSERVER = serviceToken('news', ['watch.observation.read']);
const RUNNER = serviceToken('news', ['watch.check.run']);
const MANAGER = serviceToken('site', ['watch.watch.manage']);
const ALL = serviceToken('site', ['watch.*']);
const me = newUser();
const other = newUser();
const ME = userToken(me);
const OTHER = userToken(other);

const api = (method, p, opts = {}) => request(svc.base, method, p, opts);
const mine = (overrides = {}) => watchDef({
    source: { kind: 'http', url: `${web.origin}/price`, format: null },
    name: 'my watch',
    ...overrides,
});

t('boot', async () => {
    web = await site({ '/price': () => ({ body: price }) });
    svc = await boot();
});

t('every route needs a token, and the one capability it serves', async () => {
    assert.strictEqual((await api('GET', '/api/v1/watches')).status, 401);
    assert.strictEqual((await api('GET', '/api/v1/watches', { token: 'not-a-token' })).status, 401);
    assert.strictEqual((await api('GET', '/api/v1/watches', { token: serviceToken('news', ['watch.watch.manage']) })).status, 403);
    assert.strictEqual((await api('POST', '/api/v1/watches', { token: READER, body: mine() })).status, 403);
    assert.strictEqual((await api('GET', '/api/v1/watches', { token: serviceToken('news', ['watch.watch.read'], { aud: 'openvibe.search' }) })).status, 401, 'another audience');
    assert.strictEqual((await api('GET', '/api/v1/watches', { token: serviceToken('news', ['watch.*']) })).status, 200, 'a family grant covers it');
    // a person's bearer token is enough for their own watches
    assert.strictEqual((await api('GET', '/api/v1/watches', { token: ME })).status, 200);
    assert.strictEqual((await api('GET', '/api/v1/watches', { token: userToken(me, { aud: 'openvibe.deals' }) })).status, 401);
    // a watch id that does not exist is 404 on every route
    const ghost = 'wch_01J0000000000000000000000';
    assert.strictEqual((await api('GET', `/api/v1/watches/${ghost}`, { token: ME })).status, 404);
    assert.strictEqual((await api('DELETE', `/api/v1/watches/${ghost}`, { token: ME })).status, 404);
    assert.strictEqual((await api('POST', `/api/v1/watches/${ghost}/check`, { token: ME })).status, 404);
    assert.strictEqual((await api('GET', `/api/v1/watches/${ghost}/observations`, { token: OBSERVER })).status, 404);
    assert.strictEqual((await api('GET', `/api/v1/watches/${ghost}/checks`, { token: OBSERVER })).status, 404);
});

t('create, read, list: the released contracts on both sides, and the view is the contract', async () => {
    const created = await api('POST', '/api/v1/watches', { token: ME, body: mine({ labels: { room: 'kitchen' } }) });
    assert.strictEqual(created.status, 201, created.text);
    const watch = created.body.watch;
    assert.match(watch.id, /^wch_/);
    assert.strictEqual(watch.owner, me);
    assert.deepStrictEqual(watch.labels, { room: 'kitchen' });
    assert.ok(validate('watch.watch@1', watch).valid);
    assert.ok(validate('watch.watch-result@1', created.body).valid);
    const one = await api('GET', `/api/v1/watches/${watch.id}`, { token: ME });
    assert.strictEqual(one.status, 200);
    assert.deepStrictEqual(one.body.watch, watch);
    const list = await api('GET', '/api/v1/watches', { token: ME });
    assert.strictEqual(list.status, 200);
    assert.deepStrictEqual(list.body.watches.map(w => w.id), [watch.id]);
    assert.ok(validate('watch.watch-result@1', list.body).valid, 'exactly { watches }: the cursor is the last id');
    // a service token with the read capability reads the same (it is the same subject)
    const service = await api('GET', `/api/v1/watches/${watch.id}`, { token: serviceToken('site', ['watch.watch.read']) });
    assert.strictEqual(service.status, 404, 'svc:site is not the person');
});

t('an invalid body is 422 with the validator\'s detail, and nothing is written', async () => {
    const before = (await svc.db.prepare('SELECT COUNT(*) AS n FROM watches').get()).n;
    const bad = [
        [mine({ source: undefined }), /requires source/],
        [mine({ cadence: null }), /needs a cadence/],
        [mine({ condition: undefined }), /requires condition/],
        [mine({ action: [] }), /watch.watch-request@1/],
        [mine({ source: { kind: 'http', url: 'http://example.org/x', headers: { cookie: 'a=b' } } }), /cookie/],
        [mine({ nope: true }), /watch.watch-request@1/],
        // the registry's own rules the API must obey too: the cadence floor and a safe pattern
        [mine({ cadence: { every_sec: 60 } }), /at least 900/],
        [mine({ extraction: { kind: 'regex', selector: '(a+)+$' } }), /extraction\/selector/],
        [mine({ condition: { op: 'matches', value: '(a+)+$' } }), /condition\/value/],
    ];
    for (const [body, re] of bad) {
        const res = await api('POST', '/api/v1/watches', { token: ME, body });
        assert.strictEqual(res.status, 422, JSON.stringify(body));
        assert.strictEqual(res.body.code, 'watch.invalid');
        assert.match(res.body.detail, re);
    }
    assert.strictEqual((await svc.db.prepare('SELECT COUNT(*) AS n FROM watches').get()).n, before);
    // malformed JSON is 400, and a body that is not an object is 422
    const raw = await fetch(`${svc.base}/api/v1/watches`, { method: 'POST', headers: { Authorization: `Bearer ${ME}`, 'Content-Type': 'application/json' }, body: '{' });
    assert.strictEqual(raw.status, 400);
    assert.strictEqual((await api('POST', '/api/v1/watches', { token: ME, body: [1, 2] })).status, 422);
});

t('patch, pause, resume, delete — and another owner gets 404 for every one of them', async () => {
    const { body: { watch } } = await api('POST', '/api/v1/watches', { token: ME, body: mine() });
    const patched = await api('PATCH', `/api/v1/watches/${watch.id}`, { token: ME, body: { name: 'renamed', cadence: { every_sec: 1800 } } });
    assert.strictEqual(patched.status, 200);
    assert.strictEqual(patched.body.watch.name, 'renamed');
    assert.strictEqual(patched.body.watch.cadence.every_sec, 1800);
    assert.ok(validate('watch.watch-result@1', patched.body).valid);

    const paused = await api('POST', `/api/v1/watches/${watch.id}/pause`, { token: ME });
    assert.strictEqual(paused.status, 200);
    assert.deepStrictEqual(paused.body, { id: watch.id, status: 'paused' });
    assert.ok(validate('watch.watch-result@1', paused.body).valid);
    const resumed = await api('POST', `/api/v1/watches/${watch.id}/resume`, { token: ME });
    assert.deepStrictEqual(resumed.body, { id: watch.id, status: 'active' });

    // another owner: 404, never 403, and the watch is untouched
    for (const [method, path, body] of [['GET', '', undefined], ['PATCH', '', { name: 'stolen' }], ['POST', '/pause', undefined], ['DELETE', '', undefined]]) {
        const res = await api(method, `/api/v1/watches/${watch.id}${path}`, { token: OTHER, body });
        assert.strictEqual(res.status, 404, `${method} ${path}`);
        assert.strictEqual(res.body.code, 'watch.not_found');
    }
    assert.deepStrictEqual((await api('GET', '/api/v1/watches', { token: OTHER })).body.watches, []);
    assert.strictEqual((await api('GET', `/api/v1/watches/${watch.id}`, { token: ME })).body.watch.name, 'renamed');

    const gone = await api('DELETE', `/api/v1/watches/${watch.id}`, { token: ME });
    assert.strictEqual(gone.status, 200);
    assert.deepStrictEqual(gone.body, { id: watch.id, deleted: true });
    assert.ok(validate('watch.watch-result@1', gone.body).valid);
    assert.strictEqual((await api('GET', `/api/v1/watches/${watch.id}`, { token: ME })).status, 404);
});

t('X-OV-Subject: a first-party service acts for a person; nobody else may name one', async () => {
    const created = await api('POST', '/api/v1/watches', { token: MANAGER, body: mine(), headers: { 'X-OV-Subject': me } });
    assert.strictEqual(created.status, 201);
    assert.strictEqual(created.body.watch.owner, me);
    // the person sees the service's watch, the service itself does not own it
    assert.ok((await api('GET', '/api/v1/watches', { token: ME })).body.watches.some(w => w.id === created.body.watch.id));
    assert.strictEqual((await api('GET', `/api/v1/watches/${created.body.watch.id}`, { token: serviceToken('site', ['watch.watch.read']) })).status, 404);
    // a person may not delegate, and a subject must be a subject
    assert.strictEqual((await api('GET', '/api/v1/watches', { token: ME, headers: { 'X-OV-Subject': other } })).status, 403);
    assert.strictEqual((await api('GET', '/api/v1/watches', { token: ALL, headers: { 'X-OV-Subject': 'nobody' } })).status, 400);
    // a service that does not own the watch and names nobody gets 404, not a peek
    assert.strictEqual((await api('GET', `/api/v1/watches/${created.body.watch.id}`, { token: serviceToken('site', ['watch.watch.read']) })).status, 404);
});

t('a manual check runs one check and answers the released check-run; observations and checks read back', async () => {
    const { body: { watch } } = await api('POST', '/api/v1/watches', { token: ME, body: mine({ condition: { op: 'lt', value: 10 } }) });
    const run = await api('POST', `/api/v1/watches/${watch.id}/check`, { token: ME });
    assert.strictEqual(run.status, 200, run.text);
    assert.ok(validate('watch.check-run@1', run.body).valid, JSON.stringify(run.body));
    assert.strictEqual(run.body.trigger, 'manual');
    assert.strictEqual(run.body.carrier, 'http');
    assert.strictEqual(run.body.state, 'changed');
    assert.strictEqual(run.body.observations, 1);
    assert.strictEqual(run.body.triggers, 0);

    const observations = await api('GET', `/api/v1/watches/${watch.id}/observations`, { token: ME });
    assert.strictEqual(observations.status, 200, observations.text);
    assert.strictEqual(observations.body.observations.length, 1);
    assert.ok(validate('watch.observation@1', observations.body.observations[0]).valid);
    assert.strictEqual(observations.body.observations[0].value, '19.99');
    const checks = await api('GET', `/api/v1/watches/${watch.id}/checks`, { token: ME });
    assert.deepStrictEqual(checks.body.checks.map(c => c.id), [run.body.id]);
    assert.ok(validate('watch.check-run@1', checks.body.checks[0]).valid);
    // a first-party service reads and runs them for the person it names (X-OV-Subject)
    assert.strictEqual((await api('GET', `/api/v1/watches/${watch.id}/observations`, { token: OBSERVER, headers: { 'X-OV-Subject': me } })).status, 200);
    assert.strictEqual((await api('POST', `/api/v1/watches/${watch.id}/check`, { token: RUNNER, headers: { 'X-OV-Subject': me } })).status, 200);
    // without the delegation the same service is a stranger: 404, never 403
    assert.strictEqual((await api('GET', `/api/v1/watches/${watch.id}/observations`, { token: OBSERVER })).status, 404);
    assert.strictEqual((await api('POST', `/api/v1/watches/${watch.id}/check`, { token: RUNNER })).status, 404);
    // and the wrong capability is 403 however it is scoped
    assert.strictEqual((await api('GET', `/api/v1/watches/${watch.id}/observations`, { token: READER, headers: { 'X-OV-Subject': me } })).status, 403);
    // a watch whose carrier is a later step answers 422 and never fetches
    const later = await api('POST', '/api/v1/watches', {
        token: ME,
        body: mine({ source: { kind: 'webhook', endpoint: '/internal/hooks/x' }, cadence: null, extraction: { kind: 'json' } }),
    });
    const refused = await api('POST', `/api/v1/watches/${later.body.watch.id}/check`, { token: ME });
    assert.strictEqual(refused.status, 422);
    assert.strictEqual(refused.body.code, 'watch.carrier_unavailable');
    assert.match(refused.body.detail, /step 5/);
    // a paused watch cannot be checked by hand either
    await api('POST', `/api/v1/watches/${watch.id}/pause`, { token: ME });
    const paused = await api('POST', `/api/v1/watches/${watch.id}/check`, { token: ME });
    assert.strictEqual(paused.status, 409);
    assert.strictEqual(paused.body.code, 'watch.disabled');
});

t('list filters and the page cursor', async () => {
    const who = { sub: newUser() };
    const TOKEN = userToken(who.sub);
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await api('POST', '/api/v1/watches', { token: TOKEN, body: mine({ name: `w${i}` }) })).body.watch.id);
    const page = await api('GET', '/api/v1/watches?limit=2', { token: TOKEN });
    assert.deepStrictEqual(page.body.watches.map(w => w.id), [ids[2], ids[1]]);
    const next = await api('GET', `/api/v1/watches?limit=2&before=${page.body.watches[1].id}`, { token: TOKEN });
    assert.deepStrictEqual(next.body.watches.map(w => w.id), [ids[0]]);
    await api('POST', `/api/v1/watches/${ids[0]}/pause`, { token: TOKEN });
    assert.deepStrictEqual((await api('GET', '/api/v1/watches?status=paused', { token: TOKEN })).body.watches.map(w => w.id), [ids[0]]);
    assert.strictEqual((await api('GET', '/api/v1/watches?status=nonsense', { token: TOKEN })).status, 400);
    assert.strictEqual((await api('GET', '/api/v1/watches', { token: ALL })).status, 200, 'watch.* covers read');
});

t('per-actor limits: the writes and the manual checks each have their own budget', async () => {
    const who = newUser();
    const TOKEN = userToken(who);
    let refused = null;
    for (let i = 0; i < 40 && !refused; i++) {
        const res = await api('POST', '/api/v1/watches', { token: TOKEN, body: mine({ name: `limit ${i}` }) });
        if (res.status === 429) refused = res;
        else assert.strictEqual(res.status, 201);
    }
    assert.ok(refused, 'the write budget refused the 31st create');
    assert.strictEqual(refused.body.code, 'rate_limited');
    assert.ok(Number(refused.headers.get('retry-after')) > 0);
    // another actor is unaffected
    assert.strictEqual((await api('GET', '/api/v1/watches', { token: ME })).status, 200);
});

t('the API answers 404 for anything else, and health/readiness are honest', async () => {
    assert.strictEqual((await api('GET', '/api/v1/nope', { token: ME })).status, 404);
    assert.strictEqual((await api('GET', '/api/health')).status, 200);
    const ready = await api('GET', '/api/ready');
    assert.strictEqual(ready.status, 200);
    assert.strictEqual(ready.body.checks.db.status, 'ok');
    assert.strictEqual(ready.body.checks.checker.detail.enabled, false, 'the tests run with the worker off');
    const home = await fetch(`${svc.base}/`, { headers: { Accept: 'text/plain' } });
    assert.match(await home.text(), /\/api\/v1\/watches/);
    const html = await fetch(`${svc.base}/`, { headers: { Accept: 'text/html' } });
    assert.match(await html.text(), /OpenVibe\.Watch/);
});

t('done', async () => { await web.close(); await svc.stop(); });

t.run();
