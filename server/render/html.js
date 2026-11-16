'use strict';
/** Escaping and small building blocks for server-rendered pages. Everything dynamic goes through esc(). */

// The shared core (escaping, the html`` template) is openvibe-sdk/html's, the one implementation every site uses
// (the consolidation of 2026-11-16); the rest of this file is this site's own.
const { esc, Raw, raw, html, render, code } = require('openvibe-sdk/html');

/** Tagged template: interpolations are escaped unless wrapped in raw(). Arrays are joined. */

const time = (iso) => (iso ? html`<time datetime="${iso}">${String(iso).replace('T', ' ').replace(/\.\d+Z$/, ' UTC').replace(/Z$/, ' UTC')}</time>` : '—');

/** A <table> from headers and rows of cells (cells are already html or plain values). Each cell names its column
 *  (data-label), so on a phone a wide table can show each row as a card (the site's stylesheet). */
function table(headers, rows, { cls = '', empty = 'Nothing here yet.' } = {}) {
    if (!rows.length) return html`<p class="muted">${empty}</p>`;
    return html`<div class="table-wrap"><table class="${cls}"><thead><tr>${headers.map((h) => html`<th scope="col">${h}</th>`)}</tr></thead><tbody>${rows.map((r) => html`<tr>${r.map((c, i) => (typeof headers[i] === 'string' && headers[i] ? html`<td data-label="${headers[i]}">${c}</td>` : html`<td>${c}</td>`))}</tr>`)}</tbody></table></div>`;
}

/** A problem as returned by Network, Events or Media — shown as it came, never softened. */
function problemBox(p, { title = 'The request failed' } = {}) {
    if (!p) return '';
    return html`<div class="problem" role="alert"><strong>${title}</strong>
<p>${p.detail || 'No detail was given.'}</p>
<p class="muted small">HTTP ${p.status || '—'} · <code>${p.code || 'unknown'}</code>${p.requestId ? html` · request <code>${p.requestId}</code>` : ''}</p></div>`;
}

const notice = (text, kind = 'info') => html`<div class="notice ${kind}" role="status">${text}</div>`;
const csrfField = (token) => html`<input type="hidden" name="csrf" value="${token}">`;
const badge = (text, kind = '') => html`<span class="badge ${kind}">${text}</span>`;

module.exports = { esc, html, raw, Raw, render, code, time, table, problemBox, notice, csrfField, badge };
