'use strict';
/**
 * The public site (plan T18 step 8): sign-in with the stand-in Network, the signed-out pages, the
 * four create templates against what the API would store, validation errors that keep the input,
 * ownership 404 on every page and form, pause/resume/delete/check-now, cross-site refusal, and
 * hostile names/values escaped everywhere.
 */
const assert = require('assert');
const { boot, request, site, suite, userToken } = require('./helpers');

const t = suite('site');
let svc;
let web;
let me;
let other;
let ME;
let OTHER;
let session;   // the cookie from a real sign-in

const create = (fields) => svc.get('/watches/new', { cookie: session, form: fields });
const indexOf = (res) => (String(res.location || '').match(/\/watches\/(wch_[0-9A-HJKMNP-TV-Z]{26})/) || [])[1] || null;

t('boot', async () => {
    web = await site({ '/price': () => ({ body: '<html><body><span class="price">19.99</span></body></html>' }) });
    svc = await boot();
    me = svc.network.addUser('ada');
    other = svc.network.addUser('grace');
    ME = userToken(me.subject);
    OTHER = userToken(other.subject);
});

t('the signed-out pages say what Watch is and ask for a sign-in', async () => {
    const home = await svc.get('/', { headers: { accept: 'text/html' } });
    assert.strictEqual(home.status, 200);
    assert.match(home.text, /OpenVibe\.Watch/);
    assert.match(home.text, /template=page/);
    assert.match(home.text, /template=price/);
    assert.match(home.text, /template=feed/);
    assert.match(home.text, /template=json/);
    assert.match(home.text, /Sign in with OpenVibe/);
    assert.strictEqual(home.headers.get('content-type').split(';')[0], 'text/html');

    const watches = await svc.get('/watches');
    assert.strictEqual(watches.status, 200);
    assert.match(watches.text, /Sign in with OpenVibe/);

    const redirect = await svc.get('/watches/new');
    assert.strictEqual(redirect.status, 303);
    assert.match(redirect.headers.get('location'), /^\/auth\/login\?next=/);

    const one = await svc.get('/watches/wch_01J0000000000000000000000');
    assert.strictEqual(one.status, 303, 'a signed-out watch page asks for a sign-in');

    const how = await svc.get('/how-it-works');
    assert.strictEqual(how.status, 200);
    assert.match(how.text, /If-None-Match/);
    assert.match(how.text, /15 minutes/);
});

t('sign-in with the stand-in Network: PKCE, a session, and /auth/me', async () => {
    const who = svc.network.addUser('ada');   // same username, distinct subject for this flow test
    const out = await svc.login(who);
    assert.strictEqual(out.status, 302);
    assert.strictEqual(out.location, '/watches');
    assert.ok(out.cookie && out.cookie.startsWith('watch_session='), 'a session cookie is set');

    // /auth/me answers the signed-in person's identity and nothing more.
    const meRes = await svc.get('/auth/me', { cookie: out.cookie });
    assert.strictEqual(meRes.status, 200);
    assert.strictEqual(meRes.json().user.subject_id, who.subject);
    assert.strictEqual(meRes.json().user.username, 'ada');

    // A garbage session cookie is a guest, not an error.
    const guest = await svc.get('/auth/me', { cookie: 'watch_session=nonsense' });
    assert.strictEqual(guest.status, 401);

    // The token exchange really ran, with the PKCE verifier, against the stand-in Network.
    assert.ok(svc.network.requests.some((r) => r.path === '/oauth/token'));

    // Sign-out revokes the session: the same cookie no longer reads a person.
    const bye = await svc.get('/auth/logout', { cookie: out.cookie, method: 'POST', form: {} });
    assert.strictEqual(bye.status, 303);
    const after = await svc.get('/watches', { cookie: out.cookie });
    assert.match(after.text, /Sign in with OpenVibe/);

    // The state must match the browser that started: a callback with the wrong state is refused.
    const started = await svc.get('/auth/login?next=%2Fwatches');
    const flow = started.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('watch_oauth='));
    const bad = await svc.get('/auth/callback?code=code_x&state=not-the-state', { cookie: flow });
    assert.strictEqual(bad.status, 400);
});

t('a person signs in for the rest of the tests', async () => {
    session = await svc.signIn(me);
    const mine = await svc.get('/watches', { cookie: session });
    assert.strictEqual(mine.status, 200);
    assert.match(mine.text, /no watches yet/i);
});

t('each template creates exactly what the API would store, and the API reads it back', async () => {
    const cases = [
        ['page', { template: 'page', name: 'Home page', url: `${web.origin}/price`, selector: '.price', cadence: '3600', notify: 'on' }, {
            name: 'Home page', source: { kind: 'http', url: `${web.origin}/price`, format: null },
            cadence: { every_sec: 3600, jitter_sec: 0 }, extraction: { kind: 'html', selector: '.price' },
            condition: { op: 'changed' }, action: [{ kind: 'notification', category: 'service', priority: 'normal' }],
        }],
        ['price', { template: 'price', name: 'Laptop price', url: `${web.origin}/price`, extraction: 'css', selector: '.price', op: 'lt', value: '20', cadence: '900', notify: 'on' }, {
            name: 'Laptop price', source: { kind: 'http', url: `${web.origin}/price`, format: null },
            cadence: { every_sec: 900, jitter_sec: 0 }, extraction: { kind: 'css', selector: '.price' },
            condition: { op: 'lt', value: 20 }, action: [{ kind: 'notification', category: 'service', priority: 'normal' }],
        }],
        ['feed', { template: 'feed', name: 'Releases', url: 'https://example.org/releases.atom', cadence: '21600', notify: 'on' }, {
            name: 'Releases', source: { kind: 'feed', url: 'https://example.org/releases.atom', format: null },
            cadence: { every_sec: 21600, jitter_sec: 0 }, extraction: { kind: 'json', value_path: 'latest' },
            condition: { op: 'changed' }, action: [{ kind: 'notification', category: 'service', priority: 'normal' }],
        }],
        ['json', { template: 'json', name: 'Stock', url: 'https://api.example.org/stock', value_path: 'data.count', op: 'gt', value: '0', cadence: '86400', notify: 'on' }, {
            name: 'Stock', source: { kind: 'api', url: 'https://api.example.org/stock', format: null },
            cadence: { every_sec: 86400, jitter_sec: 0 }, extraction: { kind: 'json', value_path: 'data.count' },
            condition: { op: 'gt', value: 0 }, action: [{ kind: 'notification', category: 'service', priority: 'normal' }],
        }],
    ];
    for (const [label, form, expected] of cases) {
        const created = await create(form);
        assert.strictEqual(created.status, 303, `${label}: ${created.text}`);
        const id = indexOf(created);
        assert.ok(id, `${label}: a watch id came back`);
        // The API, as the same person, reads it back and sees exactly the request the form meant.
        const read = await request(svc.base, 'GET', `/api/v1/watches/${id}`, { token: ME });
        assert.strictEqual(read.status, 200, `${label}: ${read.text}`);
        for (const [k, v] of Object.entries(expected)) assert.deepStrictEqual(read.body.watch[k], v, `${label}.${k}`);
        assert.strictEqual(read.body.watch.owner, me.subject);
    }
});

t('notify me off stores an event action instead of a notification, and says so', async () => {
    const created = await create({ template: 'page', name: 'Quiet', url: 'https://example.org/quiet', cadence: '3600' });
    assert.strictEqual(created.status, 303);
    const read = await request(svc.base, 'GET', `/api/v1/watches/${indexOf(created)}`, { token: ME });
    assert.deepStrictEqual(read.body.watch.action, [{ kind: 'event', event_type: 'watch.watch.triggered' }]);
});

t('validation errors re-render the form with the registry\'s message and the person\'s input', async () => {
    const badUrl = await create({ template: 'page', name: 'Keep me', url: 'not-a-url', selector: '.x', cadence: '3600' });
    assert.strictEqual(badUrl.status, 422);
    assert.match(badUrl.text, /must start with http/);
    assert.match(badUrl.text, /value="Keep me"/, 'the name is kept');
    assert.match(badUrl.text, /value="\.x"/, 'the selector is kept');

    const badCadence = await create({ template: 'page', url: 'https://example.org/a', cadence: '60' });
    assert.strictEqual(badCadence.status, 422);
    assert.match(badCadence.text, /shortest cadence here is 15 minutes/);

    // A url the schema refuses (the registry's own message, mapped to the field).
    const refused = await create({ template: 'json', url: 'ftp://example.org/x', cadence: '3600', op: 'gt', value: '1', value_path: 'n' });
    assert.strictEqual(refused.status, 422);
    assert.match(refused.text, /must start with http|url/);

    // A condition that needs a value, and one outside the template's ops.
    const noValue = await create({ template: 'price', url: 'https://example.org/p', extraction: 'css', selector: '.p', op: 'lt', value: '' });
    assert.strictEqual(noValue.status, 422);
    assert.match(noValue.text, /needs a value/);
});

t('another person\'s watch is 404 on every page and form', async () => {
    const created = await create({ template: 'page', name: 'Mine', url: 'https://example.org/mine', cadence: '3600' });
    const id = indexOf(created);
    for (const [method, path] of [['GET', ''], ['GET', '/edit'], ['POST', '/edit'], ['POST', '/pause'], ['POST', '/resume'], ['POST', '/check'], ['POST', '/delete']]) {
        const res = await svc.get(`/watches/${id}${path}`, { as: other, method, form: method === 'POST' ? {} : undefined });
        assert.strictEqual(res.status, 404, `${method} ${path}`);
        assert.match(res.text, /Watch not found/);
    }
    // The owner still sees it.
    const mine = await svc.get(`/watches/${id}`, { cookie: session });
    assert.strictEqual(mine.status, 200);
    assert.match(mine.text, /Mine/);
});

t('pause, resume, check now (against a stub site), and delete', async () => {
    const created = await create({ template: 'price', name: 'Stub price', url: `${web.origin}/price`, extraction: 'css', selector: '.price', op: 'lt', value: '20', cadence: '900' });
    const id = indexOf(created);

    const paused = await svc.get(`/watches/${id}/pause`, { cookie: session, form: {} });
    assert.strictEqual(paused.status, 303);
    let view = (await request(svc.base, 'GET', `/api/v1/watches/${id}`, { token: ME })).body.watch;
    assert.strictEqual(view.status, 'paused');

    // check-now of a paused watch is the API's 409, said in words.
    const refused = await svc.get(`/watches/${id}/check`, { cookie: session, form: {} });
    assert.strictEqual(refused.status, 409);
    assert.match(refused.text, /is paused, so it is not checked/);

    const resumed = await svc.get(`/watches/${id}/resume`, { cookie: session, form: {} });
    assert.strictEqual(resumed.status, 303);

    const ran = await svc.get(`/watches/${id}/check`, { cookie: session, form: {} });
    assert.strictEqual(ran.status, 303);
    assert.match(ran.headers.get('location'), /ran=condition_met/, '19.99 is below 20: the condition fired');
    assert.strictEqual(web.hits('/price').length, 1);

    const detail = await svc.get(`/watches/${id}`, { cookie: session });
    assert.match(detail.text, /19\.99/, 'the observation history shows the value');
    assert.match(detail.text, /Condition met/);
    assert.match(detail.text, /Observation history/);

    const gone = await svc.get(`/watches/${id}/delete`, { cookie: session, form: {} });
    assert.strictEqual(gone.status, 303);
    assert.strictEqual((await svc.get(`/watches/${id}`, { cookie: session })).status, 404);
});

t('edit is the same form with PATCH semantics, and the home summary counts the person\'s watches', async () => {
    const created = await create({ template: 'price', name: 'Before', url: `${web.origin}/price`, extraction: 'css', selector: '.price', op: 'lt', value: '20', cadence: '900' });
    const id = indexOf(created);

    const form = await svc.get(`/watches/${id}/edit`, { cookie: session });
    assert.strictEqual(form.status, 200);
    assert.match(form.text, /value="Before"/);
    assert.match(form.text, /value="20"/);

    const saved = await svc.get(`/watches/${id}/edit`, {
        cookie: session,
        form: { template: 'price', name: 'After', url: `${web.origin}/price`, extraction: 'css', selector: '.price', op: 'lt', value: '15', cadence: '21600', notify: 'on' },
    });
    assert.strictEqual(saved.status, 303, saved.text);
    assert.strictEqual(saved.headers.get('location'), `/watches/${id}`);
    const view = (await request(svc.base, 'GET', `/api/v1/watches/${id}`, { token: ME })).body.watch;
    assert.strictEqual(view.name, 'After');
    assert.deepStrictEqual(view.condition, { op: 'lt', value: 15 });
    assert.strictEqual(view.cadence.every_sec, 21600);

    // An invalid edit keeps the input and changes nothing.
    const bad = await svc.get(`/watches/${id}/edit`, {
        cookie: session, form: { template: 'price', name: 'Broken', url: `${web.origin}/price`, extraction: 'css', selector: '.price', op: 'lt', value: '', cadence: '900' },
    });
    assert.strictEqual(bad.status, 422);
    assert.match(bad.text, /needs a value/);
    assert.match(bad.text, /value="Broken"/);
    const unchanged = (await request(svc.base, 'GET', `/api/v1/watches/${id}`, { token: ME })).body.watch;
    assert.strictEqual(unchanged.name, 'After');

    const home = await svc.get('/', { cookie: session, headers: { accept: 'text/html' } });
    assert.strictEqual(home.status, 200);
    assert.match(home.text, /Your watches/);
    assert.match(home.text, /You have <strong>\d+<\/strong> watch/);
});

t('the watches list pages with before, newest first', async () => {
    // Enough watches to fill a page (PAGE = 25), made through the API so the site's write budget is
    // not spent. The pager is the last id of the page, since a wch_ id is a ULID (creation order).
    for (let i = 0; i < 26; i++) {
        const made = await request(svc.base, 'POST', '/api/v1/watches', { token: ME, body: {
            name: `Page ${i}`,
            source: { kind: 'http', url: `https://example.org/page/${i}`, format: null },
            cadence: { every_sec: 86400, jitter_sec: 0 },
            extraction: { kind: 'text' },
            condition: { op: 'changed' },
            action: [{ kind: 'notification', category: 'service', priority: 'normal' }],
        } });
        assert.strictEqual(made.status, 201, made.text);
    }
    const first = await svc.get('/watches', { cookie: session });
    assert.strictEqual(first.status, 200);
    assert.match(first.text, /Older watches/);
    const before = (first.text.match(/\/watches\?before=(wch_[0-9A-HJKMNP-TV-Z]{26})/) || [])[1];
    assert.ok(before, 'the pager carries the last id of the page');
    const second = await svc.get(`/watches?before=${before}`, { cookie: session });
    assert.strictEqual(second.status, 200);
    assert.match(second.text, /Newest first/);
    // The union of the two pages lists no id twice, and neither lists the cursor's watch again.
    const ids = (text) => [...text.matchAll(/\/watches\/(wch_[0-9A-HJKMNP-TV-Z]{26})"/g)].map((m) => m[1]);
    const listed = [...ids(first.text), ...ids(second.text)];
    assert.strictEqual(new Set(listed).size, listed.length, 'no watch appears twice');
    assert.ok(!ids(second.text).includes(before), 'the second page starts after the cursor');
    assert.strictEqual(ids(first.text).length, 25, 'a full first page');
});

t('a kind whose carrier is not built is never fetched: check-now is 422 with the reason', async () => {
    const body = {
        name: 'Event watch',
        source: { kind: 'event', pattern: 'host.release.published', filter: null },
        cadence: null,
        extraction: { kind: 'json', value_path: '$.release' },
        condition: { op: 'changed' },
        action: [{ kind: 'notification', category: 'service', priority: 'normal' }],
    };
    const made = await request(svc.base, 'POST', '/api/v1/watches', { token: ME, body });
    assert.strictEqual(made.status, 201, made.text);
    const res = await svc.get(`/watches/${made.body.watch.id}/check`, { cookie: session, form: {} });
    assert.strictEqual(res.status, 422);
    assert.match(res.text, /not checked yet|carrier/i);
});

t('check-now is limited per person, with a friendly 429 and Retry-After', async () => {
    const u = svc.network.addUser('hurried');
    const cookie = await svc.signIn(u);
    const made = await svc.get('/watches/new', { cookie, form: { template: 'page', name: 'Hurried', url: `${web.origin}/price`, cadence: '3600' } });
    const id = indexOf(made);
    let refused = null;
    for (let i = 0; i < 12 && !refused; i++) {
        const res = await svc.get(`/watches/${id}/check`, { cookie, form: {} });
        if (res.status === 429) refused = res;
    }
    assert.ok(refused, 'the 11th manual check in a minute is refused');
    assert.match(refused.text, /Slow down/);
    assert.ok(Number(refused.headers.get('retry-after')) > 0);
});

t('a signed-in write from another site is refused', async () => {
    const before = (await request(svc.base, 'GET', '/api/v1/watches', { token: ME })).body.watches.length;
    const res = await svc.get('/watches/new', { cookie: session, form: { template: 'page', url: 'https://example.org/x', cadence: '3600' }, origin: 'https://evil.example' });
    assert.strictEqual(res.status, 403);
    assert.match(res.text, /Cross-site request refused/);
    const after = (await request(svc.base, 'GET', '/api/v1/watches', { token: ME })).body.watches.length;
    assert.strictEqual(after, before, 'nothing was created');

    const made = await create({ template: 'page', url: 'https://example.org/owned', cadence: '3600' });
    const id = indexOf(made);
    for (const path of ['/pause', '/resume', '/delete', '/check']) {
        const r = await svc.get(`/watches/${id}${path}`, { cookie: session, form: {}, origin: 'https://evil.example' });
        assert.strictEqual(r.status, 403, path);
    }
});

t('hostile names, values and details are escaped on every page that shows them', async () => {
    const hostile = '<script>alert(1)</script>" onmouseover="alert(2)';
    const created = await create({ template: 'json', name: hostile, url: 'https://api.example.org/x', value_path: 'a', op: 'contains', value: '<img src=x onerror=alert(3)>', cadence: '3600' });
    assert.strictEqual(created.status, 303);
    const id = indexOf(created);
    for (const url of ['/watches', `/watches/${id}`, `/watches/${id}/edit`]) {
        const res = await svc.get(url, { cookie: session });
        assert.strictEqual(res.status, 200, url);
        assert.ok(!res.text.includes('<script>alert(1)</script>'), `${url}: the name is not raw script`);
        assert.ok(!res.text.includes('<img src=x onerror'), `${url}: the value is not a raw image tag`);
        assert.match(res.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, `${url}: the name is escaped`);
    }
    assert.ok(!(await svc.get('/watches', { cookie: session })).text.includes('onmouseover="alert(2)"'));
});

t('discovery files describe the site and keep the person pages out of the sitemap', async () => {
    const robots = await svc.get('/robots.txt');
    assert.strictEqual(robots.status, 200);
    assert.match(robots.text, /Disallow: \/watches/);
    assert.match(robots.text, /Disallow: \/auth/);
    const sitemap = await svc.get('/sitemap.xml');
    assert.strictEqual(sitemap.status, 200);
    assert.match(sitemap.text, /<loc>[^<]*\/<\/loc>/);
    assert.match(sitemap.text, /how-it-works/);
    assert.ok(!/watches/.test(sitemap.text), 'no watches in the sitemap');
    const llms = await svc.get('/llms.txt');
    assert.strictEqual(llms.status, 200);
    assert.match(llms.text, /OpenVibe\.Watch/);
});

t('done', async () => { await web.close(); await svc.stop(); });

t.run();
