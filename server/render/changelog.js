'use strict';
/**
 * The update log (/updates) renders Watch's own CHANGELOG.md. Only the few markdown shapes a
 * changelog uses are understood — headings, bullet lists and paragraphs, with **bold** and `code`
 * inline — and the text is escaped first, so nothing a changelog says can become markup.
 */
const fs = require('fs');
const path = require('path');
const { html, raw, esc } = require('./html');

const FILE = path.join(__dirname, '..', '..', 'CHANGELOG.md');
let cache = null;

function read() {
    if (cache) return cache;
    try { cache = fs.readFileSync(FILE, 'utf8'); } catch { cache = '# Changelog\n\nNothing has been recorded yet.\n'; }
    return cache;
}

const inline = (s) => raw(String(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>'));

/** Render the changelog as escaped HTML: h2/h3, <ul><li>, <p>. */
function renderMarkdown(md) {
    const out = [];
    let list = null;
    const flush = () => { if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; } };
    for (const line of String(md).split(/\r?\n/)) {
        const t = line.trim();
        if (!t) { flush(); continue; }
        if (t.startsWith('### ')) { flush(); out.push(html`<h3>${inline(esc(t.slice(4)))}</h3>`); continue; }
        if (t.startsWith('## ')) { flush(); out.push(html`<h2>${inline(esc(t.slice(3)))}</h2>`); continue; }
        if (t.startsWith('# ')) { flush(); out.push(html`<h2>${inline(esc(t.slice(2)))}</h2>`); continue; }
        if (/^[-*] /.test(t)) { list = list || []; list.push(html`<li>${inline(esc(t.slice(2)))}</li>`); continue; }
        flush();
        out.push(html`<p>${inline(esc(t))}</p>`);
    }
    flush();
    return html`${out}`;
}

const body = () => renderMarkdown(read());

module.exports = { body, renderMarkdown };
