'use strict';
/**
 * The carriers and the SSRF guard, against stub HTTP servers (nothing here touches the internet):
 * conditional GET with ETag, the 304 path, the unchanged-body path, the HEAD-first path, feeds and
 * APIs, credentials read by environment-variable name, and the refusals — a redirect to a private
 * address, a private host, a port the guard does not allow.
 */
const assert = require('assert');
const { boot, request, site, serviceToken, suite, rss } = require('./helpers');

const t = suite('carriers');
const OWNER = { sub: 'svc:carrier-test' };
let svc;
let web;

const watch = async (overrides = {}) => (await svc.registry.create({
    name: 'carrier watch',
    source: { kind: 'http', url: `${web.origin}/page`, format: null },
    cadence: { every_sec: 60 },
    extraction: { kind: 'text' },
    condition: { op: 'eq', value: 'never-matches' },
    action: [{ kind: 'notification' }],
    ...overrides,
}, OWNER)).id;

const check = async (id, trigger = 'manual') => await svc.check.run(id, { trigger });
const runs = async (id) => await svc.db.prepare('SELECT * FROM check_runs WHERE watch_id = ? ORDER BY rid').all(id);

t('boot with a stub site', async () => {
    let version = 1;
    web = await site({
        '/page': (req) => {
            if (req.headers['if-none-match'] === `"v${version}"`) return { status: 304, headers: { etag: `"v${version}"` } };
            return { headers: { etag: `"v${version}"`, 'content-type': 'text/plain' }, body: `value ${version}` };
        },
        '/bump': () => { version += 1; return { body: 'ok' }; },
        '/stable': () => ({ headers: { 'content-type': 'text/plain' }, body: 'unchanging' }),
        '/redirect-private': () => ({ status: 302, headers: { location: 'http://127.0.0.2/elsewhere' } }),
        '/redirect-loop': () => ({ status: 302, headers: { location: '/redirect-loop' } }),
        '/feed.xml': () => ({ headers: { 'content-type': 'application/rss+xml' }, body: rss([
            { guid: 'g2', title: 'Widget 2', link: 'https://example.org/2', description: 'the newer one' },
            { guid: 'g1', title: 'Widget 1', link: 'https://example.org/1' },
        ]) }),
        '/api.json': () => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify({ products: [{ sku: 'A', price: 19.5 }, { sku: 'B', price: 4 }] }) }),
        '/secret.json': (req) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify({ saw: req.url }) }),
    });
    svc = await boot();
});

t('a conditional GET stores the validators, and the next check gets 304 → not_modified', async () => {
    const id = await watch();
    const first = await check(id);
    // the first observation is a change from nothing: there was no value before it
    assert.strictEqual(first.run.state, 'changed', first.run.detail || '');
    const state = await svc.db.prepare('SELECT * FROM watch_endpoint_state WHERE watch_id = ?').get(id);
    assert.strictEqual(state.etag, '"v1"');
    assert.strictEqual(state.last_status, 200);
    assert.strictEqual((await runs(id)).length, 1);

    const second = await check(id);
    assert.strictEqual(second.run.state, 'not_modified');
    const got = web.hits('/page');
    assert.strictEqual(got[got.length - 1].headers['if-none-match'], '"v1"', 'the second request asked conditionally');
    assert.strictEqual((await runs(id)).length, 2, 'a 304 is still a recorded check run');
    const observations = await svc.db.prepare('SELECT * FROM observations WHERE watch_id = ?').all(id);
    assert.strictEqual(observations.length, 1, 'a 304 records no observation: nothing was stated');
});

t('a 200 with an unchanged body is no_change, and a changed body is changed', async () => {
    const id = await watch({ source: { kind: 'http', url: `${web.origin}/stable`, format: null } });
    const first = await check(id);
    assert.deepStrictEqual(first.value, 'unchanging');
    const second = await check(id);
    assert.strictEqual(second.run.state, 'no_change');
    assert.strictEqual((await svc.db.prepare('SELECT COUNT(*) AS n FROM observations WHERE watch_id = ?').get(id)).n, 1);

    // a body that changes, with a condition that does not fire: the run says `changed`
    const bump = await watch();
    await check(bump);
    await request(web.origin, 'GET', '/bump');
    const after = await check(bump);
    assert.strictEqual(after.run.state, 'changed');
    assert.strictEqual(after.run.triggers, 0);
    const obs = await svc.db.prepare('SELECT * FROM observations WHERE watch_id = ? ORDER BY rid').all(bump);
    assert.deepStrictEqual(obs.map((o) => [o.changed, o.condition_met, o.previous_hash != null]), [[1, 0, false], [1, 0, true]]);
});

t('HEAD first when only change is needed: a 304 answers without a body', async () => {
    const id = await watch({ condition: { op: 'changed' } });
    await check(id);                       // stores the validators
    const before = web.hits('/page').length;
    const out = await check(id);
    assert.strictEqual(out.run.state, 'not_modified');
    const seen = web.hits('/page').slice(before);
    assert.deepStrictEqual(seen.map((r) => r.method), ['HEAD'], 'a conditional HEAD, no GET');
});

t('a redirect to a private address is refused at the hop, the first request only', async () => {
    const id = await watch({ source: { kind: 'http', url: `${web.origin}/redirect-private`, format: null } });
    const before = web.hits('/redirect-private').length;
    const out = await check(id);
    assert.strictEqual(out.run.state, 'http_error');
    assert.strictEqual(out.run.error_code, 'address_refused');
    assert.match(out.run.detail, /redirect|not a public address/);
    const elsewhere = web.requests.filter(r => r.path === '/elsewhere');
    assert.strictEqual(elsewhere.length, 0, 'the redirect target was never fetched');
    assert.strictEqual(web.hits('/redirect-private').length - before, 1);
});

t('a redirect loop stops at WATCH_MAX_REDIRECTS', async () => {
    const id = await watch({ source: { kind: 'http', url: `${web.origin}/redirect-loop`, format: null } });
    const out = await check(id);
    assert.strictEqual(out.run.state, 'http_error');
    assert.strictEqual(out.run.error_code, 'too_many_redirects');
});

t('a private host is refused before any request (nothing is even connected to)', async () => {
    const aSite = await site({ '/page': () => ({ body: 'should never be fetched' }) });
    // the stub's port is allowed, so only the ADDRESS rule can refuse this URL
    const alone = await boot({ allowPrivate: false, env: { WATCH_ALLOWED_PORTS: `80,443,${new URL(aSite.origin).port}` } });
    try {
        const w = await alone.registry.create({
            name: 'loopback watch',
            source: { kind: 'http', url: `${aSite.origin}/page`, format: null },
            cadence: { every_sec: 60 }, extraction: { kind: 'text' }, condition: { op: 'eq', value: 'x' },
            action: [{ kind: 'notification' }],
        }, OWNER);
        const out = await alone.check.run(w.id, { trigger: 'manual' });
        assert.strictEqual(out.run.state, 'http_error');
        assert.strictEqual(out.run.error_code, 'address_refused');
        assert.strictEqual(aSite.requests.length, 0, 'the guard refused before the socket');
        await aSite.close();
    } finally { await alone.stop(); }
});

t('the guard refuses ports outside WATCH_ALLOWED_PORTS and URL credentials', async () => {
    const { createGuard } = require('../server/net/guard');
    const guard = createGuard({ allowedPorts: [80, 443], allowPrivateHosts: [] });
    assert.throws(() => guard.checkUrl('http://example.org:8080/x'), (e) => e.code === 'port_refused');
    assert.throws(() => guard.checkUrl('http://user:pw@example.org/x'), (e) => e.code === 'bad_url');
    assert.throws(() => guard.checkUrl('file:///etc/passwd'), (e) => e.code === 'bad_url');
    assert.throws(() => guard.checkUrl('http://10.0.0.5/x'), (e) => e.code === 'address_refused');
    assert.throws(() => guard.checkUrl('http://[::1]/x'), (e) => e.code === 'address_refused');
    assert.strictEqual(guard.checkUrl('https://example.org/x').hostname, 'example.org');
});

t('a credential is read from the environment by name, at fetch time, and never stored', async () => {
    const id = await watch({
        source: { kind: 'api', url: `${web.origin}/secret.json`, format: 'json', auth: { mode: 'query', env: 'WATCH_CRED_TEST', param: 'k' } },
        extraction: { kind: 'json', value_path: 'saw' },
    });
    // not set: the check is recorded disabled and nothing is fetched
    const before = web.hits('/secret.json').length;
    const missing = await check(id);
    assert.strictEqual(missing.run.state, 'disabled');
    assert.strictEqual(missing.run.error_code, 'credential_missing');
    assert.strictEqual(web.hits('/secret.json').length, before, 'no request was made');
    // the stored watch and its view carry the NAME, never a value
    const view = await request(svc.base, 'GET', `/api/v1/watches/${id}`, { token: serviceToken('carrier-test', ['watch.watch.read']) });
    assert.strictEqual(view.status, 200);
    assert.deepStrictEqual(view.body.watch.source.auth, { mode: 'query', env: 'WATCH_CRED_TEST', param: 'k' });
    assert.ok(!view.text.includes('s3cret-value'));
    // set on the config's environment: the next fetch carries it, and it is not written anywhere
    svc.config.secrets.WATCH_CRED_TEST = 's3cret-value';
    const out = await check(id);
    assert.strictEqual(out.run.state, 'changed');
    const hit = web.hits('/secret.json').pop();
    assert.strictEqual(hit.search, '?k=s3cret-value');
    const stored = await svc.db.prepare('SELECT source FROM watches WHERE id = ?').get(id);
    assert.ok(!JSON.stringify(stored).includes('s3cret-value'), 'the value is never stored');
    delete svc.config.secrets.WATCH_CRED_TEST;
});

t('the feed carrier parses RSS and the extraction reads the latest entry', async () => {
    const id = await watch({
        source: { kind: 'feed', url: `${web.origin}/feed.xml`, format: 'rss' },
        extraction: { kind: 'json', value_path: 'latest.title' },
        condition: { op: 'eq', value: 'nothing' },
    });
    const out = await check(id);
    assert.strictEqual(out.run.state, 'changed', out.run.detail || '');
    assert.strictEqual(out.value, 'Widget 2');
    const items = await watch({
        source: { kind: 'feed', url: `${web.origin}/feed.xml`, format: null, fields: { name: 'title', url: 'link' } },
        extraction: { kind: 'json', fields: { first: 'items.0.name', count: 'count' } },
    });
    const all = await check(items);
    assert.deepStrictEqual(all.value, { first: 'Widget 2', count: 2 });
    const broken = await watch({ source: { kind: 'feed', url: `${web.origin}/stable`, format: null } });
    const bad = await check(broken);
    assert.strictEqual(bad.run.state, 'parse_error');
    assert.strictEqual(bad.run.error_code, 'unreadable');
});

t('the api carrier maps items_path + fields, and reads the body directly without a mapping', async () => {
    const mapped = await watch({
        source: { kind: 'api', url: `${web.origin}/api.json`, format: 'json', items_path: 'products', fields: { sku: 'sku', price: 'price' } },
        extraction: { kind: 'json', value_path: 'latest.price' },
    });
    const out = await check(mapped);
    assert.strictEqual(out.run.state, 'changed', out.run.detail || '');
    assert.strictEqual(out.value, 19.5);

    const direct = await watch({
        source: { kind: 'api', url: `${web.origin}/api.json`, format: 'json' },
        extraction: { kind: 'jsonpath', value_path: 'products.1.sku' },
    });
    assert.strictEqual((await check(direct)).value, 'B');

    const wrongPath = await watch({
        source: { kind: 'api', url: `${web.origin}/api.json`, format: 'json', items_path: 'nope' },
        extraction: { kind: 'json' },
    });
    const bad = await check(wrongPath);
    assert.strictEqual(bad.run.state, 'parse_error');
    assert.strictEqual(bad.run.error_code, 'items_path');
});

t('done', async () => { await web.close(); await svc.stop(); });

t.run();
