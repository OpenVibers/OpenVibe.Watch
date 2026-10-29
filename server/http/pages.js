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
const { createNetworkReads } = require('./network-reads');
const seo = require('openvibe-shared/seo');

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
    event: {
        card: 'Something happens on OpenVibe',
        cardBlurb: 'A channel goes live, a new blog post, a wiki page published: fire the moment its event arrives. Nothing is polled. Pair it with one of your Actor agents or a coding task.',
        title: 'Watch for an OpenVibe event',
        kind: 'event',
        kindWords: 'an OpenVibe event',
        ops: ['changed'],
        extraction: 'json',
    },
    webhook: {
        card: 'A webhook arrives',
        cardBlurb: 'Get an address for anything that can call a webhook (GitHub, a store, a CI) and fire on what it sends: nothing is polled.',
        title: 'Watch for a webhook',
        kind: 'webhook',
        kindWords: 'a webhook delivery',
        ops: ['changed', 'exists', 'eq', 'ne', 'contains', 'matches', 'gt', 'gte', 'lt', 'lte'],
        defaultOp: 'changed',
        extraction: 'json',
    },
    lan: {
        card: 'Something on your network goes down',
        cardBlurb: 'A NAS, a printer, a camera or a game server at home: your own computer checks that its port answers, and Watch tells you when it stops. Nothing on your network is opened to the internet.',
        title: 'Watch something on your own network',
        kind: 'node',
        kindWords: 'a device on your own network',
        ops: ['eq'],
        extraction: 'json',
        valuePath: 'status',
    },
};
const TEMPLATE_NAMES = Object.keys(TEMPLATES);
// The public events the event template offers (Contracts: each is `public`, so any watch may read it): which payload
// field narrows it, and which field is new on every occurrence (so `changed` fires once per occurrence).
const EVENT_CHOICES = [
    { value: 'live.stream.started', label: 'A channel goes live on OpenVibe.Live', filterKey: 'channel', filterLabel: 'Channel (username, blank: any channel)', valuePath: 'payload.stream_id' },
    { value: 'live.stream.ended', label: 'A channel’s stream ends on OpenVibe.Live', filterKey: 'channel', filterLabel: 'Channel (username, blank: any channel)', valuePath: 'payload.stream_id' },
    { value: 'blog.post.published', label: 'A new post on OpenVibe.Blog', filterKey: 'blog', filterLabel: 'Blog (blank: any blog)', valuePath: 'payload.canonical_url' },
    { value: 'wiki.page.published', label: 'A page is published on OpenVibe.Wiki', filterKey: 'space', filterLabel: 'Space (blank: any space)', valuePath: 'payload.canonical_url' },
];
const eventChoice = (v) => EVENT_CHOICES.find((e) => e.value === v) || null;
const OPS = {
    changed: 'changes', gt: 'goes above', gte: 'reaches or is more than', lt: 'drops below', lte: 'is less than or equal to',
    eq: 'equals', ne: 'is not', contains: 'contains', matches: 'matches the pattern', exists: 'is present', absent: 'is absent',
};
const NEEDS_VALUE = new Set(['gt', 'gte', 'lt', 'lte', 'eq', 'ne', 'contains', 'matches']);
const NOTIFY_ACTION = [{ kind: 'notification', category: 'service', priority: 'normal' }];
// With notifications off the watch still needs an action (the contract requires one): an event, whose dispatcher is a
// later step, so a quiet watch records its trigger and tells nobody (server/actions.js records it as unavailable).
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
    const { config, db, registry, check, observations, sessions, actions = null, log = console } = ctx;   // ctx.webhookSources: the webhook template
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
            cadence: '3600', notify: 'on', agent_on: '', agent_id: '', agent_note: '', codes_on: '', codes_repo: '', codes_brief: '',
            event: EVENT_CHOICES[0].value, event_filter: '', machine: '', lan_address: '',
        };
    }

    /**
     * The fields a submitted form means. A checkbox posts nothing when it is unchecked, so `notify`
     * is read straight from the body — never inherited from the form's own default.
     */
    function postedFields(template, body) {
        const fields = { ...blankFields(template), ...(body || {}) };
        fields.notify = body && body.notify === 'on' ? 'on' : '';
        fields.agent_on = body && body.agent_on === 'on' ? 'on' : '';
        fields.codes_on = body && body.codes_on === 'on' ? 'on' : '';
        return fields;
    }

    /** Which template an existing watch most resembles, so the edit form shows its fields. */
    function templateOf(watch) {
        const kind = watch.source && watch.source.kind;
        if (kind === 'webhook') return 'webhook';
        if (kind === 'event') return 'event';
        if (kind === 'node') return 'lan';
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
            agent_on: agentAction(watch.action) ? 'on' : '',
            agent_id: (agentAction(watch.action) || {}).agent_id || '',
            agent_note: (agentAction(watch.action) || {}).note || '',
            codes_on: codesAction(watch.action) ? 'on' : '',
            codes_repo: (codesAction(watch.action) || {}).repo || '',
            codes_brief: (codesAction(watch.action) || {}).brief || '',
            event: (watch.source && watch.source.kind === 'event' && watch.source.pattern) || EVENT_CHOICES[0].value,
            machine: (watch.source && watch.source.kind === 'node' && watch.source.node_id) || '',
            lan_address: (watch.source && watch.source.kind === 'node' && watch.source.probe && String(watch.source.probe.target || '').replace(/^tcp:\/\//, '')) || '',
            event_filter: (() => {
                const c = eventChoice(watch.source && watch.source.pattern);
                const f = watch.source && watch.source.filter;
                return c && f && typeof f[c.filterKey] === 'string' ? f[c.filterKey] : '';
            })(),
        };
    }
    const notifyOn = (action) => Array.isArray(action) && action.some((a) => a && a.kind === 'notification');
    const agentAction = (action) => Array.isArray(action) ? action.find((a) => a && a.kind === 'actor-agent') : null;
    const codesAction = (action) => Array.isArray(action) ? action.find((a) => a && a.kind === 'codes-run') : null;

    function actionsFrom(fields, errors) {
        const action = fields.notify === 'on' ? [...NOTIFY_ACTION] : [];
        if (fields.agent_on === 'on') {
            const agentId = String(fields.agent_id || '').trim();
            const note = String(fields.agent_note || '');
            if (!/^agt_[0-9A-HJKMNP-TV-Z]{26}$/.test(agentId)) errors.agent_id = 'Give a valid Actor agent id (agt_ followed by 26 characters).';
            if (note.length > 2000) errors.agent_note = 'The note can be at most 2000 characters.';
            action.push({ kind: 'actor-agent', agent_id: agentId, ...(note ? { note } : {}) });
        }
        if (fields.codes_on === 'on') {
            const repo = String(fields.codes_repo || '').trim();
            const brief = String(fields.codes_brief || '').trim();
            let ok = false;
            try { const u = new URL(repo); ok = u.protocol === 'https:' && !u.username && !u.password && u.pathname.split('/').filter(Boolean).length >= 2; } catch { ok = false; }
            if (!ok || repo.length > 300) errors.codes_repo = 'Give the repository\'s https address, for example https://github.com/you/project.';
            if (!brief) errors.codes_brief = 'Say what the coding task should do when the watch fires.';
            else if (brief.length > 6000) errors.codes_brief = 'The task can be at most 6000 characters.';
            action.push({ kind: 'codes-run', repo, brief });
        }
        return action.length ? action : QUIET_ACTION;
    }

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
        const action = actionsFrom(fields, errors);
        // An event watch has no address and no cadence either: Events delivers it (server/event-sources.js).
        if (template === 'event') {
            const name = String(fields.name == null ? '' : fields.name).trim();
            if (name.length > 120) errors.name = 'A name can be at most 120 characters.';
            const ev = eventChoice(fields.event);
            if (!ev) errors.event = 'Choose what should happen.';
            const filterValue = String(fields.event_filter || '').trim();
            if (filterValue.length > 120 || /[\u0000-\u001f]/.test(filterValue)) errors.event_filter = 'At most 120 characters.';
            if (Object.keys(errors).length) return { errors };
            const body = {
                source: { kind: 'event', pattern: ev.value, filter: filterValue ? { [ev.filterKey]: filterValue } : null },
                cadence: null,
                extraction: { kind: 'json', value_path: ev.valuePath },
                condition: { op: 'changed' },
                action,
            };
            if (name) body.name = name;
            return { body };
        }
        // A watch on the person's own network: their machine checks that host:port answers (carriers/node.js).
        if (template === 'lan') {
            const name = String(fields.name == null ? '' : fields.name).trim();
            if (name.length > 120) errors.name = 'A name can be at most 120 characters.';
            const machine = String(fields.machine || '').trim();
            if (!/^dev_[0-9A-HJKMNP-TV-Z]{26}$/.test(machine)) errors.machine = 'Give your machine\'s id from openvibe.bot/machines (dev_ followed by 26 characters).';
            const address = String(fields.lan_address || '').trim();
            if (!/^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]{1,253}):\d{1,5}$/.test(address) || Number(address.split(':').pop()) > 65535) errors.lan_address = 'Give the device\'s address and port, for example 192.168.1.20:80 or nas.local:5000.';
            const cadenceSec = INT(fields.cadence, 3600);
            if (cadenceSec < W.MIN_CADENCE_SEC) errors.cadence = 'The shortest cadence here is 15 minutes.';
            if (cadenceSec > 2592000) errors.cadence = 'The longest cadence is 30 days.';
            if (Object.keys(errors).length) return { errors };
            const body = {
                source: { kind: 'node', node_id: machine, probe: { target: `tcp://${address}`, timeout_s: 10 } },
                cadence: { every_sec: cadenceSec, jitter_sec: 0 },
                extraction: { kind: 'json', value_path: 'status' },
                condition: { op: 'eq', value: 'down' },
                action,
            };
            if (name) body.name = name;
            return { body };
        }
        // A webhook watch has no address to fetch and no cadence: it is pushed to (server/webhook-sources.js).
        if (template === 'webhook') {
            const name = String(fields.name == null ? '' : fields.name).trim();
            if (name.length > 120) errors.name = 'A name can be at most 120 characters.';
            const valuePath = String(fields.value_path || '').trim();
            const c = conditionFrom(fields, template);
            if (c.error) errors[c.field || 'op'] = c.error;
            if (Object.keys(errors).length) return { errors };
            const body = {
                source: { kind: 'webhook' },
                cadence: null,
                extraction: valuePath ? { kind: 'json', value_path: valuePath } : { kind: 'text' },
                condition: c.condition,
                action,
            };
            if (name) body.name = name;
            return { body };
        }
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
            action,
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
        const named = m.match(/\/(?:source|extraction|condition|cadence|name|action)(?:\/\d+)?\/(url|selector|value_path|value|for_sec|every_sec|agent_id|note)\b/);
        if (named) return named[1] === 'every_sec' ? 'cadence' : (named[1] === 'note' ? 'agent_note' : named[1]);
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
        const conditionBlock = template === 'lan'
            ? html`<fieldset><legend>When should it fire?</legend>
<p class="muted small">When the address stops accepting connections, seen from your machine. It fires once each time it goes down.</p>
</fieldset>`
            : html`<fieldset><legend>When should it fire?</legend>
${field('Condition', opControl, { name: 'op', error: errors.op })}
${needsValue ? field('Value', html`<input type="text" id="${idOf('value')}" name="value" value="${fields.value}" maxlength="200">`, { name: 'value', error: errors.value, hint: 'The value to compare the reading against. Numbers are compared as numbers.' }) : ''}
${(template === 'price' || template === 'json') ? field('Hold for (seconds)', html`<input type="number" id="${idOf('for_sec')}" name="for_sec" value="${fields.for_sec}" min="0" max="2592000" inputmode="numeric">`, { name: 'for_sec', error: errors.for_sec, hint: 'Blank fires as soon as the condition is met; a number makes it wait that long and stay true.' }) : ''}
</fieldset>`;

        let extractionBlock;
        if (template === 'event' || template === 'lan') {
            extractionBlock = '';
        } else if (template === 'webhook') {
            extractionBlock = html`<fieldset><legend>What should it read?</legend>
${field('Value path', html`<input type="text" id="${idOf('value_path')}" name="value_path" value="${fields.value_path}" maxlength="200" placeholder="e.g. action, release.tag_name, order.total">`, { name: 'value_path', error: errors.value_path, hint: 'A dot path into a JSON delivery. Leave it blank to read the whole delivery as text (it works for any sender).' })}
</fieldset>`;
        } else if (template === 'page') {
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

        const pushed = template === 'webhook' || template === 'event';
        const chosen = eventChoice(fields.event) || EVENT_CHOICES[0];
        const whatBlock = template === 'lan'
            ? html`<fieldset><legend>What to watch</legend>
${field('Name', html`<input type="text" id="${idOf('name')}" name="name" value="${fields.name}" maxlength="120" placeholder="e.g. The NAS">`, { name: 'name', error: errors.name, hint: 'Optional. Without one, Watch names it after the address.' })}
${field('Your machine', html`<input type="text" id="${idOf('machine')}" name="machine" value="${fields.machine}" maxlength="30" placeholder="dev_…" required>`, { name: 'machine', error: errors.machine, hint: html`A computer on that network with OpenVibe Node and its computer plugin: copy its id from <a href="https://openvibe.bot/machines">openvibe.bot/machines</a>, where you also turn on “Let my watches check things from this computer”.` })}
${field('Address and port', html`<input type="text" id="${idOf('lan_address')}" name="lan_address" value="${fields.lan_address}" maxlength="260" placeholder="192.168.1.20:80" required>`, { name: 'lan_address', error: errors.lan_address, hint: 'On your own network only (a private or local address): your machine checks that it accepts a connection.' })}
</fieldset>`
            : template === 'event'
            ? html`<fieldset><legend>What to watch</legend>
${field('Name', html`<input type="text" id="${idOf('name')}" name="name" value="${fields.name}" maxlength="120" placeholder="e.g. When goosely goes live">`, { name: 'name', error: errors.name, hint: 'Optional. Without one, Watch names it after the event.' })}
${field('When', select('event', EVENT_CHOICES.map((e) => ({ value: e.value, label: e.label })), fields.event), { name: 'event', error: errors.event, hint: 'It fires the moment OpenVibe.Events delivers it, once per occurrence. Nothing is polled.' })}
${field(chosen.filterLabel, html`<input type="text" id="${idOf('event_filter')}" name="event_filter" value="${fields.event_filter}" maxlength="120">`, { name: 'event_filter', error: errors.event_filter, hint: 'Only that one; leave it blank for every one.' })}
</fieldset>`
            : pushed
            ? html`<fieldset><legend>What to watch</legend>
${field('Name', html`<input type="text" id="${idOf('name')}" name="name" value="${fields.name}" maxlength="120" placeholder="e.g. New releases of my project">`, { name: 'name', error: errors.name, hint: 'Optional. Without one, Watch calls it a webhook watch.' })}
<p class="muted small">There is no address to give: when you save it, Watch shows this watch’s own webhook address and its secret, once. Put both in the sender’s webhook settings.</p>
</fieldset>`
            : html`<fieldset><legend>What to watch</legend>
${field('Name', html`<input type="text" id="${idOf('name')}" name="name" value="${fields.name}" maxlength="120" placeholder="e.g. Laptop price at the usual shop">`, { name: 'name', error: errors.name, hint: 'Optional. Without one, Watch names it after the address.' })}
${field('Address', html`<input type="url" id="${idOf('url')}" name="url" value="${fields.url}" maxlength="2000" required placeholder="https://…">`, { name: 'url', error: errors.url, hint: html`This is ${t.kindWords}, fetched with the site’s own ETag/Last-Modified when it gives one.` })}
</fieldset>`;
        return html`<form class="watch-form" method="post" action="${action}">
<input type="hidden" name="template" value="${template}">
<input type="hidden" name="kind" value="${t.kind}">
${whatBlock}
${extractionBlock}
${conditionBlock}
<fieldset><legend>${pushed ? 'How to tell you' : 'How often, and how to tell you'}</legend>
${pushed ? html`<p class="muted small">${template === 'event' ? 'Checked each time the event arrives (at most 60 an hour), never on a cadence.' : 'Checked each time a signed delivery arrives (at most 60 an hour), never on a cadence.'}</p>` : field('Cadence', cadence, { name: 'cadence', error: errors.cadence, hint: 'Watch never checks more often than this, and can wait longer when the site asks it to.' })}
${checkbox('Notify me when it fires', { name: 'notify', checked: fields.notify === 'on', hint: 'When the condition fires you get one notification on OpenVibe (your notifications on any OpenVibe site), with the value and a link here.' })}
${checkbox('Run one of my agents on OpenVibe.Actor', { name: 'agent_on', checked: fields.agent_on === 'on', hint: 'When the condition fires, Watch gives your agent the value and a link to this watch.' })}
${field('Agent id', html`<input type="text" id="${idOf('agent_id')}" name="agent_id" value="${fields.agent_id}" maxlength="30" placeholder="agt_…">`, { name: 'agent_id', error: errors.agent_id, hint: 'Find the id on your agent’s OpenVibe.Actor page. Required when running an agent.' })}
${field('Note for the agent (optional)', html`<textarea id="${idOf('agent_note')}" name="agent_note" maxlength="2000" rows="3">${fields.agent_note}</textarea>`, { name: 'agent_note', error: errors.agent_note })}
${checkbox('Start a coding task on my own machine (OpenVibe.Codes)', { name: 'codes_on', checked: fields.codes_on === 'on', hint: 'When the condition fires, OpenVibe.Codes runs the task on your machine (add it on openvibe.bot/machines and start one task on openvibe.codes/run first), with the value and a link to this watch. You get the summary and the patch on its page.' })}
${field('Repository', html`<input type="url" id="${idOf('codes_repo')}" name="codes_repo" value="${fields.codes_repo}" maxlength="300" placeholder="https://github.com/you/project">`, { name: 'codes_repo', error: errors.codes_repo })}
${field('The coding task', html`<textarea id="${idOf('codes_brief')}" name="codes_brief" maxlength="6000" rows="3" placeholder="The dependency in the value changed: update it and run the tests.">${fields.codes_brief}</textarea>`, { name: 'codes_brief', error: errors.codes_brief })}
</fieldset>
<p class="form-actions"><button class="btn primary" type="submit">${submit}</button> <a href="/watches">Cancel</a></p>
<p class="muted small">Notifications, Actor agents and coding tasks are delivered when the watch fires.</p>
</form>`;
    }

    /** The GET chooser above the form, so a kind can be picked without any JavaScript. */
    const templateChooser = (template) => html`<form class="template-chooser" method="get" action="/watches/new">
<label for="template">What kind of watch?</label>
<select id="template" name="template">${TEMPLATE_NAMES.map((n) => html`<option value="${n}"${n === template ? raw(' selected') : ''}>${TEMPLATES[n].card}</option>`)}</select>
<button class="btn" type="submit">Show those fields</button>
</form>`;

    // ── Home ────────────────────────────────────────────────────────────────────────────────

    const reads = createNetworkReads({ searchUrl: config.search && config.search.url, log });
    const newWatch = (q) => `/watches/new?${new URLSearchParams(q)}`;
    // Feeds anyone may watch, each checked to answer with a feed: what a person most often wants told about.
    const FEEDS = [
        { title: 'New releases of the OpenVibe Node', detail: 'The agent that runs on robots and computers, from GitHub.', url: 'https://github.com/OpenVibers/OpenVibe.Node/releases.atom', where: 'GitHub' },
        { title: 'New Node.js releases', detail: 'Every Node.js release, current and LTS.', url: 'https://nodejs.org/en/feed/releases.xml', where: 'nodejs.org' },
        { title: 'New remote jobs on OpenVibe.Work', detail: 'Every new remote listing OpenVibe.Work gathers.', url: 'https://openvibe.work/jobs.atom?remote=true', where: 'OpenVibe.Work' },
    ];

    /** Questions people ask first, answered from what Watch does today. */
    const FAQ = [
        ['What can I watch?', 'A web page or one part of it, a price or any number on a page, an RSS or Atom feed, a value in a JSON API, a webhook that something calls, an OpenVibe event such as a channel going live, or a device on your own network.'],
        ['How often does it check?', 'On the cadence you pick: every 15 minutes, hourly, every 6 hours or daily. Events and webhooks are not polled at all: the watch wakes the moment they arrive.'],
        ['Will it hammer the sites I watch?', 'No. It asks whether anything changed before downloading again, never sends two requests to one site at once, keeps a minimum gap per site, and waits when a site asks it to.'],
        ['How am I told?', 'A notification on your OpenVibe account by default. A watch can also call your webhook, hand a task to your OpenVibe.Actor agent or start a coding task on your own machine.'],
        ['Does it guess when a check fails?', 'Never. A failed check is recorded as failed with its reason, and a value that is missing stays missing. Every check is kept with the time and what it found.'],
        ['What does it cost?', 'Nothing while it is in alpha. Reading this page needs no account; making a watch needs your OpenVibe account.'],
        ['Can my app make watches?', 'Yes. The same API the site uses creates, pauses and checks watches and reads every observation, with the watch.* capabilities granted on OpenVibe.Services.'],
    ];

    r.get('/', async (req, res) => {
        let summary = null;
        if (signedIn(req)) {
            const rows = await db.prepare('SELECT status, COUNT(*) AS n FROM watches WHERE owner_sub = ? AND deleted_at IS NULL GROUP BY status').all(subjectOf(req));
            const counts = { active: 0, paused: 0, disabled: 0, failed: 0, total: 0 };
            for (const row of rows) { const n = Number(row.n); counts[row.status] = n; counts.total += n; }
            summary = counts;
        }
        const showcase = require('openvibe-shared/showcase');
        const yours = summary && summary.total
            ? `You have ${summary.total} watch${summary.total === 1 ? '' : 'es'}: ${summary.active} active, ${summary.paused} paused, ${summary.failed} failing.`
            : null;
        const hero = showcase.hero({
            eyebrow: 'OpenVibe.Watch · pages, feeds, APIs and webhooks',
            title: 'Know the moment it changes.',
            accent: 'Checked politely, never guessed.',
            lede: 'Give Watch a page, a feed or a JSON API, or pick something on OpenVibe such as a channel going live. Say which value you care about and when to tell you. It checks on the cadence you pick, or wakes the moment an event or a webhook arrives, keeps what every check found, and tells you when your condition fires.',
            actions: signedIn(req)
                ? [{ label: 'New watch', href: '/watches/new?template=page', primary: true }, { label: 'Your watches', href: '/watches' }]
                : [{ label: 'Sign in to start', href: '/auth/login?next=%2Fwatches%2Fnew%3Ftemplate%3Dpage', primary: true }, { label: 'How it checks', href: '#h-check' }],
            note: yours || 'Free while it is in alpha. Reading this page needs no account.',
        });
        const ICONS = { page: 'ov:docs', price: 'ov:deals', feed: 'ov:news', json: 'ov:json', event: 'ov:live', webhook: 'ov:code', lan: 'ov:plug' };
        const [channelRows, plans, postRows] = await Promise.all([reads.channels(), reads.plans(), reads.posts()]);
        const channels = channelRows.slice().sort((a, b) => Number(b.live) - Number(a.live)).slice(0, 8);
        // Newest first from Search, so the first post seen for a blog is its latest.
        const blogs = [...postRows.reduce((m, p) => (m.has(p.blog) ? m : m.set(p.blog, p)), new Map()).values()].slice(0, 3);
        const card = ({ title, detail, href, label, extra = '' }) => html`<li class="hm-card"><div class="hm-card-body"><b>${title}</b>${detail ? html`<span>${detail}</span>` : ''}${raw(extra)}</div><a class="hm-go" href="${href}">${label}</a></li>`;
        const readyGroups = [
            plans.length ? { title: 'Hosting prices', lede: 'Plans on OpenVibe.Host, read from its catalog API.', items: plans.map((p) => card({ title: p.title, detail: p.detail, href: newWatch({ template: 'json', url: `${p.origin}/api/v1/catalog/plans/${p.id}`, value_path: 'plan.price_monthly', op: 'changed', name: `Price: ${p.title}`.slice(0, 80) }), label: 'Tell me when the price changes' })) } : null,
            { title: 'Feeds', lede: 'Told the moment a new item appears.', items: FEEDS.map((f) => card({ title: f.title, detail: f.detail, href: newWatch({ template: 'feed', url: f.url, name: f.title.slice(0, 80) }), label: 'Watch this feed' })) },
            blogs.length ? { title: 'Blogs on OpenVibe', lede: 'Woken by the blog.post.published event, so nothing is polled.', items: blogs.map((b) => card({ title: `New posts on @${b.blog}`, detail: `Latest: ${b.title}`, href: newWatch({ template: 'event', event: 'blog.post.published', event_filter: b.blog, name: `New posts on @${b.blog}` }), label: 'Tell me about new posts' })) } : null,
        ].filter(Boolean);
        const faqLd = seo.jsonLd.faq(FAQ.map(([q, a]) => ({ q, a })));
        page(req, res, {
            index: true,
            cache: signedIn(req) ? null : cache.htmlHeaders({ maxAge: 300 }),
            jsonLd: [...homeJsonLd(config), channels.length ? seo.jsonLd.itemList('Channels on OpenVibe.Live you can watch', channels.map((c) => ({ name: `@${c.username}`, url: c.url }))) : null, faqLd],
            description: DESCRIPTION,
            styles: [showcase.STYLESHEET],
            css: ['css/home.css'],
            body: html`${raw(hero)}
${raw(showcase.features({
                id: 'start',
                title: 'Start with one of these',
                lede: 'Each opens the form filled in for that kind of watch; change anything before you save it.',
                items: TEMPLATE_NAMES.map((n) => ({ icon: ICONS[n] || 'ov:bell', title: TEMPLATES[n].card, text: TEMPLATES[n].cardBlurb, href: `/watches/new?template=${n}` })),
            }))}
${channels.length ? html`<section class="sc-sec" aria-labelledby="h-live"><div class="hm-head"><h2 id="h-live">Know when a channel goes live</h2><a class="hm-more" href="https://openvibe.live/">OpenVibe.Live</a></div>
<p class="sc-lede">Channels active on OpenVibe.Live lately. A watch on one wakes on the live.stream.started event the moment it goes live: nothing is polled.</p>
<ul class="hm-grid">${channels.map((c) => html`<li class="hm-card"><div class="hm-card-body"><b><a href="${c.url}">@${c.username}</a></b><span>${[c.category, c.followers ? `${c.followers} follower${c.followers === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')}</span>${c.live ? raw('<span class="hm-live">Live now</span>') : ''}</div><a class="hm-go" href="${newWatch({ template: 'event', event: 'live.stream.started', event_filter: c.username, name: `@${c.username} goes live` })}">Tell me when they go live</a></li>`)}</ul></section>` : ''}
<section class="sc-sec" aria-labelledby="h-ready"><h2 id="h-ready">Ready-made watches</h2>
<p class="sc-lede">Each opens the form already filled in. Check it, change anything, and save.</p>
${readyGroups.map((g) => html`<h3 class="hm-group">${g.title}</h3><p class="hm-group-lede">${g.lede}</p><ul class="hm-grid">${g.items}</ul>`)}</section>
<section class="sc-sec" aria-labelledby="h-check"><details class="hm-fold"><summary><h2 id="h-check">How it checks</h2><span>from a URL to a notification, politely</span></summary>${raw(showcase.steps({
                id: 'steps',
                title: 'From a URL to a notification',
                items: [
                    { title: 'Point it at something', text: 'A page (and, if you like, the CSS selector of the part you care about), an RSS or Atom feed, or a JSON API and a path into it.' },
                    { title: 'Say when to tell you', text: 'Any change, a number above or below a value, text that appears or disappears, a new item in a feed — held for a while if you want it steady.' },
                    { title: 'Pick a cadence', text: 'Every 15 minutes, hourly, every 6 hours or daily. Watch never checks faster than that, and slower when a site asks it to wait.' },
                    { title: 'Get told', text: 'When the condition fires, the notification arrives on your OpenVibe account, and the watch page shows every check and the value it found.' },
                ],
            }))}
<div class="hm-fold-body"><ul class="facts">
<li><strong>The cheapest way first.</strong> If the site gave Watch an ETag or Last-Modified, the next check asks with <code>If-None-Match</code>/<code>If-Modified-Since</code> and a “not modified” answer costs no body. When only “did it change?” matters, a <code>HEAD</code> is tried while a validator is held: two headers instead of a page.</li>
<li><strong>Feeds and APIs before pages.</strong> The carrier order is binding: an event or webhook when one exists, then the etag, then a feed, then an API, and only then an expensive browser check. A watch checks the kind its source names.</li>
<li><strong>Polite per-site spacing.</strong> Two requests to one host never leave at once, and no two requests to a host are closer than the host’s minimum interval — whatever the watch says.</li>
<li><strong>Never faster than your cadence.</strong> A watch is due on the cadence you pick; a failing site is checked less often (backoff), and a site that asks Watch to wait is waited for (<code>Retry-After</code>).</li>
<li><strong>Every check is recorded.</strong> Read, no change, changed, condition met, a site error, a timeout, an unreadable answer, a wait, a skipped kind — the state is kept with the value, the time and a capped snapshot, and the watch is re-armed on every path.</li>
</ul>
<p><a href="/how-it-works">The full picture, in plain words</a>.</p></div></details></section>
<section class="sc-sec" id="api" aria-labelledby="h-api"><details class="hm-fold"><summary><h2 id="h-api">Make watches from your own code</h2><span>the API, with curl</span></summary>${raw(showcase.code({
                lede: 'The site and the API are the same: create, pause and check watches and read every observation with a token that holds the watch.* capabilities.',
                samples: [
                    { label: 'Create a watch (curl)', lang: 'sh', code: `curl -X POST ${config.baseUrl}/api/v1/watches \\\n  -H "Authorization: Bearer $OPENVIBE_TOKEN" \\\n  -H 'Content-Type: application/json' \\\n  -d '{"name": "Node.js releases",\n       "source": {"kind": "feed", "url": "https://nodejs.org/en/feed/releases.xml"},\n       "cadence": {"every_sec": 3600},\n       "extraction": {"kind": "json", "value_path": "latest"},\n       "condition": {"op": "changed"},\n       "action": [{"kind": "notification"}]}'` },
                    { label: 'Read what it found (curl)', lang: 'sh', code: `# Your watches\ncurl -H "Authorization: Bearer $OPENVIBE_TOKEN" \\\n  ${config.baseUrl}/api/v1/watches\n\n# Every value one watch observed, newest first\ncurl -H "Authorization: Bearer $OPENVIBE_TOKEN" \\\n  ${config.baseUrl}/api/v1/watches/wch_…/observations` },
                ],
            }))}</details></section>
<section class="sc-sec" id="faq" aria-labelledby="h-faq"><h2 id="h-faq">Questions</h2>
<div class="hm-faq">${FAQ.map(([q, a], i) => html`<details class="hm-qa"${i === 0 ? raw(' open') : ''}><summary><h3>${q}</h3></summary><p>${a}</p></details>`)}</div></section>
${summary ? html`<section class="sc-sec" aria-labelledby="h-yours"><h2 id="h-yours">Your watches</h2>
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

    /**
     * A link from another OpenVibe site may start the form filled in (Host's "Watch this price": template json, the plan's
     * API URL, value_path plan.price_monthly, op changed). Only form defaults: the person still reviews and submits, and
     * the POST validates everything as usual. Each value is bounded; anything unexpected is dropped, never an error.
     */
    function prefilled(template, q = {}) {
        const fields = { ...blankFields(template), url: typeof q.url === 'string' ? q.url.slice(0, 2000) : '' };
        if (typeof q.name === 'string') fields.name = q.name.replace(/[\u0000-\u001f]/g, '').slice(0, 80);
        if (typeof q.value_path === 'string' && /^[A-Za-z0-9_$][A-Za-z0-9_.$\[\]-]{0,199}$/.test(q.value_path)) fields.value_path = q.value_path;
        if (typeof q.op === 'string' && TEMPLATES[template].ops.includes(q.op)) fields.op = q.op;
        if (typeof q.value === 'string') fields.value = q.value.slice(0, 200);
        // A link from an Actor agent's page: run that agent when the watch fires (the person still submits the form).
        if (typeof q.agent_id === 'string' && /^agt_[0-9A-HJKMNP-TV-Z]{26}$/.test(q.agent_id)) { fields.agent_on = 'on'; fields.agent_id = q.agent_id; fields.notify = ''; }
        if (typeof q.event === 'string' && eventChoice(q.event)) fields.event = q.event;
        // The home page's "Tell me when they go live" names the channel: the event's filter (bounded like the form's).
        if (typeof q.event_filter === 'string' && q.event_filter.length <= 120 && !/[\u0000-\u001f]/.test(q.event_filter)) fields.event_filter = q.event_filter.trim();
        return fields;
    }

    r.get('/watches/new', (req, res) => {
        if (!signedIn(req)) return res.redirect(303, `/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
        const template = getTemplate(req.query.template);
        page(req, res, {
            title: `New watch: ${TEMPLATES[template].card}`, private: true,
            body: html`<h1>New watch</h1>
<p class="muted">${TEMPLATES[template].title}.</p>
${templateChooser(template)}
${watchForm({ template, fields: prefilled(template, req.query), errors: {}, action: '/watches/new', submit: 'Create this watch' })}`,
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
                if (template === 'webhook' && ctx.webhookSources) return secretPage(req, res, registry.view(row), await ctx.webhookSources.issue(row.id), 201);
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
        const acts = actions ? await actions.recent(row.id, 10) : [];
        const configuredActions = (v.action || []).map((a) => a.kind === 'actor-agent'
            ? html`<div>Run agent <a href="https://openvibe.actor/me/agents/${a.agent_id}"><code>${a.agent_id}</code></a>${a.note ? html` — ${a.note}` : ''}</div>`
            : a.kind === 'codes-run'
                ? html`<div>Coding task on <code>${a.repo}</code> (OpenVibe.Codes, on your machine) — ${String(a.brief || '').slice(0, 200)}</div>`
                : html`<div><code>${a.kind}</code></div>`);

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

        const ACT_WORDS = { queued: ['waiting to send', 'info'], sent: ['sent', 'ok'], skipped: ['not sent', 'warn'], failed: ['failed', 'bad'], unavailable: ['not available yet', 'warn'] };
        const actRows = acts.map((a) => [
            time(a.created_at),
            a.kind === 'notification' ? 'Notification' : html`<code>${a.kind}</code>`,
            badge((ACT_WORDS[a.state] || [a.state])[0], (ACT_WORDS[a.state] || [null, 'info'])[1]),
            a.error ? html`<span class="muted small">${a.error}</span>` : (a.attempts > 1 ? html`<span class="muted small">${a.attempts} attempts</span>` : ''),
        ]);

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
${v.source.kind === 'webhook'
                ? html`<dt>Webhook address</dt><dd><code>${config.baseUrl}/hooks/${v.id}</code> <form class="inline" method="post" action="/watches/${v.id}/webhook-secret"><button class="btn" type="submit">Make a new secret</button></form><br><span class="muted small">The secret was shown once, when the watch was made. A new one replaces it at once.</span></dd>`
                : html`<dt>Source</dt><dd><code>${v.source.kind}</code> · <code>${v.source.url || (v.source.pattern ? v.source.pattern : '(none)')}</code></dd>`}
<dt>Cadence</dt><dd>${v.cadence ? W.everyWords(v.cadence.every_sec) : (v.source.kind === 'webhook' ? 'when a delivery arrives' : (v.source.kind === 'event' ? 'when its event arrives' : 'not polled'))}</dd>
<dt>Actions</dt><dd>${configuredActions}</dd>
<dt>Last check</dt><dd>${v.health.last_check_at ? html`${time(v.health.last_check_at)} — ${W.stateWords(v.health.last_state)}` : html`<span class="muted">not checked yet</span>`}</dd>
<dt>Next due</dt><dd>${v.health.next_due_at ? time(v.health.next_due_at) : html`<span class="muted">—</span>`}</dd>
${v.health.consecutive_failures ? html`<dt>Failing</dt><dd>${v.health.consecutive_failures} check(s) in a row</dd>` : ''}
<dt>Last value</dt><dd>${latest ? W.valueWords(latest.value, 200) : html`<span class="muted">nothing recorded yet</span>`}</dd>
</dl>
${actionForms}
<section aria-labelledby="h-obs"><h2 id="h-obs">Observation history</h2>
${table(['When', 'Value', 'Changed', 'Condition'], obsRows, { empty: 'No observations yet. Watch records one when a check reads a value.' })}
<nav class="pager">${nextObs ? html`<a class="btn" href="${nextObs}">Older observations</a>` : html`<span class="muted">That is every observation kept.</span>`}</nav></section>
<section aria-labelledby="h-acts"><h2 id="h-acts">What it did when it fired</h2>
${table(['When', 'Action', 'Result', 'Detail'], actRows, { empty: 'Nothing yet: the condition has not fired since actions began (2026-10-10).' })}</section>
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

    // A new secret for a webhook watch: the old one stops working at once, and the new one is shown this once.
    r.post('/watches/:id/webhook-secret', formBody, async (req, res) => {
        if (!signedIn(req)) return res.redirect(303, '/auth/login?next=%2Fwatches');
        if (!sameOrigin(req, config.baseUrl)) return crossSite(req, res, 'Changing the secret of');
        if (!actionLimit(req, res, 'watch.write')) return;
        const row = await owned(req, res);
        if (!row) return notFoundPage(req, res);
        const v = registry.view(row);
        if (v.source.kind !== 'webhook' || !ctx.webhookSources) return detailNotice(req, res, row, 409, 'Only a webhook watch has a secret.');
        return secretPage(req, res, v, await ctx.webhookSources.issue(row.id), 200);
    });

    /** The address and secret of a webhook watch, shown once: no cache, no index, and never again after this page. */
    function secretPage(req, res, v, hook, status) {
        res.set('Cache-Control', 'no-store');
        res.set('Referrer-Policy', 'no-referrer');
        return page(req, res, {
            title: `${v.name}: webhook address`, private: true, crumbs: [{ label: 'Your watches', href: '/watches' }, { label: v.name, href: `/watches/${v.id}` }],
            body: html`<h1>Your webhook is ready</h1>
${notice('Copy the secret now: it is not shown again. Making a new one replaces it.', 'warn')}
<dl class="facts">
<dt>Address</dt><dd><code class="copyable">${hook.url}</code></dd>
<dt>Secret</dt><dd><code class="copyable">${hook.secret}</code></dd>
</dl>
<h2>In the sender</h2>
<ul class="facts">
<li><strong>GitHub and most services:</strong> paste the address as the payload URL, choose <code>application/json</code>, and paste the secret as the secret. They sign each delivery with <code>X-Hub-Signature-256</code>.</li>
<li><strong>A sender that cannot sign:</strong> send the secret as <code>Authorization: Bearer &lt;secret&gt;</code>.</li>
<li><strong>Try it:</strong> <code>curl -X POST -H 'Content-Type: application/json' -H 'Authorization: Bearer ${hook.secret}' -d '{"hello":"watch"}' ${hook.url}</code></li>
</ul>
<p>${W.inWords(v)}</p>
<p><a class="btn primary" href="/watches/${v.id}">Go to the watch</a></p>`,
        }, status);
    }

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
        fields.agent_on = req.body && req.body.agent_on === 'on' ? 'on' : '';
        fields.codes_on = req.body && req.body.codes_on === 'on' ? 'on' : '';
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
<li><strong>An event or a webhook</strong> — when the thing can push to Watch, nothing is polled at all. An event watch is checked when its OpenVibe.Events event arrives; a webhook watch gets its own signed <code>/hooks/</code> address and is checked when a delivery reaches it.</li>
<li><strong>The site's own ETag or Last-Modified</strong> — if the site gave one, the check carries <code>If-None-Match</code>/<code>If-Modified-Since</code>. A <code>304 Not Modified</code> means “no change” and no body is read.</li>
<li><strong>A feed</strong> — an RSS or Atom feed is read before the page it describes, and the feed's own conditional headers apply.</li>
<li><strong>An API</strong> — a JSON endpoint is read the same way, mapped by the watch itself.</li>
<li><strong>A page</strong> — the page's text is read, as the whole body or one element.</li>
<li><strong>Your own computer</strong> — for something on your home or office network (a router, a NAS, a printer page), one read-only check from your own machine through the OpenVibe Node, only where you turned that on for it.</li>
<li><strong>An expensive browser check through OpenVibe.Run</strong> — the last resort. It waits for a browser worker, so a <code>run</code> watch is accepted but not checked yet, and says so on its page.</li>
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
