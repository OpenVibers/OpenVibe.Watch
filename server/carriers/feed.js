'use strict';
/**
 * The feed carrier: RSS 2.0, RSS 1.0 (RDF) and Atom 1.0, parsed with fast-xml-parser (the reader is
 * OpenVibe.Sources/server/adapters/feed.js, which is where feeds are read for the network).
 *
 * The feed's own order is kept, and `latest` is its first entry — a watch over "the latest release"
 * reads `latest.title`, `latest.link` or `latest.published_at` through extraction.value_path, or
 * maps several values at once with extraction.fields. An entry the feed gave no identity for is
 * skipped: it is never given a made-up identity.
 *
 * Fetching is conditional (see carriers/http.js): ETag/Last-Modified first, `not_modified` and
 * `no_change` cost no observation.
 */
const { parseXml, toText, toIsoDate, canonicalUrl, toId, asArray, pick, decodeBody, ParseError } = require('../util');
const { at } = require('../extract');
const { conditionalGet, onlyChange, ACCEPT } = require('./http');

function atomLink(entry, base) {
    const links = asArray(entry.link);
    const alt = links.find(l => typeof l === 'object' && (!l['@_rel'] || l['@_rel'] === 'alternate') && l['@_href'])
        || links.find(l => typeof l === 'object' && l['@_href'])
        || links.find(l => typeof l === 'string');
    if (!alt) return null;
    return canonicalUrl(typeof alt === 'string' ? alt : alt['@_href'], base);
}

function namesOf(list) {
    return asArray(list).map((a) => {
        if (a == null) return null;
        if (typeof a === 'object') return toText(a.name ?? a['#text'] ?? a.__cdata, 200);
        return toText(a, 200);
    }).filter(Boolean).slice(0, 20);
}

function termsOf(list) {
    return asArray(list).map((c) => {
        if (c == null) return null;
        if (typeof c === 'object') return toText(c['@_term'] ?? c['#text'] ?? c.__cdata, 100);
        return toText(c, 100);
    }).filter(Boolean).slice(0, 30);
}

function rssItem(it, base, summaryMax) {
    const guidNode = Array.isArray(it.guid) ? it.guid[0] : it.guid;
    const guid = toId(guidNode);
    const link = canonicalUrl(pick(it, 'link'), base);
    const guidIsPermalink = !(guidNode && typeof guidNode === 'object' && guidNode['@_isPermaLink'] === 'false');
    const url = link || (guid && guidIsPermalink ? canonicalUrl(guid) : null);
    const identity = guid || url;
    if (!identity) return null;
    const enclosure = asArray(it.enclosure).find(e => e && typeof e === 'object' && e['@_url']);
    return {
        identity,
        kind: 'entry',
        title: toText(pick(it, 'title'), 500),
        link: url,
        summary: toText(pick(it, 'description', 'content:encoded'), summaryMax),
        authors: namesOf(it['dc:creator'] ?? it.author),
        published_at: toIsoDate(pick(it, 'pubDate', 'dc:date')),
        updated_at: toIsoDate(pick(it, 'atom:updated', 'dc:modified')),
        categories: termsOf(it.category ?? it['dc:subject']),
        enclosure: enclosure ? { url: canonicalUrl(enclosure['@_url'], base), type: toId(enclosure['@_type'], 100) } : null,
    };
}

function atomEntry(e, base, summaryMax) {
    const id = toId(pick(e, 'id'));
    const url = atomLink(e, base);
    const identity = id || url;
    if (!identity) return null;
    return {
        identity,
        kind: 'entry',
        title: toText(pick(e, 'title'), 500),
        link: url,
        summary: toText(pick(e, 'summary', 'content'), summaryMax),
        authors: namesOf(e.author),
        published_at: toIsoDate(pick(e, 'published', 'issued')),
        updated_at: toIsoDate(pick(e, 'updated', 'modified')),
        categories: termsOf(e.category),
        enclosure: null,
    };
}

/** parseFeed(text, baseUrl, { summaryMax, maxItems }) → { format, title, link, items, skipped }. */
function parseFeed(text, url, { summaryMax = 1000, maxItems = 500 } = {}) {
    const doc = parseXml(text);
    let raw = [];
    let meta = {};
    let make;
    if (doc.rss && doc.rss.channel) {
        const ch = Array.isArray(doc.rss.channel) ? doc.rss.channel[0] : doc.rss.channel;
        raw = asArray(ch.item);
        meta = { format: 'rss2', title: toText(pick(ch, 'title'), 300), link: canonicalUrl(pick(ch, 'link'), url) };
        make = (it) => rssItem(it, url, summaryMax);
    } else if (doc['rdf:RDF']) {
        const rdf = doc['rdf:RDF'];
        raw = asArray(rdf.item);
        const ch = Array.isArray(rdf.channel) ? rdf.channel[0] : rdf.channel;
        meta = { format: 'rss1', title: ch ? toText(pick(ch, 'title'), 300) : null, link: null };
        make = (it) => rssItem({ ...it, guid: it['@_rdf:about'] ? { '#text': it['@_rdf:about'] } : undefined }, url, summaryMax);
    } else if (doc.feed) {
        const feed = doc.feed;
        raw = asArray(feed.entry);
        meta = { format: 'atom', title: toText(pick(feed, 'title'), 300), link: atomLink(feed, url) };
        make = (e) => atomEntry(e, url, summaryMax);
    } else {
        throw new ParseError('not an RSS or Atom document');
    }
    const items = [];
    let skipped = 0;
    const seen = new Set();
    for (const r of raw) {
        if (items.length >= maxItems) { skipped++; continue; }
        const it = r && typeof r === 'object' ? make(r) : null;
        if (!it || seen.has(it.identity)) { skipped++; continue; }
        seen.add(it.identity);
        items.push(it);
    }
    return { ...meta, items, skipped };
}

function createFeedCarrier({ fetcher, config }) {
    return {
        name: 'feed',
        run: async ({ watch, state }) => {
            const out = await conditionalGet({
                source: watch.source, state, fetcher, secrets: config.secrets, accept: ACCEPT.feed,
                onlyChangeNeeded: onlyChange(watch),
            });
            if (out.state !== 'ok' || !out.body) return out;
            const text = decodeBody(out.body, out.content_type);
            let parsed;
            try {
                parsed = parseFeed(text, out.final_url || watch.source.url, { summaryMax: 2000 });
            } catch (err) {
                return { ...out, state: 'parse_error', error_code: err.code === 'parse_error' ? 'unreadable' : 'carrier_error', detail: String(err.message).slice(0, 500), body: null };
            }
            const items = mapFields(parsed.items, watch.source.fields);
            return {
                ...out,
                document: { format: parsed.format, title: parsed.title, link: parsed.link, items, latest: items[0] || null, count: items.length },
            };
        },
    };
}

/** source.fields: { name: path } over each mapped record; a path that matches nothing is null. */
function mapFields(items, fields) {
    const names = Object.keys(fields || {});
    if (!names.length) return items;
    return items.map((item) => {
        const out = {};
        for (const name of names) {
            const v = at(item, fields[name]);
            out[name] = v === undefined ? null : v;
        }
        return out;
    });
}

module.exports = { createFeedCarrier, parseFeed, mapFields };
