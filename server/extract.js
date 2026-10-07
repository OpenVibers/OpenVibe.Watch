'use strict';
/**
 * Extraction: what value a watch takes from the body a carrier fetched (watch.watch@1 $defs/extraction).
 *
 *   text      the whole body as text, trimmed
 *   html      the body's text (markup stripped), or the text of the first element a `selector` matches
 *   json      the parsed body (a `value_path` picks a part of it); an api or feed carrier hands in
 *             its own document — the mapped { items, latest, … } — so a path reads the watched
 *             record rather than a provider's shape
 *   jsonpath  the same, named for the dotted path it takes
 *   regex     the first match of `selector` (its first group when it has one, else the whole match)
 *   css       the text of the first element a `selector` matches, in the small selector subset below
 *   ai        not here: an AI reading is an action (step 10), and this returns `unsupported`
 *
 * A value the source did not state is null, never guessed: a path that matches nothing and a
 * regular expression that does not match both extract null, which `absent` then answers truthfully.
 * `fields` (name → path) extracts an object of several values at once, each null when it is missing.
 */
const { toText, decodeBody } = require('./util');

/** Longest text value one extraction stores (a 5 MB page as `text` is a mistake, not a value). */
const VALUE_MAX = 64 * 1024;

class ExtractError extends Error {
    constructor(code, detail) { super(detail); this.code = code; }
}

// ── The small selector subset ────────────────────────────────────────────────────────────────
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'noscript']);
const MAX_DEPTH = 200;

function parseAttrs(text) {
    const attrs = {};
    const re = /([:@\w.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let m;
    while ((m = re.exec(text))) {
        attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
    }
    return attrs;
}

/** A forgiving HTML reader: elements, attributes and text, enough to select from. Never throws. */
function parseHtml(html) {
    const root = { type: 'element', tag: '#root', attrs: {}, children: [], parent: null };
    const stack = [root];
    const push = (node) => {
        const top = stack[stack.length - 1];
        const last = top.children[top.children.length - 1];
        if (node.type === 'text') {
            if (last && last.type === 'text') { last.value += node.value; return; }
        }
        top.children.push(node);
    };
    const text = (s) => { if (s) push({ type: 'text', value: s }); };
    let i = 0;
    while (i < html.length) {
        const lt = html.indexOf('<', i);
        if (lt < 0) { text(html.slice(i)); break; }
        if (lt > i) text(html.slice(i, lt));
        if (html.startsWith('<!--', lt)) { const end = html.indexOf('-->', lt + 4); i = end < 0 ? html.length : end + 3; continue; }
        if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) { const end = html.indexOf('>', lt); i = end < 0 ? html.length : end + 1; continue; }
        if (html[lt + 1] === '/') {
            const end = html.indexOf('>', lt);
            const tag = html.slice(lt + 2, end < 0 ? html.length : end).trim().toLowerCase();
            for (let k = stack.length - 1; k > 0; k--) if (stack[k].tag === tag) { stack.length = k; break; }
            i = end < 0 ? html.length : end + 1;
            continue;
        }
        // The tag ends at the first '>' outside a quoted attribute value.
        let end = lt + 1;
        let quote = null;
        for (; end < html.length; end++) {
            const ch = html[end];
            if (quote) { if (ch === quote) quote = null; continue; }
            if (ch === '"' || ch === "'") { quote = ch; continue; }
            if (ch === '>') break;
        }
        if (end >= html.length) { text(html.slice(lt)); break; }
        const raw = html.slice(lt + 1, end);
        const selfClosing = raw.endsWith('/');
        const m = /^([a-zA-Z][\w:-]*)/.exec(selfClosing ? raw.slice(0, -1) : raw);
        if (!m) { text(html.slice(lt, end + 1)); i = end + 1; continue; }
        const tag = m[1].toLowerCase();
        const el = { type: 'element', tag, attrs: parseAttrs(raw.slice(m[1].length)), children: [], parent: stack[stack.length - 1] };
        push(el);
        i = end + 1;
        if (VOID.has(tag) || selfClosing) continue;
        if (RAW.has(tag)) {
            const close = html.toLowerCase().indexOf(`</${tag}`, i);
            const stop = close < 0 ? html.length : close;
            if (stop > i) el.children.push({ type: 'text', value: html.slice(i, stop) });
            if (close < 0) { i = html.length; continue; }
            const gt = html.indexOf('>', close);
            i = gt < 0 ? html.length : gt + 1;
            continue;
        }
        if (stack.length < MAX_DEPTH) stack.push(el);
    }
    return root;
}

const COMPOUND_RE = /^([a-zA-Z][\w-]*|\*)?((?:[.#][\w-]+|\[[^\]]{0,120}\])*)$/;
const PART_RE = /([.#])([\w-]+)|\[([^\]]*)\]/g;

/** 'div.card > a[href] .price' → [{ comb:' ', compound }, …]; null when it is not in the subset. */
function parseSelector(selector) {
    const text = String(selector || '').trim();
    if (!text) return null;
    const parts = [];
    const tokens = text.split(/(\s*>\s*|\s+)/).filter((s) => s !== '');
    let comb = ' ';
    for (const token of tokens) {
        if (/^\s*>\s*$/.test(token)) { comb = '>'; continue; }
        if (/^\s+$/.test(token)) { comb = ' '; continue; }
        const m = COMPOUND_RE.exec(token);
        if (!m) return null;
        const compound = { tag: m[1] && m[1] !== '*' ? m[1].toLowerCase() : null, id: null, classes: [], attrs: [] };
        let p;
        PART_RE.lastIndex = 0;
        while ((p = PART_RE.exec(m[2]))) {
            if (p[1] === '#') compound.id = p[2];
            else if (p[1] === '.') compound.classes.push(p[2]);
            else {
                const a = /^([:@\w.-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?$/.exec(p[3].trim());
                if (!a) return null;
                compound.attrs.push({ name: a[1].toLowerCase(), value: a[2] ?? a[3] ?? a[4] ?? null });
            }
        }
        parts.push({ comb, compound });
        comb = ' ';
    }
    return parts.length ? parts : null;
}

function matchesCompound(el, c) {
    if (c.tag && el.tag !== c.tag) return false;
    if (c.id && el.attrs.id !== c.id) return false;
    if (c.classes.length && !c.classes.every((x) => String(el.attrs.class || '').split(/\s+/).includes(x))) return false;
    for (const a of c.attrs) {
        if (el.attrs[a.name] === undefined) return false;
        if (a.value != null && el.attrs[a.name] !== a.value) return false;
    }
    return true;
}

function matchesFrom(el, parts, i) {
    if (!matchesCompound(el, parts[i].compound)) return false;
    if (i === 0) return true;
    if (parts[i].comb === '>') return el.parent != null && matchesFrom(el.parent, parts, i - 1);
    for (let p = el.parent; p; p = p.parent) if (matchesFrom(p, parts, i - 1)) return true;
    return false;
}

/** Elements matching a parsed selector, in document order. */
function selectAll(root, parts) {
    const out = [];
    const walk = (el) => {
        for (const child of el.children) {
            if (child.type !== 'element') continue;
            if (matchesFrom(child, parts, parts.length - 1)) out.push(child);
            walk(child);
        }
    };
    walk(root);
    return out;
}

/** The text of an element, markup stripped, in document order (script and style dropped). */
function innerText(el, max = VALUE_MAX) {
    let s = '';
    const push = (t) => { if (s.length < max) s += t; };
    const walk = (node) => {
        if (s.length >= max) return;
        for (const child of node.children) {
            if (child.type === 'text') push(child.value);
            else if (!RAW.has(child.tag)) { walk(child); push(' '); }
        }
    };
    walk(el);
    return (toText(s, max) || '').slice(0, max);
}

// ── Paths (json / jsonpath / fields) ─────────────────────────────────────────────────────────
const PATH_RE = /^[A-Za-z0-9_@:$#-]+(\.[A-Za-z0-9_@:$#-]+)*$/;

/** Dot path with array indexes: 'items.0.fields.price' or 'items[0].price'. Missing → undefined. */
function at(obj, path) {
    if (path == null || path === '') return obj;
    const clean = String(path).replace(/\[(\d+)\]/g, '.$1').replace(/^\./, '');
    if (!PATH_RE.test(clean)) return undefined;
    let cur = obj;
    for (const seg of clean.split('.')) {
        if (cur == null || typeof cur !== 'object') return undefined;
        cur = cur[seg];
    }
    return cur;
}

function parseJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        throw new ExtractError('parse_error', 'the body is not valid JSON');
    }
}

/** '/<re>/flags' or a bare pattern → a RegExp; oversized or invalid patterns throw. */
function compileRegex(pattern) {
    const s = String(pattern || '');
    if (!s || s.length > 200) throw new ExtractError('unsupported', 'regex extraction needs a pattern of at most 200 characters');
    const m = /^\/(.*)\/([gimsuy]*)$/.exec(s);
    try {
        return m ? new RegExp(m[1], m[2].replace('g', '')) : new RegExp(s);
    } catch {
        throw new ExtractError('parse_error', 'selector is not a valid regular expression');
    }
}

function capped(text, max) {
    const s = String(text == null ? '' : text);
    return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/**
 * extract(extraction, { body, contentType, document, snapshotMax })
 *   → { value, snapshot }
 *
 * `body` is the fetched body (Buffer or text); `document` is what a carrier already parsed (a
 * feed's or api's mapped records) and is used by json/jsonpath when present. `snapshot` is the
 * capped copy of the body the value came from (the caller decides whether to keep it).
 */
function extract(extraction = {}, { body = null, contentType = null, document = undefined, snapshotMax = 8 * 1024 } = {}) {
    const kind = extraction.kind || 'text';
    const text = body == null ? null : (Buffer.isBuffer(body) ? decodeBody(body, contentType) : String(body));
    const snapshot = text == null ? null : capped(text, snapshotMax);
    const doc = () => (document !== undefined ? document : parseJson(text == null ? '' : text));

    switch (kind) {
        case 'ai':
            throw new ExtractError('unsupported', 'ai extraction is an AI action, not a check (plan T18 step 10): this watch cannot be checked yet');
        case 'text':
            if (text == null) throw new ExtractError('parse_error', 'there is no body to extract from');
            return { value: capped(text.trim(), VALUE_MAX), snapshot };
        case 'html': {
            if (text == null) throw new ExtractError('parse_error', 'there is no body to extract from');
            if (!extraction.selector) return { value: toText(text, VALUE_MAX), snapshot };
            const parts = parseSelector(extraction.selector);
            if (!parts) throw new ExtractError('unsupported', `selector "${extraction.selector}" is not in the supported subset`);
            const first = selectAll(parseHtml(text), parts)[0];
            return { value: first ? innerText(first) || null : null, snapshot };
        }
        case 'css': {
            if (text == null) throw new ExtractError('parse_error', 'there is no body to extract from');
            if (!extraction.selector) throw new ExtractError('unsupported', 'css extraction needs a selector');
            const parts = parseSelector(extraction.selector);
            if (!parts) throw new ExtractError('unsupported', `selector "${extraction.selector}" is not in the supported subset`);
            const first = selectAll(parseHtml(text), parts)[0];
            return { value: first ? innerText(first) || null : null, snapshot };
        }
        case 'json':
        case 'jsonpath': {
            const d = doc();
            const value = extraction.fields ? fieldsOf(d, extraction.fields) : (extraction.value_path ? at(d, extraction.value_path) : d);
            return { value: value === undefined ? null : value, snapshot };
        }
        case 'regex': {
            if (text == null) throw new ExtractError('parse_error', 'there is no body to extract from');
            const re = compileRegex(extraction.selector);
            // Bounded input: a watch's own pattern is compiled as-is, so it only ever runs over a
            // window of VALUE_MAX characters (a value beyond that is not a value this service keeps).
            const m = re.exec(text.slice(0, VALUE_MAX));
            if (!m) return { value: null, snapshot };
            return { value: m.length > 1 ? (m[1] === undefined ? null : m[1]) : m[0], snapshot };
        }
        default:
            throw new ExtractError('unsupported', `extraction kind "${kind}" is not supported`);
    }
}

/** extraction.fields: { name: path } → an object of the values the document states (null when absent). */
function fieldsOf(document, fields) {
    const out = {};
    for (const [name, path] of Object.entries(fields || {})) {
        const v = at(document, path);
        out[name] = v === undefined ? null : v;
    }
    return out;
}

module.exports = { extract, ExtractError, at, parseSelector, parseHtml, selectAll, VALUE_MAX };
