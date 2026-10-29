'use strict';
// The Markdown twins of this site's public pages (openvibe-shared/agent-layer).
//
// A twin is the page's own render, signed out: the request that drives it carries no session, so every
// page renders exactly as it does for a visitor who is not signed in - the same router, the same builders
// and the same data. A page behind a person's own token (a watch, a review, an editor) has no twin.
const PATHS = new Set(['/', '/how-it-works', '/updates']);

/** A response the page code can write to; the first body written is the twin's HTML. */
function mockRes() {
    return {
        statusCode: 200, headers: {}, headersSent: false, locals: {}, finished: false,
        setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
        getHeader(k) { return this.headers[String(k).toLowerCase()]; },
        set(k, v) { return typeof v === 'function' ? v.call(this) : this.setHeader(k, v); },
        status(code) { this.statusCode = code; return this; },
        type(t) { this.setHeader('content-type', t); return this; },
        redirect(code, url) { this.statusCode = code; this.headers.location = url; this.finished = true; return this; },
        json(body) { this.body = body; this.finished = true; return this; },
        send(body) { this.body = body; this.finished = true; return this; },
        end(body) { if (body) this.body = body; this.finished = true; return this; },
        sendStatus(code) { this.statusCode = code; this.finished = true; return this; },
        append(k, v) { this.setHeader(k, v); return this; },
        write(chunk) { this.body = (this.body || '') + chunk; return true; },
        vary() { return this; },
        location(url) { this.setHeader('location', url); return this; },
        format(map) { return this; },
        cookie() { return this; },
        clearCookie() { return this; },
        attachment() { return this; },
        links() { return this; },
        get(name) { return this.getHeader(name); },
        render() { return this; },
        on() { return this; }, once() { return this; }, emit() { return false; },
    };
}

/** A request without a session, so the page renders signed out. */
function mockReq(path, query) {
    const search = String(query || '');
    const url = path + (search ? `?${search}` : '');
    return {
        method: 'GET', url, originalUrl: url, path, baseUrl: '', params: {},
        query: Object.fromEntries(new URLSearchParams(search)),
        headers: { host: 'localhost', accept: 'text/html' }, secure: false, protocol: 'http',
        hostname: 'localhost', socket: {}, cookies: {}, body: {},
        get(name) { const v = this.headers[String(name).toLowerCase()]; return v === undefined ? undefined : v; },
        header(name) { return this.get(name); },
    };
}

/** Run the site's own page router for one path and keep the HTML it wrote. */
function renderWithRouter(router, path, query) {
    return new Promise((resolve) => {
        const res = mockRes();
        const keep = (body) => { resolve(typeof body === 'string' ? body : null); return res; };
        res.send = keep; res.end = keep; res.json = keep;
        try {
            router.handle(mockReq(path, query), res, () => resolve(null));
        } catch (err) {
            resolve(null);
        }
    });
}

function createAgentPages({ router }) {
    async function renderPublicPage(path) {
        const p = String(path || '/').replace(/\/+$/, '') || '/';
        if (!PATHS.has(p)) return null;
        const html = await renderWithRouter(router, p, '');
        return html ? { html, title: null, updated: null } : null;
    }
    return { renderPublicPage };
}

module.exports = { createAgentPages, PATHS };
