'use strict';
/**
 * The home page's data sections (server/http/pages.js, server/http/network-reads.js): channels on OpenVibe.Live and
 * ready-made watches read from OpenVibe.Search (a stub here), each opening the new-watch form filled in; a section with
 * nothing to show is left out; the questions and their FAQPage JSON-LD match; the API sample's body is one the API
 * accepts.
 */
const assert = require('assert');
const { boot, site, suite, userToken } = require('./helpers');
const { channelOf, planOf, postOf, createNetworkReads } = require('../server/http/network-reads');

const t = suite('home');
let svc;
let search;
let plain;
let me;

const doc = (o) => ({ visibility: 'public', title: 'x', summary: '', facets: {}, ...o });
const RESULTS = {
    'live/channel': [
        doc({ owner: 'live', type: 'channel', id: '1', title: 'quiet (@quiet)', canonical_url: 'https://openvibe.live/@quiet', facets: { live: false, category: 'gaming', followers: 3 } }),
        doc({ owner: 'live', type: 'channel', id: '2', title: 'goosely (@goosely)', canonical_url: 'https://openvibe.live/@goosely', facets: { live: true, category: 'irl', followers: 20 } }),
        doc({ owner: 'live', type: 'channel', id: '3', title: 'bad', canonical_url: 'javascript:alert(1)' }),
    ],
    'host/plan': [doc({ owner: 'host', type: 'plan', id: 'hpl_01M4Z4ZZ6B8FC1ZEV0KAQ9XFBP', title: 'OVHcloud VPS-1 2026: $7.60 a month', summary: '4 vCPU · 8 GB RAM', canonical_url: 'https://openvibe.host/catalog/plans/hpl_01M4Z4ZZ6B8FC1ZEV0KAQ9XFBP' })],
    'blog/post': [
        doc({ owner: 'blog', type: 'post', id: 'a', title: 'Patch notes (Oct 22)', canonical_url: 'https://openvibe.blog/@openvibe/a', facets: { blog: 'openvibe' } }),
        doc({ owner: 'blog', type: 'post', id: 'b', title: 'Older notes', canonical_url: 'https://openvibe.blog/@openvibe/b', facets: { blog: 'openvibe' } }),
    ],
};

t('boot', async () => {
    search = await site({ '/api/v1/search': (req, res, { url }) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify({ results: RESULTS[`${url.searchParams.get('owner')}/${url.searchParams.get('type')}`] || [] }) }) });
    svc = await boot({ env: { WATCH_SEARCH_URL: search.origin } });
    plain = await boot();
    me = svc.network.addUser('ada');
});

t('the mappers keep only https documents of the right shape', async () => {
    assert.deepStrictEqual(channelOf(RESULTS['live/channel'][1]), { username: 'goosely', url: 'https://openvibe.live/@goosely', live: true, category: 'irl', followers: 20 });
    assert.strictEqual(channelOf(RESULTS['live/channel'][2]), null);
    assert.strictEqual(channelOf(doc({ canonical_url: 'https://openvibe.live/clips/1' })), null);
    assert.strictEqual(planOf(doc({ id: 'nope', canonical_url: 'https://openvibe.host/x' })), null);
    assert.strictEqual(planOf(RESULTS['host/plan'][0]).origin, 'https://openvibe.host');
    assert.strictEqual(postOf(doc({ title: 'x', canonical_url: 'https://openvibe.blog/x', facets: { blog: '<b>' } })), null);
    const off = createNetworkReads({ searchUrl: '', fetchImpl: () => { throw new Error('no fetch without a URL'); } });
    assert.deepStrictEqual(await off.channels(), []);
    const down = createNetworkReads({ searchUrl: 'https://search.example', fetchImpl: async () => ({ ok: false, status: 503 }), log: { warn() {} } });
    assert.deepStrictEqual(await down.plans(), []);
});

t('channels, live first, each with a "go live" watch filled in for it', async () => {
    const home = await svc.get('/', { headers: { accept: 'text/html' } });
    assert.strictEqual(home.status, 200);
    const live = (/<section class="sc-sec" aria-labelledby="h-live">[\s\S]*?<\/section>/.exec(home.text) || [''])[0];
    const names = [...live.matchAll(/<b><a href="https:\/\/openvibe\.live\/@(\w+)">/g)].map((m) => m[1]);
    assert.deepStrictEqual(names, ['goosely', 'quiet']);
    assert.match(live, /<span class="hm-live">Live now<\/span>/);
    assert.match(live, /irl · 20 followers/);
    assert.match(live, /href="\/watches\/new\?template=event&amp;event=live\.stream\.started&amp;event_filter=goosely&amp;name=%40goosely\+goes\+live"/);
    assert.ok(!live.includes('javascript:'));
});

t('ready-made watches: a Host plan\'s price, feeds, and a blog\'s new posts', async () => {
    const home = await svc.get('/', { headers: { accept: 'text/html' } });
    const ready = (/<section class="sc-sec" aria-labelledby="h-ready">[\s\S]*?<\/section>/.exec(home.text) || [''])[0];
    assert.match(ready, /template=json&amp;url=https%3A%2F%2Fopenvibe\.host%2Fapi%2Fv1%2Fcatalog%2Fplans%2Fhpl_01M4Z4ZZ6B8FC1ZEV0KAQ9XFBP&amp;value_path=plan\.price_monthly&amp;op=changed/);
    assert.match(ready, /template=feed&amp;url=https%3A%2F%2Fnodejs\.org%2Fen%2Ffeed%2Freleases\.xml/);
    assert.strictEqual((ready.match(/New posts on @openvibe/g) || []).length, 1, 'one card per blog, with its latest post');
    assert.match(ready, /Latest: Patch notes \(Oct 22\)/);
});

t('the form a ready-made link opens is filled in, the channel included', async () => {
    const r = await svc.get('/watches/new?template=event&event=live.stream.started&event_filter=goosely&name=%40goosely+goes+live', { as: me });
    assert.strictEqual(r.status, 200);
    assert.match(r.text, /name="event_filter" value="goosely"/);
    assert.match(r.text, /value="@goosely goes live"/);
    const bad = await svc.get(`/watches/new?template=event&event_filter=${encodeURIComponent('a\u0001b')}`, { as: me });
    assert.match(bad.text, /name="event_filter" value=""/);
});

t('without OpenVibe.Search the Search sections are left out; the feeds and questions stay', async () => {
    const home = await plain.get('/', { headers: { accept: 'text/html' } });
    assert.strictEqual(home.status, 200);
    assert.ok(!home.text.includes('aria-labelledby="h-live"'));
    assert.ok(!home.text.includes('Hosting prices'));
    assert.match(home.text, /New Node\.js releases/);
    const ld = [...home.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
    const faq = (/<section class="sc-sec" id="faq"[\s\S]*?<\/section>/.exec(home.text) || [''])[0];
    const shown = [...faq.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1].replace(/&#39;/g, "'"));
    assert.ok(shown.length >= 6);
    assert.deepStrictEqual(ld.find((x) => x['@type'] === 'FAQPage').mainEntity.map((q) => q.name), shown);
    assert.ok(!ld.some((x) => x['@type'] === 'ItemList'), 'no channel list without channels');
    assert.strictEqual((home.text.match(/<h1[ >]/g) || []).length, 1);
    assert.match(home.text, /<link rel="stylesheet" href="\/css\/home\.css\?v=[0-9a-f]+">/);
});

t('the API sample\'s body is one the API accepts', async () => {
    const r = await svc.get('/api/v1/watches', {
        bearer: userToken(me.subject),
        json: { name: 'Node.js releases', source: { kind: 'feed', url: 'https://nodejs.org/en/feed/releases.xml' }, cadence: { every_sec: 3600 }, extraction: { kind: 'json', value_path: 'latest' }, condition: { op: 'changed' }, action: [{ kind: 'notification' }] },
    });
    assert.strictEqual(r.status, 201, r.text);
});

t('done', async () => { await search.close(); await svc.stop(); await plain.stop(); });

t.run();
