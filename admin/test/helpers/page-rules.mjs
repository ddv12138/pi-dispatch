/**
 * The rules every rendered console page is held to, whatever test drew it: no control byte, no path or email of this
 * machine, no inline script/style/handler, every reference the console's own, and one main, one h1, one sprite with
 * unique ids and bare panels. The page rules outlived the page-snapshot tests they were first applied to; the tests that
 * render a page call them directly.
 */
import assert from "node:assert/strict";
import { hostname } from "node:os";

const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;
const HOST_PATH_RE = /\/Users\/|\/home\/|\/private\/|\/tmp\/|\/var\/folders\//;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/;
// Inside a tag only: escaped text never holds a `<`, and a hostile value that reads "onload=" as text is the point.
const ACTIVE_MARKUP_RE = /<script(?! src="\/static\/console\.js" defer><\/script>)|<style|<[^>]*\s(?:on[a-z]+|style)\s*=|<[^>]*\s(?:href|src)\s*=\s*"?\s*javascript:/i;

/** A link out of the console that a person follows: http(s), and it hands the other page no opener and no Referer. */
const OUTBOUND_LINK_RE = /^<a [^>]*href="https?:\/\/[^"]+" rel="noreferrer noopener" target="_blank">$/;

/**
 * A start tag as a browser reads it: `<` and a letter, the name up to a space, `/` or `>`, then attributes up to the
 * first `>` that is not inside a quoted value (a quoted `>` does not end the tag, so `title="a>b" src=...` still has
 * its `src`).
 */
const TAG_RE = /<([A-Za-z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^"'>])*)>/g;
/**
 * One attribute: its name after a space, a `/` (`<img/src=...>`) or straight after the closing quote of the one before
 * (`alt=""src=...`), all three of which a browser reads as a new attribute, and its value double-, single- or unquoted.
 */
const ATTR_RE = /(?:[\s/]|(?<=["']))([^\s=>"'/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

/**
 * Each start tag of a page, `{ tag, name, attrs }`, its name and attribute names lower-cased and its attributes as
 * `[name, value]` (null for a bare one). THE one parser every page rule reads, so an id in single quotes, an `<H1>`
 * and an unquoted `src` count the same as the forms `html` writes. Asserted to have read every tag the page opens
 * (each `<` before a letter: escaped text never holds a `<`), so a tag it cannot read fails the page instead of
 * hiding its attributes from every rule.
 */
function tagsOf(key, html) {
  const tags = [...html.matchAll(TAG_RE)].map((t) => ({
    tag: t[0],
    name: t[1].toLowerCase(),
    attrs: [...t[2].matchAll(ATTR_RE)].map((a) => [a[1].toLowerCase(), a[2] ?? a[3] ?? a[4] ?? null]),
  }));
  assert.equal(tags.length, (html.match(/<[A-Za-z]/g) ?? []).length, `${key}: the page rules read every tag it opens`);
  return tags;
}

/** Every `id` a page's tags carry, in order, a repeated one repeated. */
const idsOf = (tags) => tags.flatMap((t) => t.attrs.filter(([a, v]) => a === "id" && v !== null).map(([, v]) => v));

/**
 * The attributes whose value is one URL, on any element: `href`, `src`, `action`, `formaction`, `xlink:href`, `poster`,
 * `data` (an `<object>`'s), `background` (a table's, a cell's, the body's) and `codebase` (an `<object>`'s base, which
 * its `data` resolves against). On any element, never only the one that fetches it today: no element of the console
 * carries one of these names for anything but a URL, and a rule that asks which element it is on is one more place
 * for a gap.
 */
const URL_ATTRS = new Set(["src", "href", "action", "formaction", "xlink:href", "poster", "data", "background", "codebase"]);
/** The attributes whose value is a list of image candidates, "url width, url width": `srcset` and a preload's `imagesrcset`. */
const SRCSET_ATTRS = new Set(["srcset", "imagesrcset"]);
/** The five entities `html` writes; a browser decodes any other (`&#x2F;`, `&sol;`) into the URL it requests. */
const ENTITIES = Object.freeze({ "&amp;": "&", "&quot;": '"', "&#39;": "'", "&lt;": "<", "&gt;": ">" });

/**
 * An attribute's URL as the browser requests it: the five entities decoded (any other `&` fails: `/&#x2F;evil.example`
 * is `//evil.example`, a host), each tab and newline removed and the ends trimmed, as the URL parser does (`/` then a
 * newline then `/evil.example` is `//evil.example` too).
 */
function urlOf(key, value, tag) {
  const decoded = value.replace(/&(?:amp|quot|#39|lt|gt);/g, (e) => ENTITIES[e]);
  const at = value.replace(/&(?:amp|quot|#39|lt|gt);/g, "").indexOf("&");
  assert.equal(at, -1, `${key}: a URL attribute writes an & only as one of html's five entities (${tag.slice(0, 120)})`);
  return decoded.replace(/[\t\n\r]/g, "").replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "");
}

/**
 * Every reference a page makes is this console's own (issue #737 extends the spend screen's zero-external-requests rule
 * to every page): each `URL_ATTRS` value, every URL of a `srcset`, an `imagesrcset` and a `ping`, and each `url(...)`,
 * read as the browser reads it (`urlOf`), is a path on this console (`/...`, never `//host` or `/\host`) or an element
 * of this very page (`#id`, the skip link's `#main`, a sprite icon's `#i-name`, a pattern's `url(#hatch)`) whose `id`
 * the page holds; and no `<meta http-equiv>` at all, since a `refresh` is a navigation no attribute above names (the
 * headers are the server's, never the page's). The one exception is a link a person follows out of the console (a
 * run's issue on its forge, a reason's docs page): an `<a>`, never a request the page makes, and only in
 * `OUTBOUND_LINK_RE`'s shape, which is the one `kit.mjs` `outLink` writes (the kit test holds each of its link forms to
 * this rule).
 *
 * What it does NOT read: an `<iframe srcdoc>` (a whole document in one attribute), and the values SVG animation sets
 * (`<animate>`'s and `<set>`'s `values`, `from`, `to` and `by`, which can animate an `href`). No page draws either.
 * What they could FETCH the CSP holds instead: a `srcdoc` document inherits the page's policy, and an image or a
 * script an animation points elsewhere is refused by the same `img-src` and `script-src` the page's own answer to,
 * which the width check, reporting every violation, would show. A link an animation pointed elsewhere is not a
 * request, so nothing here or in the CSP stops it: a page that draws `<animate>` must first teach this rule to read it.
 */
export function assertOwnReferences(key, html) {
  const tags = tagsOf(key, html);
  const ids = new Set(idsOf(tags));
  const refs = [...html.matchAll(/url\(\s*([^)]*?)\s*\)/g)].map((m) => ({ attr: "url", ref: m[1].replace(/^["']|["']$/g, ""), tag: m[0] }));
  for (const { tag, attrs } of tags) {
    for (const [attr, value] of attrs) {
      if (attr === "http-equiv") assert.fail(`${key}: a <meta http-equiv> is a header in the page (${tag.slice(0, 120)})`);
      if (value === null) continue;
      if (URL_ATTRS.has(attr)) refs.push({ attr, ref: urlOf(key, value, tag), tag });
      // A srcset is "url width, url width"; a ping is URLs split on spaces.
      if (SRCSET_ATTRS.has(attr)) for (const part of value.split(",")) refs.push({ attr, ref: urlOf(key, part, tag).split(/\s+/)[0], tag });
      if (attr === "ping") for (const part of value.trim().split(/\s+/)) refs.push({ attr, ref: urlOf(key, part, tag), tag });
    }
  }
  assert.ok(refs.length > 5, `${key}: the check sees the page's references`);
  for (const { attr, ref, tag } of refs) {
    const own = /^#([a-z][a-z0-9-]*)$/.exec(ref);
    if (own) assert.ok(ids.has(own[1]), `${key}: ${ref} names an element this page holds`);
    else if (/^\/(?![/\\])/.test(ref)) continue;
    else assert.ok(attr === "href" && OUTBOUND_LINK_RE.test(tag), `${key}: ${attr}="${ref}" is neither this console's nor this page's (${tag.slice(0, 120)})`);
  }
}

/**
 * A page's structure (review D3, REQ-OPERATOR-CONSOLE-SCREENS), read off the parsed tags (`tagsOf`, so `id='x'` and
 * `<H1>` count): every id once, exactly one `<main>` and it is `#main` (the skip link's target), one `<h1>`, one icon
 * sprite (an element of class `sprite`), and every live panel (`data-panel`) an element that carries its `id` and
 * `data-panel` and nothing else, so the stream's swap of its inner HTML can never lose a class or a role it had.
 */
export function assertStructure(key, html) {
  const tags = tagsOf(key, html);
  const ids = idsOf(tags);
  const twice = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  assert.deepEqual(twice, [], `${key}: every id once`);
  const mains = tags.filter((t) => t.name === "main");
  assert.equal(mains.length, 1, `${key}: one main`);
  assert.deepEqual(idsOf(mains), ["main"], `${key}: the main is #main`);
  assert.equal(tags.filter((t) => t.name === "h1").length, 1, `${key}: one h1`);
  assert.equal(tags.filter((t) => t.attrs.some(([a, v]) => a === "class" && v !== null && v.split(/\s+/).includes("sprite"))).length, 1, `${key}: one sprite`);
  for (const { tag, attrs } of tags.filter((t) => t.attrs.some(([a]) => a === "data-panel"))) {
    assert.deepEqual(attrs.map(([a]) => a).sort(), ["data-panel", "id"], `${key}: a panel carries only its id and data-panel (${tag})`);
  }
}

/** The properties every rendered page holds, whatever it shows. */
export function assertClean(key, html) {
  assert.ok(!CONTROL_RE.test(html), `${key} carries no control byte`);
  assert.doesNotMatch(html, HOST_PATH_RE, `${key} names no path of this deployment`);
  assert.doesNotMatch(html, EMAIL_RE, `${key} holds no email address`);
  assert.doesNotMatch(html, ACTIVE_MARKUP_RE, `${key} carries no inline script, style, handler or javascript: link`);
  const host = hostname().split(".")[0];
  if (host.length >= 3) assert.ok(!html.toLowerCase().includes(host.toLowerCase()), `${key} does not name this machine`);
  assertOwnReferences(key, html);
  assertStructure(key, html);
}
