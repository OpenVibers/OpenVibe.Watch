'use strict';
/**
 * Safe regular expressions for the patterns a watch states.
 *
 * A regex extraction's `selector` and a `matches` condition's `value` are the watch's own, and they
 * run in the one Node process that serves every watch. A pattern like `(a+)+$` tested against a
 * body would otherwise backtrack for minutes and hang the process (ReDoS).
 *
 * Two guards, so a bad pattern is refused when the watch is saved rather than when it runs:
 *
 *   compile()  refuses what is plainly catastrophic — a pattern longer than MAX_PATTERN, or a
 *              quantified group that itself contains a quantifier (`(a+)+`, `(a*)*`, `(\w+\s?)*`).
 *              The registry calls validate() before it stores a watch, so the API and the form both
 *              answer a validation error at create time.
 *   test()/exec()  run the match under a deadline in a vm context: a pattern the static check let
 *              through but that still backtracks is cut off at TIMEOUT_MS and reported as a timeout
 *              (no match), never a hang. The caller records that as a check error.
 *
 * The static check is a scan of the pattern's shape, not a full parse: it refuses nested quantifiers
 * without judging anything else, so an unusual-but-legitimate pattern still runs under the deadline.
 */
const vm = require('vm');

/** Longest pattern a watch may state (the 500-character rule). */
const MAX_PATTERN = 500;
/** How long one match may run before it is cut off. */
const TIMEOUT_MS = 50;
/** The message a timed-out match records (the caller stores this as the check error). */
const TIMEOUT_MESSAGE = 'pattern took too long';
/** V8's code for a vm script that hit its timeout. */
const TIMEOUT_CODE = 'ERR_SCRIPT_EXECUTION_TIMEOUT';

// One compiled script per operation, run with a fresh sandbox per call: recompiling the one-line
// expression on every check would be waste, and the sandbox is what carries the deadline.
const TEST_SCRIPT = new vm.Script('re.test(s)');
const EXEC_SCRIPT = new vm.Script('re.exec(s)');

class UnsafeRegexError extends Error {
    // reason: 'too_long' | 'nested' | 'invalid' (a caller maps it to its own error code).
    constructor(detail, reason) { super(detail); this.code = 'unsafe_pattern'; this.reason = reason; }
}

/** The source and flags of '/…/flags', or of a bare pattern. */
function split(input) {
    const s = String(input == null ? '' : input);
    const m = /^\/(.*)\/([gimsuy]*)$/.exec(s);
    return m ? { source: m[1], flags: m[2] } : { source: s, flags: '' };
}

/** The length of a quantifier at `i` (`*`, `+`, `?` or `{n[,m]}`), or 0 when there is none. */
function quantifierAt(source, i) {
    const c = source[i];
    if (c === '*' || c === '+' || c === '?') return 1;
    if (c === '{') {
        const m = /^\{\d+(?:,\d*)?\}/.exec(source.slice(i));
        return m ? m[0].length : 0;
    }
    return 0;
}

/**
 * Does the pattern contain a quantified group whose own body contains a quantifier? Groups are read
 * as `(...)`, including non-capturing and lookaround forms; escapes and character classes are read
 * literally, so `\+` and `[a+]` are not quantifiers. A group that is quantified and already holds a
 * quantifier (itself or a group it contains) is the exponential shape this refuses.
 */
function nestedQuantifier(source) {
    const stack = [];
    const markQuantifier = () => { const top = stack[stack.length - 1]; if (top) top.hasQuant = true; };
    let i = 0;
    while (i < source.length) {
        const c = source[i];
        const top = stack[stack.length - 1];
        // The '?' that opens a group prefix ((?:, (?=, (?<name>…) is not a quantifier.
        if (top && top.prefix && c !== '?') top.prefix = false;
        if (c === '\\') { i += 2; continue; }
        if (c === '[') {
            i++;
            if (source[i] === '^') i++;
            if (source[i] === ']') i++;   // a leading ']' is a literal, not the class end
            while (i < source.length && source[i] !== ']') { if (source[i] === '\\') i++; i++; }
            i++;
            continue;
        }
        if (c === '(') { stack.push({ hasQuant: false, prefix: true }); i++; continue; }
        if (c === ')') {
            const frame = stack.pop();
            i++;
            const q = quantifierAt(source, i);
            if (q) {
                i += q;
                if (source[i] === '?') i++;   // a lazy marker belongs to the quantifier
                if (frame.hasQuant) return true;
            }
            if (stack.length && frame.hasQuant) stack[stack.length - 1].hasQuant = true;
            continue;
        }
        if (c === '?') {
            if (top && top.prefix) {
                // Consume the prefix so its '?' is never read as a quantifier.
                i++;
                if (source[i] === ':' || source[i] === '=' || source[i] === '!') i++;
                else if (source[i] === '<') {
                    i++;
                    if (source[i] === '=' || source[i] === '!') i++;
                    else { while (i < source.length && source[i] !== '>') i++; if (source[i] === '>') i++; }
                }
                continue;
            }
            markQuantifier();
            i++;
            if (source[i] === '?') i++;
            continue;
        }
        const q = quantifierAt(source, i);
        if (q) {
            markQuantifier();
            i += q;
            if (source[i] === '?') i++;
            continue;
        }
        i++;
    }
    return false;
}

/** The reason a pattern cannot be used, or null when it is accepted (for validation at save time). */
function validate(pattern, opts) {
    try {
        compile(pattern, opts);
        return null;
    } catch (err) {
        return err instanceof UnsafeRegexError ? err.message : 'selector is not a valid regular expression';
    }
}

/** A pattern as a RegExp, or an UnsafeRegexError (reason 'too_long' | 'nested' | 'invalid'). */
function compile(pattern, { maxLength = MAX_PATTERN } = {}) {
    const { source, flags } = split(pattern);
    if (!source || source.length > maxLength) {
        throw new UnsafeRegexError(`a pattern must be 1–${maxLength} characters`, 'too_long');
    }
    if (nestedQuantifier(source)) {
        throw new UnsafeRegexError('a quantified group must not contain another quantifier (a pattern like (a+)+ can hang the check)', 'nested');
    }
    try {
        // 'g' is dropped: a lastIndex must never carry between checks.
        return new RegExp(source, flags.replace('g', ''));
    } catch {
        throw new UnsafeRegexError('selector is not a valid regular expression', 'invalid');
    }
}

/** Run one script under the deadline → { value, timedOut }; only a timeout is caught. */
function underDeadline(script, re, s, timeout) {
    try {
        return { value: script.runInNewContext({ re, s }, { timeout }), timedOut: false };
    } catch (err) {
        if (err && err.code === TIMEOUT_CODE) return { value: null, timedOut: true };
        throw err;
    }
}

/** re.test(s) under the deadline → { matched, timedOut }; a timeout is not a match. */
function test(re, s, { timeout = TIMEOUT_MS } = {}) {
    const out = underDeadline(TEST_SCRIPT, re, s, timeout);
    return { matched: out.timedOut ? false : Boolean(out.value), timedOut: out.timedOut };
}

/** re.exec(s) under the deadline → { match, timedOut }; a timeout is no match. */
function exec(re, s, { timeout = TIMEOUT_MS } = {}) {
    const out = underDeadline(EXEC_SCRIPT, re, s, timeout);
    return { match: out.timedOut ? null : out.value, timedOut: out.timedOut };
}

module.exports = {
    MAX_PATTERN, TIMEOUT_MS, TIMEOUT_MESSAGE, UnsafeRegexError,
    validate, compile, test, exec, nestedQuantifier,
};
