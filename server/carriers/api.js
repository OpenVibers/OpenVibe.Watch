'use strict';
/**
 * The api carrier: an official JSON (or XML) endpoint, mapped by the watch itself — no code per
 * provider (OpenVibe.Sources/server/adapters/api.js is the same idea).
 *
 *   source.items_path  dot path to the records ('' or absent: the body is the array)
 *   source.fields      { name: path } → each record becomes { name: value, … }
 *
 * With a mapping, extraction reads the mapped records: `value_path: 'latest.price'` (the document
 * is { items, latest, count }) or `extraction.fields` for several values at once. Without one, the
 * parsed body IS the document and extraction.json / extraction.jsonpath reads it directly — the
 * `format: 'json'` case of plan T18 step 3.
 *
 * Fetching is conditional (see carriers/http.js); a 304 or an unchanged body records no observation.
 */
const { parseXml, decodeBody, ParseError } = require('../util');
const { at } = require('../extract');
const { conditionalGet, onlyChange, ACCEPT } = require('./http');
const { mapFields } = require('./feed');

const PATH_RE = /^[A-Za-z0-9_@:$#-]+(\.[A-Za-z0-9_@:$#-]+)*$/;

/** '' means "the body itself is the array"; anything else must be a dotted path. */
function checkItemsPath(p) {
    return p === undefined || p === '' || PATH_RE.test(String(p).replace(/\[(\d+)\]/g, '.$1').replace(/^\./, ''));
}

function mapped(document, itemsPath) {
    if (itemsPath === undefined || itemsPath === '') return document;
    return at(document, itemsPath);
}

function createApiCarrier({ fetcher, config }) {
    return {
        name: 'api',
        run: async ({ watch, state }) => {
            const source = watch.source;
            const out = await conditionalGet({
                source, state, fetcher, secrets: config.secrets, accept: ACCEPT.api,
                onlyChangeNeeded: onlyChange(watch),
            });
            if (out.state !== 'ok' || !out.body) return out;
            const format = source.format || 'json';
            let body;
            try {
                if (format === 'xml') body = parseXml(decodeBody(out.body, out.content_type));
                else {
                    try { body = JSON.parse(decodeBody(out.body, out.content_type)); }
                    catch { throw new ParseError('the body is not valid JSON'); }
                }
            } catch (err) {
                return { ...out, state: 'parse_error', error_code: err.code === 'parse_error' ? 'unreadable' : 'carrier_error', detail: String(err.message).slice(0, 500), body: null };
            }
            const hasMapping = Boolean(source.items_path) || Boolean(source.fields && Object.keys(source.fields).length);
            if (!hasMapping) return { ...out, document: body };
            if (!checkItemsPath(source.items_path)) {
                return { ...out, state: 'parse_error', error_code: 'items_path', detail: `items_path "${source.items_path}" is malformed`, body: null };
            }
            const list = mapped(body, source.items_path);
            if (!Array.isArray(list)) {
                return { ...out, state: 'parse_error', error_code: 'items_path', detail: `items_path "${source.items_path || ''}" is not an array in the response`, body: null };
            }
            const items = mapFields(list.filter((r) => r && typeof r === 'object'), source.fields);
            return {
                ...out,
                document: { format, items, latest: items[0] || null, count: items.length },
            };
        },
    };
}

module.exports = { createApiCarrier, checkItemsPath };
