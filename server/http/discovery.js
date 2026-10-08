'use strict';
/**
 * Crawl artifacts for openvibe.watch: robots.txt, sitemap.xml, llms.txt and llms-full.txt, plus the
 * home page's JSON-LD, all built with openvibe-shared/seo.
 *
 * The site's own two public pages — the home page and how it checks — are for crawlers. A person's
 * watches and their sign-in are not: /watches and /auth are disallowed, and the sitemap lists only
 * the two pages that say what Watch is.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const seo = require('openvibe-shared/seo');
const cache = require('openvibe-shared/cache-policy');

const SITE_NAME = 'OpenVibe.Watch';
const DESCRIPTION = 'OpenVibe.Watch — get told when a page, a feed or an API changes. Define what to watch and the condition that fires; Watch checks each source on the cadence you pick and records every check.';
const DISALLOW = ['/auth/', '/watches'];

const PAGE_TEXT = {
    '/': ['OpenVibe.Watch home', 'Define a watch over a page, a feed or an API, choose the condition that fires, and sign in to see what each check found. Watch prefers the site\'s own ETag before it re-reads a body, and never checks more often than the cadence you choose.'],
    '/how-it-works': ['How it checks', 'The carrier order (conditional GET first, feeds and APIs before pages), the polite per-host spacing, the cadence floor, and what every check state means.'],
};

function dayOf(ts) {
    const m = String(ts == null ? '' : ts).match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
}
function siteUpdated() {
    try { return dayOf(JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'STATUS.json'), 'utf8')).updated); } catch { return null; }
}

function homeJsonLd(config) {
    const site = String(config.baseUrl).replace(/\/+$/, '');
    return [
        seo.jsonLd.website({ name: SITE_NAME, url: site, description: DESCRIPTION }),
        seo.jsonLd.softwareApp({ name: SITE_NAME, url: site, description: DESCRIPTION, category: 'UtilitiesApplication', keywords: 'openvibe, watch, monitoring, price watch, feed' }),
        seo.jsonLd.webPage({ name: SITE_NAME, url: `${site}/`, description: DESCRIPTION, siteUrl: site }),
    ];
}

const publicPages = () => [
    { path: '/', changefreq: 'weekly', priority: 1.0 },
    { path: '/how-it-works', changefreq: 'monthly', priority: 0.6 },
];

function createDiscoveryRoutes({ config }) {
    const r = express.Router();
    const site = String(config.baseUrl).replace(/\/+$/, '');
    const abs = (p) => `${site}${p}`;
    const TEXT = cache.htmlHeaders({ maxAge: 3600 });

    r.get('/robots.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', TEXT).send(
            '# openvibe.watch: the two pages that say what Watch is are for crawlers. A person\'s watches and sign-in are not.\n'
            + seo.robotsTxt({ sitemaps: [abs('/sitemap.xml')], disallow: DISALLOW }));
    });

    r.get('/llms.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', TEXT).send(seo.llmsTxt({
            name: SITE_NAME,
            summary: DESCRIPTION,
            details: 'Every page is server-rendered and complete without JavaScript. A person signs in with OpenVibe.Network to define and manage their own watches; nobody else can see them.',
            sections: [
                { title: 'Start here', links: [
                    { title: 'OpenVibe.Watch', url: abs('/'), note: 'What Watch is and the four ways to start a watch.' },
                    { title: 'How it checks', url: abs('/how-it-works'), note: 'The carrier order, the cadence floor and what each state means.' },
                ] },
                { title: 'For machines', links: [
                    { title: 'Sitemap', url: abs('/sitemap.xml') },
                    { title: 'The watch API (for services)', url: abs('/how-it-works'), note: 'Bearer tokens, one capability per route; /api/v1/* stays loopback-only.' },
                    { title: 'Release metadata (JSON)', url: abs('/release.json') },
                ] },
            ],
        }));
    });

    r.get('/llms-full.txt', (_req, res) => {
        const pages = publicPages().map((p) => ({ url: p.path, title: PAGE_TEXT[p.path][0], text: PAGE_TEXT[p.path][1] }));
        res.type('text/plain').set('Cache-Control', TEXT).send(seo.llmsFull({
            site: SITE_NAME,
            summary: 'Every public page of OpenVibe.Watch, one paragraph each.',
            base: site,
            maxBytes: 64 * 1024,
            sections: [{ title: 'Pages', pages }],
        }));
    });

    r.get('/sitemap.xml', (_req, res) => {
        const lastmod = siteUpdated();
        const urls = publicPages().map((e) => ({ loc: abs(e.path), ...(lastmod ? { lastmod } : {}), changefreq: e.changefreq, priority: e.priority }));
        res.type('application/xml').set('Cache-Control', TEXT).send(seo.sitemapXml(urls));
    });

    return r;
}

module.exports = { createDiscoveryRoutes, homeJsonLd, publicPages, DESCRIPTION, SITE_NAME, DISALLOW, PAGE_TEXT };
