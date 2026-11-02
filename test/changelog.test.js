'use strict';
/**
 * The update log (/updates, server/render/changelog.js): a bullet list is markup once, never escaped a second time
 * (2026-11-02 the page showed "&lt;ul&gt;&lt;li&gt;… watch&amp;#39;s"), and what the changelog says is still escaped.
 */
const assert = require('assert');
const { renderMarkdown } = require('../server/render/changelog');

const out = String(renderMarkdown([
    '## 2026-11-01 — the condition in words',
    '',
    "- The watch's condition in one sentence, with `code` and **bold**.",
    '- A second item <script>alert(1)</script>',
    '',
    'A paragraph after the list.',
].join('\n')));

assert.match(out, /<ul><li>The watch&#39;s condition in one sentence, with <code>code<\/code> and <strong>bold<\/strong>\.<\/li><li>/, out);
assert.ok(!out.includes('&lt;ul&gt;') && !out.includes('&amp;#39;'), `a list is escaped once: ${out}`);
assert.ok(out.includes('&lt;script&gt;') && !out.includes('<script>'), 'what the changelog says is still text');
assert.match(out, /<h2>2026-11-01 — the condition in words<\/h2>/);
assert.match(out, /<p>A paragraph after the list\.<\/p>/);
console.log('changelog: all checks passed');
