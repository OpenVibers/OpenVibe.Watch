'use strict';
/**
 * Per-host request spacing shared by robots.txt fetches and ingestion: before any request to a
 * host, wait until max(SOURCES_HOST_MIN_INTERVAL_MS, the source's min interval, the host's robots
 * Crawl-delay) has passed since the previous request to it. Requests to one host are serialized.
 */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function createSpacer({ hostMinIntervalMs = 1000, now = () => Date.now() } = {}) {
    const hosts = new Map();        // host → { last, crawlDelayMs, chain }

    function state(host) {
        let h = hosts.get(host);
        if (!h) { h = { last: 0, crawlDelayMs: 0, chain: Promise.resolve() }; hosts.set(host, h); }
        return h;
    }

    function space(host, minMs = 0) {
        const h = state(host);
        const turn = h.chain.then(async () => {
            const gap = Math.max(hostMinIntervalMs, minMs || 0, h.crawlDelayMs);
            const wait = h.last + gap - now();
            if (wait > 0) await sleep(wait);
            h.last = now();
        });
        h.chain = turn.catch(() => {});
        return turn;
    }

    function setCrawlDelay(host, sec) {
        if (sec == null) return;
        state(host).crawlDelayMs = Math.min(sec * 1000, 3600 * 1000);
    }

    return { space, setCrawlDelay };
}

module.exports = { createSpacer };
