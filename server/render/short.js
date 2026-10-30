'use strict';
/**
 * The home on a phone (the owner's short-pages rule, 2026-10-30): one or two screens, app-like.
 *
 *   pickBlock()  several blocks of the same kind, one at a time on a phone, picked with a row of chips. Radio
 *                inputs and :has(), no script: every block stays in the page for crawlers, and a wider screen (or a
 *                browser without :has()) shows them all and no chips.
 *   foldBlock()  a part a reader rarely needs, closed on a phone and open where there is room. The page's own markup
 *                keeps it open, so a browser without the script shows it as before; the script closes it on a narrow
 *                screen and remembers the reader's choice.
 *
 * The CSS for both lives in the site's own stylesheet; the rule that shows the picked block is written for the
 * page, because there is one per block.
 */
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * A pick block. The panes are the page's own blocks; each one keeps its heading on a wide screen, and on a phone the
 * heading gives way to the chip that names it.
 *
 *   pickBlock({ key, label, head, panes })   head: the heading of the block, or '' when the block already has one.
 *                                           panes: [{ id, label, html }]
 */
function pickBlock({ key, label, head = '', panes, bodyClass = '' }) {
    // A pane with nothing to show is left out, so the chips and the rules that show them match the page.
    panes = (panes || []).filter((p) => p.html);
    if (!panes.length) return '';
    const chips = panes.map((p, i) => `<input type="radio" name="pick-${esc(key)}" id="pk-${esc(key)}-${esc(p.id)}" value="${esc(p.id)}"${i === 0 ? ' checked' : ''}><label for="pk-${esc(key)}-${esc(p.id)}">${esc(p.label)}</label>`).join('');
    // The pane carries the id the page already links to (an anchor in the hero, for instance), so a link to it still
    // opens that pane on a phone (the CSS shows the pane a link points at).
    const body = panes.map((p) => `<div class="pick-pane" id="${esc(p.id)}">${p.html}</div>`).join('');
    const bar = `${head ? `<div class="pick-head"><h2>${esc(head)}</h2></div>` : ''}<div class="pick-row" role="radiogroup" aria-label="${esc(label)}">${chips}</div>`;
    return `<div class="pick" id="pick-${esc(key)}"><div class="pick-bar">${bar}</div><div class="pick-body${bodyClass ? ' ' + esc(bodyClass) : ''}">${body}</div></div>`;
}

/** The rule that shows the picked block of a pick block: one per block, so the CSS is written for the page. */
function pickRule(key, id) {
    return `.pick:has(#pk-${key}-${id}:checked) #${id}{display:block}`;
}

/** The rules for every block of a pick block, in the order they appear. */
function pickRules(key, ids) {
    return ids.map((id) => pickRule(key, id)).join('');
}

/**
 * A fold. The head is the heading the block had; the html is what it holds.
 *
 *   foldBlock({ id, head, html })
 */
function foldBlock({ id, head, html }) {
    return `<details class="hm-fold hm-fold-block" id="${esc(id)}" open><summary>${head}<span>tap to open</span></summary>${html}</details>${foldScript(id)}`;
}

/** The script a fold carries: closed on a phone unless the reader opened it before, and it remembers that. */
function foldScript(id) {
    return `<script>(function(){var d=document.getElementById(${JSON.stringify(id)});if(!d)return;var k='ov_fold_'+${JSON.stringify(id)};var s=null;try{s=localStorage.getItem(k)}catch(e){}if(s==='open'){d.open=true;return}if(s==='closed'){d.open=false;return}var t=0;if(window.matchMedia&&window.matchMedia('(max-width:640px)').matches){t=Date.now();d.open=false}d.addEventListener('toggle',function(){if(Date.now()-t<300)return;try{localStorage.setItem(k,d.open?'open':'closed')}catch(e){}})})();</script>`;
}

/**
 * A section of the page's own markup as a fold. The section stays where it was; its own heading becomes the fold's
 * heading, and the fold is closed on a phone (the script) and open where there is room.
 *
 *   foldSection(html, needle, id)   needle: a mark of the part to fold (a class, for instance)
 */
function foldSection(html, needle, id) {
    const at = html.indexOf(needle);
    if (at < 0) return html;
    const start = html.lastIndexOf('<section', at);
    const close = html.indexOf('</section>', at);
    if (start < 0 || close < 0) return html;
    const openEnd = html.indexOf('>', start) + 1;
    const openTag = html.slice(start, openEnd);
    let inner = html.slice(openEnd, close);
    const h2 = /<h2[^>]*>[\s\S]*?<\/h2>/.exec(inner);
    if (!h2) return html;
    const head = h2[0];
    inner = inner.slice(h2.index + head.length);
    // The lede under the heading goes with it: the fold's heading says enough on a phone.
    const lede = /<p class="sc-lede"[^>]*>[\s\S]*?<\/p>/.exec(inner);
    if (lede) inner = inner.slice(0, lede.index) + inner.slice(lede.index + lede[0].length);
    const fold = `<details class="hm-fold hm-fold-block" id="${esc(id)}" open><summary>${head}<span>tap to open</span></summary>${inner.trim()}</details>${foldScript(id)}`;
    return html.slice(0, start) + openTag + fold + html.slice(close);
}

module.exports = { pickBlock, pickRule, pickRules, foldBlock, foldScript, foldSection };
