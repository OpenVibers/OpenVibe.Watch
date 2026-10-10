'use strict';
/** Extraction: text, html, css (the small subset), json/jsonpath, regex, fields — and `ai` refusing. */
const assert = require('assert');
const { suite } = require('./helpers');
const { extract, ExtractError, at, parseSelector } = require('../server/extract');

const t = suite('extract');
const body = (s) => Buffer.from(s, 'utf8');

const PAGE = `<!doctype html>
<html><head><title>Shop</title><style>.price { color: red }</style><script>var x = "<span>9.99</span>";</script></head>
<body>
  <div id="main" class="card wide">
    <h1 class="title">Widget <em>Pro</em></h1>
    <p class="price" data-currency="EUR">€ 19,<span class="cents">99</span></p>
    <ul id="stock"><li>3 in stock</li><li>warehouse B</li></ul>
    <a href="/buy" rel="nofollow">Buy now</a>
  </div>
</body></html>`;

t('text: the whole body trimmed, capped, never markup-stripped', () => {
    const out = extract({ kind: 'text' }, { body: body('  hello  '), contentType: 'text/plain' });
    assert.strictEqual(out.value, 'hello');
    const html = extract({ kind: 'text' }, { body: body('<b>hi</b>') });
    assert.strictEqual(html.value, '<b>hi</b>', 'text states what the source sent');
    const long = extract({ kind: 'text' }, { body: body('x'.repeat(70000)) });
    assert.strictEqual(long.value.length, 65536);
    assert.ok(long.value.endsWith('…'));
});

t('html: markup stripped, or the text of the first element the selector matches', () => {
    const all = extract({ kind: 'html' }, { body: body(PAGE), contentType: 'text/html' });
    assert.match(all.value, /Widget Pro/);
    assert.match(all.value, /3 in stock/);
    assert.ok(!all.value.includes('var x'), 'scripts are dropped');
    assert.ok(!all.value.includes('color: red'), 'styles are dropped');
    const title = extract({ kind: 'html', selector: 'h1.title' }, { body: body(PAGE) });
    assert.strictEqual(title.value, 'Widget Pro');
    const price = extract({ kind: 'html', selector: '#main .price' }, { body: body(PAGE) });
    assert.strictEqual(price.value, '€ 19,99');
    const attr = extract({ kind: 'html', selector: 'a[rel="nofollow"]' }, { body: body(PAGE) });
    assert.strictEqual(attr.value, 'Buy now');
    const missing = extract({ kind: 'html', selector: '.nothing' }, { body: body(PAGE) });
    assert.strictEqual(missing.value, null, 'a selector that matches nothing states nothing');
});

t('css: the small selector subset (tag, .class, #id, [attr], descendants, >)', () => {
    const pick = (selector) => extract({ kind: 'css', selector }, { body: body(PAGE) }).value;
    assert.strictEqual(pick('li'), '3 in stock', 'the first match, like regex');
    assert.strictEqual(pick('#stock li'), '3 in stock');
    assert.strictEqual(pick('ul#stock'), '3 in stock warehouse B', 'the whole matched element, in document order');
    assert.strictEqual(pick('.card .title'), 'Widget Pro');
    assert.strictEqual(pick('div#main > h1'), 'Widget Pro');
    assert.strictEqual(pick('div#main > a'), 'Buy now');
    assert.strictEqual(pick('ul[id=stock] li.cents'), null, 'no such element');
    assert.strictEqual(pick('[data-currency]'), '€ 19,99');
    assert.strictEqual(pick('h1 em'), 'Pro');
    // the pseudo-classes and sibling combinators of real CSS are outside the subset, not silently ignored
    assert.strictEqual(parseSelector('li:first-child'), null);
    assert.strictEqual(parseSelector('h1 + p'), null);
    assert.throws(() => extract({ kind: 'css' }, { body: body(PAGE) }), /needs a selector/);
    assert.throws(() => extract({ kind: 'css', selector: 'li:first-child' }, { body: body(PAGE) }), (e) => e.code === 'unsupported');
});

t('json / jsonpath: the parsed body, a dotted path, array indexes and fields', () => {
    const doc = JSON.stringify({ product: { price: { amount: 19.99, currency: 'EUR' }, tags: ['new', 'sale'] } });
    assert.deepStrictEqual(Object.keys(extract({ kind: 'json' }, { body: body(doc) }).value), ['product']);
    assert.strictEqual(extract({ kind: 'json', value_path: 'product.price.amount' }, { body: body(doc) }).value, 19.99);
    assert.strictEqual(extract({ kind: 'jsonpath', value_path: 'product.tags.1' }, { body: body(doc) }).value, 'sale');
    assert.strictEqual(extract({ kind: 'jsonpath', value_path: 'product.tags[0]' }, { body: body(doc) }).value, 'new');
    assert.strictEqual(extract({ kind: 'json', value_path: 'product.nothing' }, { body: body(doc) }).value, null, 'a path that matches nothing extracts null, never undefined');
    const fields = extract({ kind: 'json', fields: { price: 'product.price.amount', currency: 'product.price.currency', missing: 'product.gone' } }, { body: body(doc) }).value;
    assert.deepStrictEqual(fields, { price: 19.99, currency: 'EUR', missing: null });
    assert.throws(() => extract({ kind: 'json' }, { body: body('not json') }), (e) => e.code === 'parse_error');
});

t('json reads the document a carrier already parsed (a feed or api mapping)', () => {
    const document = { items: [{ title: 'a', price: 3 }, { title: 'b', price: 5 }], latest: { title: 'a', price: 3 }, count: 2 };
    assert.strictEqual(extract({ kind: 'json', value_path: 'latest.title' }, { body: body('{}'), document }).value, 'a');
    assert.strictEqual(extract({ kind: 'json', value_path: 'items.1.price' }, { body: body('{}'), document }).value, 5);
    assert.strictEqual(extract({ kind: 'json', fields: { latest: 'latest.title', n: 'count' } }, { body: null, document }).value.latest, 'a');
});

t('regex: the first match, a group when the pattern has one', () => {
    assert.strictEqual(extract({ kind: 'regex', selector: '(\\d+\\.\\d+) EUR' }, { body: body('now 12.50 EUR, then 99.00 EUR') }).value, '12.50');
    assert.strictEqual(extract({ kind: 'regex', selector: '\\d{4}-\\d{2}-\\d{2}' }, { body: body('on 2026-10-07 at noon') }).value, '2026-10-07');
    assert.strictEqual(extract({ kind: 'regex', selector: '/(\\d+) items/i' }, { body: body('12 ITEMS left') }).value, '12');
    assert.strictEqual(extract({ kind: 'regex', selector: 'nothing' }, { body: body('abc') }).value, null);
    assert.throws(() => extract({ kind: 'regex', selector: '(' }, { body: body('x') }), (e) => e.code === 'parse_error');
    assert.throws(() => extract({ kind: 'regex', selector: 'x'.repeat(600) }, { body: body('x') }), (e) => e.code === 'unsupported');
});

t('regex: an unsafe pattern is refused, and a slow one times out as no match', () => {
    // a nested quantifier is refused at compile time (the registry refuses it at save time too)
    assert.throws(() => extract({ kind: 'regex', selector: '(a+)+$' }, { body: body('aaaa') }),
        (e) => e.code === 'unsupported' && /quantified group/.test(e.message));
    // an alternation slips past the static check; the deadline makes it a no-match with the reason
    const out = extract({ kind: 'regex', selector: '^(\\w|\\w\\w)*$' }, { body: body('a'.repeat(40) + '!') });
    assert.strictEqual(out.value, null, 'a pattern that hit its deadline states no match');
    assert.strictEqual(out.error, 'pattern took too long');
});

t('ai is not a check: it refuses, and the refusal is `unsupported`', () => {
    assert.throws(() => extract({ kind: 'ai', ai: { prompt: 'read the price' } }, { body: body(PAGE) }), (err) => {
        assert.ok(err instanceof ExtractError);
        assert.strictEqual(err.code, 'unsupported');
        assert.match(err.message, /AI action/);
        return true;
    });
});

t('the snapshot is a capped copy of the body the value came from', () => {
    const out = extract({ kind: 'text' }, { body: body('hello world'), snapshotMax: 5 });
    assert.strictEqual(out.value, 'hello world');
    assert.strictEqual(out.snapshot, 'hell…');
});

t('at(): dotted paths, indexes, and nothing that is not a path', () => {
    assert.strictEqual(at({ a: { b: [{ c: 1 }] } }, 'a.b.0.c'), 1);
    assert.strictEqual(at({ a: { b: [{ c: 1 }] } }, 'a.b[0].c'), 1);
    assert.strictEqual(at({ a: 1 }, 'a.b.c'), undefined);
    assert.strictEqual(at({ a: 1 }, 'a; DROP TABLE'), undefined);
    assert.deepStrictEqual(at({ a: 'x' }, ''), { a: 'x' }, 'an empty path is the document itself (items_path "")');
});

t.run();
