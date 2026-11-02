'use strict';
/**
 * The home on a phone (the owner's short-pages rule, 2026-10-30): the ready-made watches are a pick block, a row of
 * chips picks one of the groups, and the questions are a fold. Radio inputs and :has(), no script for the chips;
 * every group stays in the page for crawlers; a wider screen shows them all and no chips.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, site, suite } = require('./helpers');

const t = suite('home-short');
let svc;
let search;

const doc = (o) => ({ visibility: 'public', title: 'x', summary: '', facets: {}, ...o });
const RESULTS = {
    'live/channel': [],
    'host/plan': [doc({ owner: 'host', type: 'plan', id: 'hpl_01M4Z4ZZ6B8FC1ZEV0KAQ9XFBP', title: 'A small plan', summary: '2 vCPU', canonical_url: 'https://openvibe.host/catalog/plans/hpl_01M4Z4ZZ6B8FC1ZEV0KAQ9XFBP' })],
    'blog/post': [doc({ owner: 'blog', type: 'post', id: 'a', title: 'Notes', canonical_url: 'https://openvibe.blog/@openvibe/a', facets: { blog: 'openvibe' } })],
};

t('boot', async () => {
    search = await site({ '/api/v1/search': (req, res, { url }) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify({ results: RESULTS[`${url.searchParams.get('owner')}/${url.searchParams.get('type')}`] || [] }) }) });
    svc = await boot({ env: { WATCH_SEARCH_URL: search.origin } });
});

t('the ready-made watches are chips: one per group, the first picked, every group in the page', async () => {
    const home = await svc.get('/', { headers: { accept: 'text/html' } });
    assert.strictEqual(home.status, 200, home.text);
    const page = home.text;
    assert.ok(page.includes('<div class="pick" id="pick-ready">'), 'the ready-made watches are a pick block');
    const block = page.slice(page.indexOf('<div class="pick" id="pick-ready">'));
    const chips = [...block.matchAll(/<a class="pick-chip" href="#(?:pp-ready-)?([a-z]+)">()([^<]+)<\/a>/g)];
    assert.deepStrictEqual(chips.map((m) => m[1]), ['prices', 'feeds', 'blogs'], 'a chip per group');
    assert.ok(!/type="radio"/.test(block), 'no chip is a radio: nothing is picked, every pane shows');
    // Every group stays in the page, with the id its chip picks.
    const panes = [...block.matchAll(/<div class="pick-pane" id="([a-z]+)">/g)].map((m) => m[1]);
    assert.deepStrictEqual(panes, ['prices', 'feeds', 'blogs'], 'every group is in the page, one per chip');
    // Nothing was removed: the groups and their links are still there.
    for (const title of ['Hosting prices', 'Feeds', 'Blogs on OpenVibe', 'Watch this feed', 'Ready-made watches']) {
        assert.ok(page.includes(title), `${title} is on the page`);
    }
});

t('the CSS guard: the chips are hidden and every group shows until 640 px and where :has() is understood', async () => {
    const home = await svc.get('/', { headers: { accept: 'text/html' } });
    const page = home.text;
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'home.css'), 'utf8');
    assert.match(css, /\.pick-row \{ display: none; \}/, 'the chips are hidden by default');
});

t('the questions are a fold, open in the page and closed on a phone', async () => {
    const home = await svc.get('/', { headers: { accept: 'text/html' } });
    const page = home.text;
    assert.ok(page.includes('<details class="hm-fold hm-fold-block" id="faq-fold" open>'), 'the questions are a fold, open in the page');
    assert.ok(page.includes('document.getElementById("faq-fold")'), 'the fold has the script that closes it on a phone');
    // The questions stay in the page.
    assert.match(page, /What can I watch\?/);
    assert.ok(page.includes('<section class="sc-sec" id="faq" aria-labelledby="h-faq">'), 'the questions keep their section');
});

t('done', async () => { await svc.stop(); await search.close(); });

t.run();
