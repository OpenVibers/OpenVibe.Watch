'use strict';
/**
 * The public site: the home page, a person's watches, one watch, the create and edit forms, how it
 * checks and the update log, plus the crawl artifacts (server/http/discovery.js).
 *
 * Every page is server-rendered through openvibe-shared/shell and is complete without JavaScript:
 * the create and edit forms POST, pause/resume/delete/check-now are plain POST buttons, and the
 * template a form shows is chosen by the query (`/watches/new?template=price`), never by script.
 *
 * The site is the same authority as the API, in-process: it calls the watch registry directly with
 * the signed-in person's canonical subject, so exactly the API's ownership rules apply — another
 * person's watch is 404 on every page and every form, never 403. A signed-in write must come from
 * this site (same-origin), so another site cannot make a visitor act here; the session cookie is
 * SameSite=Lax as well.
 *
 * Kinds whose carrier does not exist yet (event, webhook, run, node) and the `ai` extraction are not
 * offered: the four starting points are the three pull carriers — a page, a feed, an API.
 */
const express = require('express');
const cache = require('openvibe-shared/cache-policy');
const { RegistryError } = require('../registry');
const { html, raw, table, notice, time, badge } = require('../render/html');
const { send } = require('../render/layout');
const W = require('../render/watch');
const changelog = require('../render/changelog');
const { createDiscoveryRoutes, homeJsonLd, DESCRIPTION } = require('./discovery');

/** The four starting points. Each fixes the source kind, the extraction and the condition's ops. */
const TEMPLATES = {
    page: {
        card: 'A page changes',
        cardBlurb: 'Give a URL and, if you like, the CSS selector of the part you care about. Watch tells you when its text changes.',
        title: 'Watch a page for changes',
        kind: 'http',
        kindWords: 'a web page',
        ops: ['changed'],
        extraction: 'html',
    },
    price: {
        card: 'Price drops below',
        cardBlurb: 'Read one number off a page — a CSS selector or a regular expression — and fire when it drops below (or rises above) a value.',
        title: 'Watch a price',
        kind: 'http',
        kindWords: 'a web page',
        ops: ['lt', 'lte', 'gt', 'gte'],
        defaultOp: 'lt',
        extraction: 'css',
    },
    feed: {
        card: 'New item in a feed',
        cardBlurb: 'Give an RSS or Atom feed — a GitHub releases .atom URL, a blog’s RSS — and fire when a new item appears.',
        title: 'Watch a feed for new items',
        kind: 'feed',
        kindWords: 'an RSS or Atom feed',
        ops: ['changed'],
        extraction: 'json',
        valuePath: 'latest',
    },
    json: {
        card: 'A JSON value',
        cardBlurb: 'Give a JSON API and a path to the value inside it, and fire on the condition you choose.',
        title: 'Watch a JSON value',
        kind: 'api',
        kindWords: 'a JSON API',
        ops: ['changed', 'gt', 'gte', 'lt', 'lte', 'eq', 'ne', 'contains', 'matches', 'exists', 'absent'],
        defaultOp: 'lt',
        extraction: 'json',
    },
};
const TEMPLATE_NAMES = Object.keys(TEMPLATES);
const OPS = {
    changed: 'changes', gt: 'goes above', gte: 'reaches or is more than', lt: 'drops below', lte: 'is less than or equal to',
    eq: 'equals', ne: 'is not', contains: 'contains', matches: 'matches the pattern', exists: 'is present', absent: 'is absent',
};
const NEEDS_VALUE = new Set(['gt', 'gte', 'lt', 'lte', 'eq', 'ne', 'contains', 'matches']);
const NOTIFY_ACTION = [{ kind: 'notification', category: 'service', priority: 'normal' }];
// With notifications off the watch still needs an action (the contract requires one); actions are
// step 4 of the plan and none is dispatched yet, so this records the person's intent without changing
// what happens today (see how-it-works and the note on the form).
const QUIET_ACTION = [{ kind: 'event', event_type: 'watch.watch.triggered' }];

const INT = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };

/** Same-site writes only: another site must not make a signed-in visitor act here. */
function sameOrigin(req, baseUrl) {
    const site = String(req.get('sec-fetch-site') || '');
    if (site) return site === 'same-origin';
    const origin = req.get('origin');
    if (!origin) return false;
    if (origin === `${req.protocol}://${req.get('host')}`) return true;
    try { return origin === new URL(baseUrl).origin; } catch { return false; }
}

function createPageRoutes(ctx) {
    const { config, db, registry, check, observations, sessions, log = console } = ctx;
    const r = express.Router();
    const formBody = express.urlencoded({ extended: false, limit: '32kb' });

    const viewer = (req) => req.viewer || { kind: 'anonymous' };
    const signedIn = (req) => viewer(req).kind === 'user' && Boolean(viewer(req).subject);
    const principalOf = (req) => ({ sub: viewer(req).subject, subject: null });
    const subjectOf = (req) => viewer(req).subject;
    const page = (req, res, o, status = 200) => send(res, status, { viewer: viewer(req), config, path: req.originalUrl, ...o });
    const fail = (req, res, status, title, body) => page(req, res, { title, body }, status);

    // ── The form model ───────────────────────────────────────────────────────────────────────

    /** The values a form starts from: a template's defaults, or an existing watch (the edit form). */
    function blankFields(template) {
        const t = TEMPLATES[template] || TEMPLATES.page;
        return {
            template, name: '', url: '', kind: t.kind,
            extraction: t.extraction, selector: '', value_path: t.valuePath || '',
            op: t.defaultOp || t.ops[0], value: '', for_sec: '',
            cadence: '3600', notify: 'on',
        };
    }

    /**
     * The fields a submitted form means. A checkbox posts nothing when it is unchecked, so `notify`
     * is read straight from the body — never inherited from the form's own default.
     */
    function postedFields(template, body) {
        const fields = { ...blankFields(template), ...(body || {}) };
        fields.notify = body && body.notify === 'on' ? 'on' : '';
        return fields;
    }

    /** Which template an existing watch most resembles, so the edit form shows its fields. */
    function templateOf(watch) {
        const kind = watch.source && watch.source.kind;
        if (kind === 'feed') return 'feed';
        if (kind === 'api') return 'json';
        const e = watch.extraction || {};
        const op = (watch.condition || {}).op;
        if (e.kind === 'regex' || ['lt', 'lte', 'gt', 'gte'].includes(op)) return 'price';
        return 'page';
    }

    function fieldsOfWatch(watch) {
        const t = templateOf(watch);
        const e = watch.extraction || {};
        return {
            template: t,
            name: watch.name || '',
            url: (watch.source && watch.source.url) || '',
            kind: (watch.source && watch.source.kind) || TEMPLATES[t].kind,
            extraction: e.kind === 'regex' ? 'regex' : (e.kind || TEMPLATES[t].extraction),
            selector: e.selector || '',
            value_path: e.value_path || '',
            op: (watch.condition || {}).op || TEMPLATES[t].ops[0],
            value: (watch.condition && watch.condition.value != null) ? String(watch.condition.value) : '',
            for_sec: (watch.condition && Number.isInteger(watch.condition.for_sec)) ? String(watch.condition.for_sec) : '',
            cadence: String((watch.cadence && watch.cadence.every_sec) || 3600),
            notify: notifyOn(watch.action) ? 'on' : '',
        };
    }
    const notifyOn = (action) => Array.isArray(action) && action.some((a) => a && a.kind === 'notification');

    /** The condition a form says, checked against the template's ops. Returns { condition } or { error }. */
    function conditionFrom(fields, template) {
        const t = TEMPLATES[template];
        const op = String(fields.op || t.defaultOp || t.ops[0]);
        if (!t.ops.includes(op)) return { error: `The condition must be one of: ${t.ops.join(', ')}.` };
        const condition = { op };
        if (NEEDS_VALUE.has(op)) {
            const raw = String(fields.value == null ? '' : fields.value).trim();
            if (!raw) return { error: `“${OPS[op]}” needs a value to compare against.`, field: 'value' };
            // A plain decimal is stored as a number; anything else as the text the person typed.
            condition.value = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
        }
        if (template === 'price' || template === 'json') {
            const secs = String(fields.for_sec == null ? '' : fields.for_sec).trim();
            if (secs) {
                const n = INT(secs, NaN);
                if (!Number.isFinite(n) || n < 0) return { error: '“Hold for” must be a whole number of seconds, or blank.', field: 'for_sec' };
                if (n > 0) condition.for_sec = n;
            }
        }
        return { condition };
    }

    /**
     * The watch request body a submitted form means — the same shape a caller would POST to
     * /api/v1/watches. Every rule the registry enforces still applies; this only assembles the JSON.
     * Returns { body } or { errors: { field: message } }.
     */
    function buildBody(fields, template) {
        const t = TEMPLATES[template];
        const errors = {};
        const url = String(fields.url == null ? '' : fields.url).trim();
        if (!url) errors.url = 'Give the address of the page, feed or API to watch.';
        else if (!/^https?:\/\/\S+$/i.test(url)) errors.url = 'The address must start with http:// or https://.';
        else { try { new URL(url); } catch { errors.url = 'That is not a valid address.'; } }

        const cadenceSec = INT(fields.cadence, 3600);
        if (cadenceSec < W.MIN_CADENCE_SEC) errors.cadence = 'The shortest cadence here is 15 minutes.';
        if (cadenceSec > 2592000) errors.cadence = 'The longest cadence is 30 days.';

        const name = String(fields.name == null ? '' : fields.name).trim();
        if (name.length > 120) errors.name = 'A name can be at most 120 characters.';

        const source = { kind: t.kind, url, format: null };
        let extraction;
        if (template === 'page') {
            extraction = { kind: 'html', selector: String(fields.selector || '').trim() || null };
        } else if (template === 'price') {
            const how = fields.extraction === 'regex' ? 'regex' : 'css';
            const selector = String(fields.selector || '').trim();
            if (!selector) errors.selector = how === 'regex' ? 'Give the regular expression that reads the price.' : 'Give the CSS selector of the element that holds the price.';
            extraction = { kind: how, selector };
        } else if (template === 'feed') {
            extraction = { kind: 'json', value_path: 'latest' };
        } else {
            extraction = { kind: 'json', value_path: String(fields.value_path || '').trim() || null };
        }

        const c = conditionFrom(fields, template);
        if (c.error) errors[c.field || 'op'] = c.error;

        if (Object.keys(errors).length) return { errors };
        const body = {
            source,
            cadence: { every_sec: cadenceSec, jitter_sec: 0 },
            extraction,
            condition: c.condition,
            action: fields.notify === 'on' ? NOTIFY_ACTION : QUIET_ACTION,
        };
        if (name) body.name = name;   // omitted, not undefined: the registry names it from the source
        return { body };
    }

    /**
     * Map a registry error to the form field it names, so the message can sit next to the input.
     * Only a field this form renders is returned; anything else (a oneOf failure that names no
     * single field) is answered as null and shown as a form-level notice instead of being lost.
     */
    function registryField(message) {
        const m = String(message);
        const named = m.match(/\/(?:source|extraction|condition|cadence|name|action)\/(url|selector|value_path|value|for_sec|every_sec)\b/);
        if (named) return named[1] === 'every_sec' ? 'cadence' : named[1];
        if (/\/name\b/.test(m)) return 'name';
        if (/\/condition\b/.test(m)) return 'op';
        if (/\/cadence\b/.test(m)) return 'cadence';
        if (/\/extraction\b/.test(m)) return 'selector';
        if (/\burl\b/i.test(m)) return 'url';
        return null;
    }

    // ── The form, rendered ───────────────────────────────────────────────────────────────────

    const idOf = (f) => `f-${f}`;
    function field(label, control, { name, error, hint = null, cls = '' } = {}) {
        const id = idOf(name);
        return html`<p class="field ${cls}${error ? ' has-error' : ''}">
<label for="${id}">${label}</label>
${control}
${hint ? html`<span class="hint muted small" id="${id}-hint">${hint}</span>` : ''}
${error ? html`<span class="field-error" role="alert">${error}</span>` : ''}
</p>`;
    }

    function checkbox(label, { name, checked, hint = null, error = null }) {
        const id = idOf(name);
        return html`<p class="field checkbox${error ? ' has-error' : ''}">
<label for="${id}"><input type="checkbox" id="${id}" name="${name}" value="on"${checked ? raw(' checked') : ''}> ${label}</label>
${hint ? html`<span class="hint muted small">${hint}</span>` : ''}
${error ? html`<span class="field-error" role="alert">${error}</span>` : ''}
</p>`;
    }

    const select = (name, options, value) => html`<select id="${idOf(name)}" name="${name}">${options.map((o) => html`<option value="${o.value}"${String(o.value) === String(value) ? raw(' selected') : ''}>${o.label}</option>`)}</select>`;

    const CADENCE_CHOICES = W.CADENCES.map((c) => ({ value: c.sec, label: c.label }));

    /**
     * The one form for all four kinds: the template picks the fieldset (server-side), so the page
     * needs no script. action is where it POSTs; submit is the button's words.
     */
    function watchForm({ template, fields, errors, action, submit }) {
        const t = TEMPLATES[template];
        const cadence = select('cadence', CADENCE_CHOICES, fields.cadence);
        const opChoices = t.ops.map((op) => ({ value: op, label: OPS[op] }));
        const opControl = t.ops.length > 1
            ? select('op', opChoices, fields.op)
            : html`<input type="hidden" name="op" value="${t.ops[0]}"><span class="fixed">fires when it ${OPS[t.ops[0]]}</span>`;

        const needsValue = t.ops.some((op) => NEEDS_VALUE.has(op));
        const conditionBlock = html`<fieldset><legend>When should it fire?</legend>
${field('Condition', opControl, { name: 'op', error: errors.op })}
${needsValue ? field('Value', html`<input type="text" id="${idOf('value')}" name="value" value="${fields.value}" maxlength="200">`, { name: 'value', error: errors.value, hint: 'The value to compare the reading against. Numbers are compared as numbers.' }) : ''}
${(template === 'price' || template === 'json') ? field('Hold for (seconds)', html`<input type="number" id="${idOf('for_sec')}" name="for_sec" value="${fields.for_sec}" min="0" max="2592000" inputmode="numeric">`, { name: 'for_sec', error: errors.for_sec, hint: 'Blank fires as soon as the condition is met; a number makes it wait that long and stay true.' }) : ''}
</fieldset>`;

        let extractionBlock;
        if (template === 'page') {
            extractionBlock = html`<fieldset><legend>What should it read?</legend>
${field('CSS selector', html`<input type="text" id="${idOf('selector')}" name="selector" value="${fields.selector}" maxlength="300" placeholder="e.g. .price (blank: the whole page text)">`, { name: 'selector', error: errors.selector, hint: 'The text of the first element matching this selector. Leave it blank to read the whole page text.' })}
</fieldset>`;
        } else if (template === 'price') {
            extractionBlock = html`<fieldset><legend>How should it read the price?</legend>
${field('Read it with', select('extraction', [{ value: 'css', label: 'a CSS selector' }, { value: 'regex', label: 'a regular expression' }], fields.extraction), { name: 'extraction', error: errors.extraction, hint: 'A CSS selector reads one element; a regular expression reads the first match (its first group when it has one).' })}
${field('Selector or pattern', html`<input type="text" id="${idOf('selector')}" name="selector" value="${fields.selector}" maxlength="300" placeholder=".price  or  (\\d+\\.\\d+) EUR">`, { name: 'selector', error: errors.selector })}
</fieldset>`;
        } else if (template === 'feed') {
            extractionBlock = html`<fieldset><legend>What should it read?</legend>
<p class="muted small">Watch reads the feed’s newest item (title, link, published time — all of it). The feed is read before the page is ever fetched and only when the feed says it changed.</p>
</fieldset>`;
        } else {
            extractionBlock = html`<fieldset><legend>What should it read?</legend>
${field('Value path', html`<input type="text" id="${idOf('value_path')}" name="value_path" value="${fields.value_path}" maxlength="200" placeholder="e.g. price, data.0.value">`, { name: 'value_path', error: errors.value_path, hint: 'A dot path into the JSON — `items.0.price`. Leave blank to watch the whole body.' })}
</fieldset>`;
        }

        return html`<form class="watch-form" method="post" action="${action}">
<input type="hidden" name="template" value="${template}">
<input type="hidden" name="kind" value="${t.kind}">
<fieldset><legend>What to watch</legend>
${field('Name', html`<input type="text" id="${idOf('name')}" name="name" value="${fields.name}" maxlength="120" placeholder="e.g. Laptop price at the usual shop">`, { name: 'name', error: errors.name, hint: 'Optional. Without one, Watch names it after the address.' })}
${field('Address', html`<input type="url" id="${idOf('url')}" name="url" value="${fields.url}" maxlength="2000" required placeholder="https://…">`, { name: 'url', error: errors.url, hint: html`This is ${t.kindWords}, fetched with the site’s own ETag/Last-Modified when it gives one.` })}
</fieldset>
${extractionBlock}
${conditionBlock}
<fieldset><legend>How often, and how to tell you</legend>
${field('Cadence', cadence, { name: 'cadence', error: errors.cadence, hint: 'Watch never checks more often than this, and can wait longer when the site asks it to.' })}
${checkbox('Notify me when it fires', { name: 'notify', checked: fields.notify === 'on', hint: 'A fired condition becomes a WATCH_TRIGGERED notification through OpenVibe.Network, as today.' })}
</fieldset>
<p class="form-actions"><button class="btn primary" type="submit">${submit}</button> <a href="/watches">Cancel</a></p>
<p class="muted small">Actions are step 4 of the plan: a fired condition records its trigger and emits <code>watch.watch.triggered</code> today, and no other action is dispatched yet — turning notifications off does not silence that until actions run.</p>
</form>`;
    }

    /** The GET chooser above the form, so a kind can be picked without any JavaScript. */
    const templateChooser = (template) => html`<form class="template-chooser" method="get" action="/watches/new">
<label for="template">What kind of watch?</label>
<select id="template" name="template">${TEMPLATE_NAMES.map((n) => html`<option value="${n}"${n === template ? raw(' selected') : ''}>${TEMPLATES[n].card}</option>`)}</select>
<button class="btn" type="submit">Show those fields</button>
</form>`;

    // ── Home ────────────────────────────────────────────────────────────────────────────────

    r.get('/', async (req, res) => {
        let summary = null;
        if (signedIn(req)) {
            const rows = await db.prepare('SELECT status, COUNT(*) AS n FROM watches WHERE owner_sub = ? AND deleted_at IS NULL GROUP BY status').all(subjectOf(req));
            const counts = { active: 0, paused: 0, disabled: 0, failed: 0, total: 0 };
            for (const row of rows) { const n = Number(row.n); counts[row.status] = n; counts.total += n; }
            summary = counts;
        }
        const signedOut = signedIn(req) ? '' : html`<p><a class="btn primary" href="/auth/login?next=%2F">Sign in with OpenVibe</a> to keep watches. Reading this page needs no account.</p>`;
        page(req, res, {
            index: true,
            cache: signedIn(req) ? null : cache.htmlHeaders({ maxAge: 300 }),
            jsonLd: homeJsonLd(config),
            description: DESCRIPTION,
            body: html`<h1>OpenVibe.Watch</h1>
<p class="lede">Watch is a place to say what you want to know: give it a page, a feed or a JSON API, say which value you care about and the condition that fires, and it checks on the cadence you choose and records what every check found. It gets told, it does not guess — a failed check is recorded as a failure and an absent value stays absent.</p>
${signedOut}
<section aria-labelledby="h-start"><h2 id="h-start">Start with one of these</h2>
<ul class="cards">
${TEMPLATE_NAMES.map((n) => html`<li class="card"><h3><a href="/watches/new?template=${n}">${TEMPLATES[n].card}</a></h3><p>${TEMPLATES[n].cardBlurb}</p></li>`)}
</ul>
<p class="muted small">A watch is for a page, a feed or an API today: the kinds that arrive later (an event, a webhook, a Run check, a Node probe) and an AI reading are not offered yet, because Watch will not pretend to check something it cannot.</p></section>
<section aria-labelledby="h-check"><h2 id="h-check">How it checks</h2>
<ul class="facts">
<li><strong>The cheapest way first.</strong> If the site gave Watch an ETag or Last-Modified, the next check asks with <code>If-None-Match</code>/<code>If-Modified-Since</code> and a “not modified” answer costs no body. When only “did it change?” matters, a <code>HEAD</code> is tried while a validator is held: two headers instead of a page.</li>
<li><strong>Feeds and APIs before pages.</strong> The carrier order is binding: an event or webhook when one exists, then the etag, then a feed, then an API, and only then an expensive browser check. A watch checks the kind its source names.</li>
<li><strong>Polite per-site spacing.</strong> Two requests to one host never leave at once, and no two requests to a host are closer than the host’s minimum interval — whatever the watch says.</li>
<li><strong>Never faster than your cadence.</strong> A watch is due on the cadence you pick; a failing site is checked less often (backoff), and a site that asks Watch to wait is waited for (<code>Retry-After</code>).</li>
<li><strong>Every check is recorded.</strong> Read, no change, changed, condition met, a site error, a timeout, an unreadable answer, a wait, a skipped kind — the state is kept with the value, the time and a capped snapshot, and the watch is re-armed on every path.</li>
</ul>
<p><a href="/how-it-works">The full picture, in plain words</a>.</p></section>
${summary ? html`<section aria-labelledby="h-yours"><h2 id="h-yours">Your watches</h2>
<p>${summary.total ? html`You have <strong>${summary.total}</strong> watch${summary.total === 1 ? '' : 'es'}: ${summary.active} active, ${summary.paused} paused, ${summary.disabled} disabled, ${summary.failed} failing.` : 'You have no watches yet.'} <a href="/watches">See them</a> or <a href="/watches/new?template=page">start one</a>.</p></section>` : ''}`,
        });
    });

    // ── Your watches ────────────────────────────────────────────────────────────────────────

    const PAGE = 25;
    const beforeId = (q) => (/^wch_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(q || '')) ? String(q) : null);

    r.get('/watches', async (req, res) => {
        if (!signedIn(req)) {
            return page(req, res, {
                title: 'Your watches',
                body: html`<h1>Your watches</h1>
<p>Sign in to see and manage your watches. Each one belongs to the OpenVibe account that made it and to nobody else.</p>
<p><a class="btn primary" href="/auth/login?next=%2Fwatches">Sign in with OpenVibe</a> <a class="btn" href="/">Back home</a></p>`,
            });
        }
        const before = beforeId(req.query.before);
        const rows = await registry.all(principalOf(req), { before, limit: PAGE });
        const withLatest = await Promise.all(rows.map(async (row) => ({ row, latest: await observations.latest(row.id) })));
        const watchRows = withLatest.map(({ row, latest }) => {
            const v = registry.view(row);
            return [
                html`<a href="/watches/${row.id}">${v.name}</a>`,
                html`<code>${W.host(v.source.url)}</code>`,
                W.conditionWords(v.condition),
                html`${badge(W.statusWords(v.status), W.statusKind(v.status))}`,
                v.health.last_state
                    ? html`${W.stateWords(v.health.last_state)} <span class="muted small">${v.health.last_check_at ? time(v.health.last_check_at) : ''}</span>`
                    : html`<span class="muted">not checked yet</span>`,
                latest ? W.valueWords(latest.value, 60) : html`<span class="muted">—</span>`,
                v.health.next_due_at ? time(v.health.next_due_at) : html`<span class="muted">—</span>`,
            ];
        });
        const older = rows.length === PAGE ? `/watches?before=${rows[rows.length - 1].id}` : null;
        page(req, res, {
            title: 'Your watches', private: true,
            body: html`<h1>Your watches</h1>
<p><a class="btn primary" href="/watches/new?template=page">New watch</a></p>
${table(['Name', 'Source', 'Condition', 'Status', 'Last check', 'Last value', 'Next due'], watchRows, { empty: 'You have no watches yet. Start with one of the four kinds on the home page.' })}
<nav class="pager" aria-label="Pages">
${before ? html`<a class="btn" href="/watches">Newest first</a>` : ''}
${older ? html`<a class="btn" href="${older}">Older watches</a>` : html`<span class="muted">That is every watch here.</span>`}
</nav>`,
        });
    });

    // ── New watch ───────────────────────────────────────────────────────────────────────────

    const getTemplate = (q) => (TEMPLATE_NAMES.includes(String(q)) ? String(q) : 'page');

    r.get('/watches/new', (req, res) => {
        if (!signedIn(req)) return res.redirect(303, `/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
        const template = getTemplate(req.query.template);
        page(req, res, {
            title: `New watch: ${TEMPLATES[template].card}`, private: true,
            body: html`<h1>New watch</h1>
<p class="muted">${TEMPLATES[template].title}.</p>
${templateChooser(template)}
${watchForm({ template, fields: { ...blankFields(template), url: String(req.query.url || '') }, errors: {}, action: '/watches/new', submit: 'Create this watch' })}`,
        });
    });

    r.post('/watches/new', formBody, async (req, res) => {
        if (!signedIn(req)) return res.redirect(303, '/auth/login?next=%2Fwatches%2Fnew');
        const template = getTemplate((req.body || {}).template);
        if (!sameOrigin(req, config.baseUrl)) {
            return fail(req, res, 403, 'Cross-site request refused', html`<h1>Cross-site request refused</h1><p>Creating a watch must come from openvibe.watch itself.</p><p><a href="/watches/new?template=${template}">Back to the form</a></p>`);
        }
        const fields = postedFields(template, req.body);
        const limited = ctx.siteLimits.take('watch.write', subjectOf(req));
        if (!limited.ok) {
            res.set('Retry-After', String(limited.retryAfter));
            return fail(req, res, 429, 'Slow down', html`<h1>Slow down</h1><p>You have made a lot of watches in a short time. Try again in ${limited.retryAfter} seconds.</p>`);
        }
        const built = buildBody(fields, template);
        let errors = built.errors;
        if (!errors) {
            try {
                const row = await registry.create(built.body, principalOf(req));
                return res.redirect(303, `/watches/${row.id}`);
            } catch (err) {
                if (!(err instanceof RegistryError)) throw err;
                const field = registryField(err.message);
                errors = { [field || 'form']: err.message };
            }
        }
        page(req, res, {
            title: `New watch: ${TEMPLATES[template].card}`, private: true,
            body: html`<h1>New watch</h1>
${errors.form ? notice(errors.form, 'warn') : ''}
<p class="muted">Fix the ${Object.keys(errors).length === 1 ? 'entry' : 'entries'} marked below and create it again.</p>
${templateChooser(template)}
${watchForm({ template, fields, errors, action: '/watches/new', submit: 'Create this watch' })}`,
        }, 422);
    });

    // ── One watch ───────────────────────────────────────────────────────────────────────────

    /** The watch when it exists and belongs to the signed-in person; otherwise the 404 page. */
    async function owned(req, res) {
        if (!signedIn(req)) return null;
        const row = await registry.get(req.params.id, principalOf(req));
        return row || null;
    }
    const notFoundPage = (req, res) => fail(req, res, 404, 'Watch not found', html`<h1>Watch not found</h1>
<p>There is no watch here with that id, or it belongs to someone else. A watch is private to the account that made it.</p>
<p><a href="/watches">Your watches</a></p>`);

    const obsLimit = (q) => Math.min(Math.max(INT(q, 20), 1), 100);
    const ridBefore = (q) => (/^\d{1,18}$/.test(String(q || '')) ? Number(q) : null);

    r.get('/watches/:id', async (req, res) => {
        if (!signedIn(req)) return res.redirect(303, `/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
        const row = await owned(req, res);
        if (!row) return notFoundPage(req, res);
        const v = registry.view(row);
        const latest = await observations.latest(row.id);
        const obs = await observations.list(row.id, { before: ridBefore(req.query.obs_before), limit: obsLimit(req.query.obs_limit) });
        const runs = await check.list(row.id, { before: ridBefore(req.query.checks_before), limit: obsLimit(req.query.checks_limit) });

        const obsRows = obs.map((o) => [
            time(new Date(Number(o.observed_at)).toISOString()),
            W.valueWords(o.value, 120),
            o.changed ? badge('changed', 'info') : html`<span class="muted">no</span>`,
            o.condition_met ? badge('met', 'ok') : html`<span class="muted">no</span>`,
        ]);
        const runRows = runs.map((run) => {
            const view = check.runView(run);
            return [
                time(view.started_at),
                html`${badge(W.stateWords(view.state, view), W.stateKind(view.state))} <span class="muted small">${view.trigger}</span>`,
                view.http_status == null ? html`<span class="muted">—</span>` : String(view.http_status),
                view.detail ? html`<span class="muted small">${view.detail}</span>` : '',
                view.observations ? '1 observation' : '',
                view.triggers ? 'fired' : '',
            ];
        });

        const ran = String(req.query.ran || '');
        const actionForms = html`<div class="actions">
${v.status === 'active'
                    ? html`<form class="inline" method="post" action="/watches/${v.id}/pause"><button class="btn" type="submit">Pause</button></form>`
                    : html`<form class="inline" method="post" action="/watches/${v.id}/resume"><button class="btn" type="submit">Resume</button></form>`}
<form class="inline" method="post" action="/watches/${v.id}/check"><button class="btn" type="submit">Check now</button></form>
<a class="btn" href="/watches/${v.id}/edit">Edit</a>
<form class="inline" method="post" action="/watches/${v.id}/delete"><button class="btn danger" type="submit">Delete</button></form>
</div>`;

        const nextObs = obs.length === obsLimit(req.query.obs_limit) ? `/watches/${v.id}?obs_before=${obs[obs.length - 1].rid}` : null;
        const nextRuns = runs.length === obsLimit(req.query.checks_limit) ? `/watches/${v.id}?checks_before=${runs[runs.length - 1].rid}` : null;

        page(req, res, {
            title: v.name, private: true, crumbs: [{ label: 'Your watches', href: '/watches' }, { label: v.name }],
            body: html`<h1>${v.name}</h1>
<p class="in-words">${W.inWords(v)}</p>
${ran ? notice(html`The check ran: <strong>${W.stateWords(ran)}</strong>.`, ran === 'changed' || ran === 'condition_met' ? 'ok' : 'info') : ''}
<dl class="facts">
<dt>Status</dt><dd>${badge(W.statusWords(v.status), W.statusKind(v.status))}</dd>
<dt>Source</dt><dd><code>${v.source.kind}</code> · <code>${v.source.url || '(none)'}</code></dd>
<dt>Cadence</dt><dd>${v.cadence ? W.everyWords(v.cadence.every_sec) : 'not polled'}</dd>
<dt>Last check</dt><dd>${v.health.last_check_at ? html`${time(v.health.last_check_at)} — ${W.stateWords(v.health.last_state)}` : html`<span class="muted">not checked yet</span>`}</dd>
<dt>Next due</dt><dd>${v.health.next_due_at ? time(v.health.next_due_at) : html`<span class="muted">—</span>`}</dd>
${v.health.consecutive_failures ? html`<dt>Failing</dt><dd>${v.health.consecutive_failures} check(s) in a row</dd>` : ''}
<dt>Last value</dt><dd>${latest ? W.valueWords(latest.value, 200) : html`<span class="muted">nothing recorded yet</span>`}</dd>
</dl>
${actionForms}
<section aria-labelledby="h-obs"><h2 id="h-obs">Observation history</h2>
${table(['When', 'Value', 'Changed', 'Condition'], obsRows, { empty: 'No observations yet. Watch records one when a check reads a value.' })}
<nav class="pager">${nextObs ? html`<a class="btn" href="${nextObs}">Older observations</a>` : html`<span class="muted">That is every observation kept.</span>`}</nav></section>
<section aria-labelledby="h-runs"><h2 id="h-runs">Check runs</h2>
<p class="muted small">Every check, whatever it found. A skipped kind, a site error and a wait are recorded states, not silence.</p>
${table(['When', 'State', 'HTTP', 'Detail', 'Read', 'Fired'], runRows, { empty: 'No checks yet.' })}
<nav class="pager">${nextRuns ? html`<a class="btn" href="${nextRuns}">Older checks</a>` : html`<span class="muted">That is every check recorded.</span>`}</nav></section>
<p class="muted small">In code: <code>GET /api/v1/watches/${v.id}</code>.</p>`,
        });
    });

    // ── Pause, resume, delete, check now ────────────────────────────────────────────────────

    function crossSite(req, res, what) {
        return fail(req, res, 403, 'Cross-site request refused', html`<h1>Cross-site request refused</h1><p>${what} a watch must come from openvibe.watch itself.</p>`);
    }
    const actionLimit = (req, res, name) => {
        const limited = ctx.siteLimits.take(name, subjectOf(req));
        if (limited.ok) return true;
        res.set('Retry-After', String(limited.retryAfter));
        fail(req, res, 429, 'Slow down', html`<h1>Slow down</h1><p>You have done that a lot in a short time. Try again in ${limited.retryAfter} seconds.</p>`);
        return false;
    };

    r.post('/watches/:id/pause', formBody, async (req, res) => {
        if (!signedIn(req)) return res.redirect(303, '/auth/login?next=%2Fwatches');
        if (!sameOrigin(req, config.baseUrl)) return crossSite(req, res, 'Pausing');
        if (!actionLimit(req, res, 'watch.write')) return;
        const row = await owned(req, res);
        if (!row) return notFoundPage(req, res);
        await registry.patch(row.id, { status: 'paused' }, principalOf(req));
        return res.redirect(303, `/watches/${row.id}`);
    });

    r.post('/watches/:id/resume', formBody, async (req, res) => {
        if (!signedIn(req)) return res.redirect(303, '/auth/login?next=%2Fwatches');
        if (!sameOrigin(req, config.baseUrl)) return crossSite(req, res, 'Resuming');
        if (!actionLimit(req, res, 'watch.write')) return;
        const row = await owned(req, res);
        if (!row) return notFoundPage(req, res);
        await registry.patch(row.id, { status: 'active' }, principalOf(req));
        return res.redirect(303, `/watches/${row.id}`);
    });

    r.post('/watches/:id/delete', formBody, async (req, res) => {
        if (!signedIn(req)) return res.redirect(303, '/auth/login?next=%2Fwatches');
        if (!sameOrigin(req, config.baseUrl)) return crossSite(req, res, 'Deleting');
        if (!actionLimit(req, res, 'watch.write')) return;
        const row = await owned(req, res);
        if (!row) return notFoundPage(req, res);
        await registry.remove(row.id, principalOf(req));
        return res.redirect(303, '/watches');
    });

    r.post('/watches/:id/check', formBody, async (req, res) => {
        if (!signedIn(req)) return res.redirect(303, '/auth/login?next=%2Fwatches');
        if (!sameOrigin(req, config.baseUrl)) return crossSite(req, res, 'Checking');
        if (!actionLimit(req, res, 'watch.check.run')) return;
        const row = await owned(req, res);
        if (!row) return notFoundPage(req, res);
        const out = await check.run(row.id, { trigger: 'manual' });
        if (!out) return notFoundPage(req, res);
        // The API's 409s and 422, said in words: a second check while one runs, a watch that is not
        // active, and a kind whose carrier is a later step (which fetches nothing).
        if (out.busy) return detailNotice(req, res, row, 409, 'A check of this watch is already running. Try again in a moment.');
        if (out.disabled) return detailNotice(req, res, row, 409, `This watch is ${row.status}, so it is not checked. Resume it first.`);
        if (out.unavailable) return detailNotice(req, res, row, 422, out.unavailable.detail);
        return res.redirect(303, `/watches/${row.id}?ran=${encodeURIComponent(out.run ? out.run.state : '')}`);
    });

    /** Render the watch page with one notice, without a redirect (the API's 409s and 422). */
    async function detailNotice(req, res, row, status, text) {
        const v = registry.view(row);
        return page(req, res, {
            title: v.name, private: true, crumbs: [{ label: 'Your watches', href: '/watches' }, { label: v.name }],
            body: html`<h1>${v.name}</h1>
${notice(text, status === 401 || status === 409 ? 'warn' : 'info')}
<p>${W.inWords(v)}</p>
<p><a class="btn" href="/watches/${v.id}">Back to the watch</a></p>`,
        }, status);
    }

    // ── Edit ────────────────────────────────────────────────────────────────────────────────

    r.get('/watches/:id/edit', async (req, res) => {
        if (!signedIn(req)) return res.redirect(303, `/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
        const row = await owned(req, res);
        if (!row) return notFoundPage(req, res);
        const v = registry.view(row);
        const fields = fieldsOfWatch(v);
        page(req, res, {
            title: `Edit ${v.name}`, private: true, crumbs: [{ label: 'Your watches', href: '/watches' }, { label: v.name, href: `/watches/${v.id}` }, { label: 'Edit' }],
            body: html`<h1>Edit: ${v.name}</h1>
<p class="muted">The kind is fixed by the watch's source; edit what it reads and when it fires.</p>
${watchForm({ template: fields.template, fields, errors: {}, action: `/watches/${v.id}/edit`, submit: 'Save changes' })}`,
        });
    });

    r.post('/watches/:id/edit', formBody, async (req, res) => {
        if (!signedIn(req)) return res.redirect(303, '/auth/login?next=%2Fwatches');
        const row = await owned(req, res);
        if (!row) return notFoundPage(req, res);
        const id = row.id;
        if (!sameOrigin(req, config.baseUrl)) return crossSite(req, res, 'Changing');
        if (!actionLimit(req, res, 'watch.write')) return;
        const template = getTemplate((req.body || {}).template);
        const fields = { ...fieldsOfWatch(registry.view(row)), ...(req.body || {}) };
        fields.notify = req.body && req.body.notify === 'on' ? 'on' : '';
        const built = buildBody(fields, template);
        let errors = built.errors;
        if (!errors) {
            try {
                await registry.patch(id, built.body, principalOf(req));
                return res.redirect(303, `/watches/${id}`);
            } catch (err) {
                if (!(err instanceof RegistryError)) throw err;
                const field = registryField(err.message);
                errors = { [field || 'form']: err.message };
            }
        }
        const v = registry.view(row);
        page(req, res, {
            title: `Edit ${v.name}`, private: true, crumbs: [{ label: 'Your watches', href: '/watches' }, { label: v.name, href: `/watches/${v.id}` }, { label: 'Edit' }],
            body: html`<h1>Edit: ${v.name}</h1>
${errors.form ? notice(errors.form, 'warn') : ''}
<p class="muted">Fix the ${Object.keys(errors).length === 1 ? 'entry' : 'entries'} marked below and save again.</p>
${watchForm({ template, fields, errors, action: `/watches/${id}/edit`, submit: 'Save changes' })}`,
        }, 422);
    });

    // ── How it works, and the update log ────────────────────────────────────────────────────

    r.get('/how-it-works', (req, res) => page(req, res, {
        index: true, cache: cache.htmlHeaders({ maxAge: 3600 }),
        title: 'How it checks',
        description: 'How OpenVibe.Watch decides what to fetch and when: the carrier order, the conditional GET, the polite spacing, the cadence floor, and what every check state means.',
        body: html`<h1>How it checks</h1>
<p class="lede">A watch is a promise to look, not a promise to keep asking. Watch knows several ways to find out whether something changed, and it always takes the cheapest one the source allows.</p>
<h2>The order</h2>
<ol>
<li><strong>An event or a webhook</strong> — when the thing can push to Watch, nothing is polled at all. (Not built yet: a watch of that kind is accepted but never fetched, and says so.)</li>
<li><strong>The site's own ETag or Last-Modified</strong> — if the site gave one, the check carries <code>If-None-Match</code>/<code>If-Modified-Since</code>. A <code>304 Not Modified</code> means “no change” and no body is read.</li>
<li><strong>A feed</strong> — an RSS or Atom feed is read before the page it describes, and the feed's own conditional headers apply.</li>
<li><strong>An API</strong> — a JSON endpoint is read the same way, mapped by the watch itself.</li>
<li><strong>A page</strong> — the page's text is read, as the whole body or one element.</li>
<li><strong>An expensive browser check through OpenVibe.Run</strong> — the last resort, not built yet. A <code>run</code> watch is accepted but never fetched until it is.</li>
</ol>
<h2>The manners</h2>
<ul>
<li><strong>Per-site spacing.</strong> No two requests to one host are made at once, and none closer together than the host's minimum interval — whatever the watch says.</li>
<li><strong>Never faster than the cadence.</strong> A watch is due on the cadence you choose (the shortest here is 15 minutes). A failing site is checked less and less often (backoff), up to a cap.</li>
<li><strong>When the site asks you to wait.</strong> A <code>429</code> or <code>503</code> with <code>Retry-After</code> is obeyed: the watch is not checked again before that time, and the check is recorded <em>“the site asked us to wait”</em>.</li>
<li><strong>Conditional outcomes cost nothing.</strong> A <code>304</code> or a body identical to the last one records no observation — but the condition is still evaluated, so “this has been true for five minutes” can fire while nothing moved.</li>
</ul>
<h2>What a check state means</h2>
${table(['State', 'In plain words'], [
                    ['ok', 'Read, and nothing changed since the last reading.'],
                    ['not_modified', 'The site said “not modified” — no body was read.'],
                    ['no_change', 'The body was read and was identical to last time.'],
                    ['changed', 'The value changed.'],
                    ['condition_met', 'The condition fired (and a notification was emitted).'],
                    ['http_error', 'The site answered an error.'],
                    ['timeout', 'The site did not answer in time.'],
                    ['parse_error', 'The answer could not be read as what the watch expected.'],
                    ['rate_limited', 'The site asked Watch to wait.'],
                    ['budget_exceeded', "The watch's own budget was reached."],
                    ['skipped', 'This kind of check is not run yet (or an AI reading is not supported yet). Nothing was fetched.'],
                    ['disabled', 'The watch is paused, disabled or failing, so it was not checked.'],
                ].map(([state, words]) => [html`<code>${state}</code>`, words]))}
<h2>What is honest about it</h2>
<ul>
<li>A value the source did not state is <code>null</code>; Watch never invents one, and an absent value stays absent.</li>
<li>A failed check is a recorded state, never a silent skip; a failed check records no observation.</li>
<li>A site that is unavailable is retried with backoff, not hammered.</li>
<li>The kinds that arrive later (event, webhook, Run, Node) and an AI reading are not offered in the form, because Watch will not pretend to check what it cannot.</li>
</ul>
<p><a href="/watches/new?template=page">Start a watch</a> · <a href="/">Back home</a></p>`,
    }));

    r.get('/updates', (req, res) => page(req, res, {
        index: true, cache: cache.htmlHeaders({ maxAge: 3600 }),
        title: 'What shipped on OpenVibe.Watch',
        description: 'OpenVibe.Watch’s own changelog: what each release added.',
        body: html`<h1>What shipped on OpenVibe.Watch</h1>
<div class="changelog">${changelog.body()}</div>`,
    }));

    // ── Crawl artifacts (robots, sitemap, llms.txt) ─────────────────────────────────────────
    r.use(createDiscoveryRoutes({ config }));
    return r;
}

module.exports = { createPageRoutes, TEMPLATES, sameOrigin };
