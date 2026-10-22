'use strict';
/**
 * The home page's reads from OpenVibe.Search (its anonymous browse: public, published, indexable documents, newest
 * first), so the page can offer ready-made watches on real things: channels on OpenVibe.Live, hosting plans on
 * OpenVibe.Host and blogs on OpenVibe.Blog.
 *
 *   createNetworkReads({ searchUrl, fetchImpl, log }) → { channels(), plans(), posts() }
 *
 * A read never throws and never holds the page long: an answer is kept 10 minutes and refreshed in the background
 * once stale, the first read waits at most READ_WAIT_MS, and a failure leaves that section out. No searchUrl (tests,
 * a local run): every read is empty and nothing is fetched.
 */
const TTL_MS = 10 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const TIMEOUT_MS = 4000;
const READ_WAIT_MS = 1200;

const clean = (s, max = 140) => String(s == null ? '' : s).replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const httpsUrl = (u) => { try { const x = new URL(u); return x.protocol === 'https:' ? x : null; } catch { return null; } };

/** A Live channel document → { name, username, url, live, category, followers }; the username is the /@handle path. */
function channelOf(doc) {
    const u = httpsUrl(doc && doc.canonical_url);
    const m = u && /^\/@([A-Za-z0-9_.-]{1,40})$/.exec(u.pathname);
    if (!m) return null;
    const f = (doc && doc.facets) || {};
    return { username: m[1], url: u.href, live: f.live === true, category: clean(f.category, 30), followers: Number.isFinite(f.followers) ? f.followers : null };
}

/** A Host plan document → { id, title, url, detail }; its id is the catalog's plan id (hpl_…). */
function planOf(doc) {
    const u = httpsUrl(doc && doc.canonical_url);
    if (!u || !/^hpl_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(doc.id || ''))) return null;
    return { id: doc.id, title: clean(doc.title), url: u.href, origin: u.origin, detail: clean(doc.summary, 160) };
}

/** A Blog post document → { title, url, blog }. */
function postOf(doc) {
    const u = httpsUrl(doc && doc.canonical_url);
    const blog = clean(((doc && doc.facets) || {}).blog, 60);
    if (!u || !clean(doc.title) || !/^[A-Za-z0-9_.-]{1,60}$/.test(blog)) return null;
    return { title: clean(doc.title), url: u.href, blog };
}

function createNetworkReads({ searchUrl = '', fetchImpl = globalThis.fetch, log = console } = {}) {
    const base = String(searchUrl || '').replace(/\/+$/, '');
    const cache = new Map();   // key → { at, value, pending }

    async function load(url, map) {
        const r = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!r.ok) throw new Error(`search answered ${r.status}`);
        const body = await r.json();
        return ((body && body.results) || []).map(map).filter(Boolean);
    }

    function read(key, query, map) {
        if (!base) return Promise.resolve([]);
        const hit = cache.get(key);
        if (hit && (Date.now() - hit.at < TTL_MS || hit.pending)) return Promise.resolve(hit.value);
        const pending = load(`${base}/api/v1/search?${query}`, map)
            .then((value) => { cache.set(key, { at: Date.now(), value, pending: null }); return value; })
            .catch((e) => {
                log.warn(`[watch] home page read ${key}: ${e.message}`);
                const value = hit ? hit.value : [];
                cache.set(key, { at: Date.now() - TTL_MS + RETRY_MS, value, pending: null });
                return value;
            });
        cache.set(key, { at: hit ? hit.at : 0, value: hit ? hit.value : [], pending });
        if (hit) return Promise.resolve(hit.value);
        return Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve([]), READ_WAIT_MS).unref())]);
    }

    return {
        channels: () => read('channels', 'owner=live&type=channel&limit=12', channelOf),
        plans: () => read('plans', 'owner=host&type=plan&limit=3', planOf),
        posts: () => read('posts', 'owner=blog&type=post&limit=12', postOf),
    };
}

module.exports = { createNetworkReads, channelOf, planOf, postOf };
