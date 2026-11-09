/**
 * The parts every surviving console browser check shares: where Chrome is, how it starts, and the two readings a width
 * rule needs (the page's collector and the verdict over it). Lifted, unchanged, out of the console width check when
 * that check and its golden pages were removed, so setup, models, answerer and connections still measure what they draw.
 */
import { accessSync, constants } from "node:fs";
import { findOnPath } from "../../launch/server-binary.mjs";

const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** An iPhone-sized viewport in CSS pixels, drawn at device scale 2: the phone a console page must fit. */
export const VIEWPORT = Object.freeze({ width: 375, height: 812, scale: 2 });
/** Sub-pixel slack on "past the edge", "fits" and "overlaps": a box ending at 375.4 is layout rounding, not overflow. */
export const EDGE_SLACK = 0.5;

/**
 * Where Chrome is: `{ path, from }`, `{ path: null }` when there is none, or `{ error }` when CHROME names something
 * that cannot run (a stated binary that is missing is a mistake to report, never a reason to skip quietly).
 */
export function findChrome({ env = process.env, onPath = findOnPath, executable = isExecutable } = {}) {
	if (env.CHROME) return executable(env.CHROME) ? { path: env.CHROME, from: "CHROME" } : { error: `CHROME is ${env.CHROME}, which is not an executable file` };
	const found = onPath(["google-chrome", "chromium"], env.PATH ?? "");
	if (found) return { path: found, from: "PATH" };
	if (executable(MAC_CHROME)) return { path: MAC_CHROME, from: "the macOS app" };
	return { path: null };
}

function isExecutable(path) {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * The width rule over what the page measured: `scrollWidth` (the scrolling element's) and `elements`, every element
 * whose box ends past `width` in document order, each `{ tag, id, cls, inside, rect, up, text, font, scrollers }`:
 * `inside` the id of its nearest ancestor that has one, `up` the index of its nearest ancestor in the same list (or
 * -1), `text` whether it holds text of its own, `scrollers` its ancestors below `<body>` whose computed `overflow-x` is
 * auto or scroll, with their boxes.
 *
 * An element is an offender unless one of its scrollers fits the viewport. The report names the ROOTS (offenders with
 * no offending ancestor: where a `min-width: 0` or a scroll box belongs), widest first, and `fontAt`, the first
 * offender holding text inside the widest root, whose platform font is worth resolving.
 */
export function widthVerdict({ scrollWidth, elements }, width = VIEWPORT.width, slack = EDGE_SLACK) {
	const fits = (r) => r.left >= -slack && r.right <= width + slack;
	// `<body>` and `<html>` never excuse: their overflow propagates to the viewport, and a scrolling viewport is the
	// failure itself. The page's collector stops below `<body>`; this repeats it so the rule holds on any input.
	const excused = (e) => (e.scrollers ?? []).some((s) => (s.overflowX === "auto" || s.overflowX === "scroll") && s.tag !== "body" && s.tag !== "html" && fits(s.rect));
	const past = elements.map((e) => e.rect.right > width + slack && !excused(e));
	const offenders = elements.map((e, i) => ({ e, i })).filter(({ i }) => past[i]);
	// Widest first, ties in document order: the widest root is the one that sets the page's width, so it leads.
	const roots = offenders.filter(({ e }) => !(e.up >= 0 && past[e.up])).sort((a, b) => b.e.rect.right - a.e.rect.right || a.i - b.i);
	const under = (i, root) => {
		for (let j = i; j >= 0; j = elements[j].up) if (j === root) return true;
		return false;
	};
	let fontAt = null;
	if (roots.length > 0) fontAt = offenders.find(({ e, i }) => e.text && under(i, roots[0].i))?.i ?? roots[0].i;
	return {
		ok: scrollWidth <= width && offenders.length === 0,
		width,
		scrollWidth,
		wide: scrollWidth > width,
		offenders: offenders.length,
		roots: roots.slice(0, 5).map(({ e, i }) => ({ i, tag: e.tag, id: e.id, cls: e.cls, inside: e.inside ?? "", rect: e.rect })),
		fontAt,
	};
}

/**
 * The collector `widthVerdict` reads (see there), keeping the elements in `window.__pdWidthKeep` for the font lookup.
 * `width` is the window's, never the page's `clientWidth`: a phone's viewport that a too-wide page zooms out widens
 * with the page (measured: a 2332 px title left nothing past a `clientWidth` edge), so the edge is the one the run set.
 */
export function measureSource(width, slack) {
	return `(() => {
	const W = ${width};
	const S = ${slack};
	const se = document.scrollingElement || document.documentElement;
	const box = (r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
	const name = (el) => ({ tag: el.tagName.toLowerCase(), id: el.id || "", cls: el.getAttribute("class") || "" });
	const index = new Map();
	const keep = [];
	const elements = [];
	for (const el of document.querySelectorAll("body, body *")) {
		const r = el.getBoundingClientRect();
		if (!(r.width > 0 && r.height > 0 && r.right > W + S)) continue;
		let up = -1;
		for (let a = el.parentElement; a; a = a.parentElement) if (index.has(a)) { up = index.get(a); break; }
		const scrollers = [];
		for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
			const ox = getComputedStyle(a).overflowX;
			if (ox === "auto" || ox === "scroll") scrollers.push(Object.assign(name(a), { overflowX: ox, rect: box(a.getBoundingClientRect()) }));
		}
		let text = false;
		for (const n of el.childNodes) if (n.nodeType === 3 && n.nodeValue.trim() !== "") { text = true; break; }
		index.set(el, elements.length);
		keep.push(el);
		const host = el.parentElement ? el.parentElement.closest("[id]") : null;
		elements.push(Object.assign(name(el), { rect: box(r), up, text, font: text ? getComputedStyle(el).fontFamily : "", inside: host ? host.id : "", scrollers }));
	}
	Object.defineProperty(window, "__pdWidthKeep", { value: keep, configurable: true });
	const activeProgress = [];
	for (const [i, row] of [...document.querySelectorAll("#p-active tbody tr")].entries()) {
		const progress = row.querySelector(".fl-prog");
		const cell = progress?.closest("td");
		if (!cell) continue;
		const action = row.querySelector('td[data-l="Progress"] + td .btn');
		const parts = [];
		for (const [name, selector] of [["progress", ".fl-prog"], ["phase list", ".phases"], ["phase", ".phases li"], ["phase bar", ".phases .bar"], ["phase label", ".phases .name"]]) for (const el of cell.querySelectorAll(selector)) {
			const rect = el.getBoundingClientRect();
			if (!(rect.width > 0 && rect.height > 0)) continue;
			parts.push({ name, rect: box(rect), clipped: (name === "progress" || name === "phase list") && el.scrollWidth > el.clientWidth + S });
		}
		activeProgress.push({ row: i + 1, cell: box(cell.getBoundingClientRect()), action: action ? box(action.getBoundingClientRect()) : null, parts });
	}
	const projectCharts = [];
	for (const svg of document.querySelectorAll("#p-proj-sizing svg.proj-chart")) {
		const texts = [];
		for (const el of svg.querySelectorAll("text.proj-axis")) {
			const rect = el.getBoundingClientRect();
			if (!(rect.width > 0 && rect.height > 0)) continue;
			const matrix = el.getScreenCTM();
			const screenPx = matrix ? parseFloat(getComputedStyle(el).fontSize) * Math.min(Math.abs(matrix.a), Math.abs(matrix.d)) : null;
			texts.push({ label: el.textContent, screenPx, rect: box(rect) });
		}
		projectCharts.push({ rect: box(svg.getBoundingClientRect()), texts });
	}
	const projectKpis = [];
	for (const headline of document.querySelectorAll("#p-proj-spend .proj-kv > b")) {
		const texts = [];
		const walk = document.createTreeWalker(headline, NodeFilter.SHOW_TEXT);
		while (walk.nextNode()) {
			const node = walk.currentNode;
			const parent = node.parentElement;
			if (!node.nodeValue.trim() || parent.closest('.sr,[hidden],[aria-hidden="true"],small,sup,sub')) continue;
			const style = getComputedStyle(parent);
			if (style.visibility !== "visible" || Number(style.opacity) === 0) continue;
			const range = document.createRange(); range.selectNodeContents(node);
			if (![...range.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0)) continue;
			texts.push({ text: node.nodeValue.trim(), fontPx: parseFloat(style.fontSize), color: style.color });
		}
		projectKpis.push({ label: headline.textContent, fontPx: parseFloat(getComputedStyle(headline).fontSize), ink: getComputedStyle(headline.closest(".card")).color, texts });
	}
	if (document.querySelector("#p-proj-runs .card") && projectKpis.length === 0) projectKpis.push({ label: "", fontPx: null, ink: null, texts: [] });
	const stackedLabels = [];
	if (W <= ${PHONE_MAX}) {
		const canvas = document.createElement("canvas");
		const context = canvas.getContext("2d");
		for (const cell of document.querySelectorAll('[data-page="connections"] .tbl--stack td[data-l]')) {
			const rect = cell.getBoundingClientRect();
			const style = getComputedStyle(cell);
			const prefix = getComputedStyle(cell, "::before");
			if (style.display === "none" || style.visibility !== "visible" || rect.height <= 0 || prefix.content === "none" || prefix.display === "none") continue;
			const label = cell.getAttribute("data-l");
			if (context) context.font = prefix.fontStyle + " " + prefix.fontWeight + " " + prefix.fontSize + " " + prefix.fontFamily;
			const spacing = parseFloat(prefix.letterSpacing) || 0;
			const words = label.split(/\\s+/).filter(Boolean).map((word) => ({ word, width: context ? context.measureText(word).width + spacing * Math.max(0, word.length - 1) : null }));
			const widest = words.sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
			stackedLabels.push({ panel: cell.closest("[data-panel]")?.id ?? "unknown", label, word: widest?.word ?? "", wordPx: widest?.width ?? null, fontPx: parseFloat(prefix.fontSize), available: rect.width - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0) - (parseFloat(style.borderLeftWidth) || 0) - (parseFloat(style.borderRightWidth) || 0) });
		}
	}
	const updateActions = [];
	for (const row of document.querySelectorAll('[data-page="updates"] #p-up-jobs tbody tr')) {
		const box = row.closest(".tbl-wrap")?.getBoundingClientRect();
		const line = row.querySelector(".up-line")?.getBoundingClientRect();
		for (const button of row.querySelectorAll(".up-act .btn")) {
			const at = button.getBoundingClientRect();
			if (at.width <= 0) continue;
			updateActions.push({
				text: button.textContent.trim(),
				clipped: Boolean(box) && (at.right > box.right + 0.5 || at.left < box.left - 0.5),
				overlaps: Boolean(line) && at.left < line.right - 0.5 && at.right > line.left + 0.5 && at.top < line.bottom - 0.5 && at.bottom > line.top + 0.5,
			});
		}
	}
	return { updateActions, scrollWidth: se.scrollWidth, clientWidth: document.documentElement.clientWidth, elements, activeProgress, projectCharts, projectKpis, stackedLabels };
})()`;
}

/** Both console browser checks use the same platform startup policy; their document CSP stays enforced. */
export function chromeLaunchArgs({ sandbox = true } = {}) {
	return ["--use-mock-keychain", ...(sandbox ? [] : ["--no-sandbox"])];
}
