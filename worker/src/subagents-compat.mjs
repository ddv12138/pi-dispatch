/** The reviewed npm package bytes, excluding its separately resolved node_modules tree. */
import { createHash } from "node:crypto";
import { join, relative } from "node:path";

export const SUBAGENTS_PACKAGE = "pi-subagents@0.73.1";
export const SUBAGENTS_TREE_SHA256 = "3e483a32e7899eb80b29e132030c0aabcd4c99847ca4b761a0bc8f644f3f44b9";
export const SUBAGENTS_ALIAS_SHA256 = "7d259ec64a8e8189fa54b96105c337656b42b9ed989ab6aeb09edf0835871f1c";
const ALIASES = "src/runs/background/runner-aliases.js";
const BEFORE = "const required = [...HOST_PEER_ALIASES, ...(isPreChord ? [] : CHORD_PEER_ALIASES)];";
const AFTER = `const isDispatchReviewedPi = hostManifest?.version === "1.2.0" || hostManifest?.version === "1.5.0";
    const required = [...HOST_PEER_ALIASES.filter(({ specifier }) => !(isDispatchReviewedPi && specifier === "@earendil-works/pi-agent-core/node")), ...((isPreChord || isDispatchReviewedPi) ? [] : CHORD_PEER_ALIASES)];`;
const sha = (data) => createHash("sha256").update(data).digest("hex");
export class SubagentsSourceError extends Error {}

/** Hash all package-owned files, including unexpected additions, without following symlinks. */
export function subagentsSourceDigest(root, fs) {
	const entries = [];
	let bytes = 0;
	function walk(path) {
		const stat = fs.lstatSync(path);
		const name = relative(root, path).split("\\").join("/");
		if (entries.length > 20000 || (bytes += stat.size) > 150 * 1024 * 1024) throw new SubagentsSourceError("pi-subagents-source-too-large");
		if (stat.isSymbolicLink()) throw new SubagentsSourceError("pi-subagents-unsafe-source");
		if (stat.isDirectory()) {
			if (name) entries.push(`d\0${name}\0`);
			for (const name of fs.readdirSync(path)) if (!(path === root && name === "node_modules")) walk(join(path, name));
		} else if (stat.isFile()) entries.push(`f\0${name}\0${sha(fs.readFileSync(path))}\0`);
		else throw new SubagentsSourceError("pi-subagents-unsafe-source");
	}
	walk(root);
	return sha(entries.sort().join(""));
}

export function adaptSubagentsAliases(source) {
	if (sha(source) !== SUBAGENTS_ALIAS_SHA256 || source.split(BEFORE).length !== 2) throw new SubagentsSourceError("pi-subagents 0.73.1 alias source does not match the reviewed version");
	return source.replace(BEFORE, AFTER);
}

/** Refuse altered upstream content before writing anything to the still-private stage. */
export function prepareSubagentsCompat({ root, fs }) {
	if (subagentsSourceDigest(root, fs) !== SUBAGENTS_TREE_SHA256) throw new SubagentsSourceError("pi-subagents 0.73.1 source does not match the reviewed npm package");
	const path = join(root, ALIASES);
	const source = fs.readFileSync(path, "utf8");
	fs.writeFileSync(path, adaptSubagentsAliases(source));
}
