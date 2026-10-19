/**
 * The host API surface, read through namespaces instead of named imports.
 *
 * A static named import is bound when the module is instantiated: if the host
 * module has no such export, loading this extension fails outright — "Export
 * named 'X' not found in module …". oh-my-pi (omp) loads pi extensions by
 * aliasing `@earendil-works/pi-*` onto its own bundled packages through a
 * legacy shim, and that shim is missing two symbols upstream pi exports:
 * `formatSkillsForPrompt` (skills prompt rendering) and `keyHint` (the TUI
 * keybinding hint). Under a named import that is a fatal load error before a
 * single line of this extension runs, which is exactly what omp reports.
 *
 * Reading `namespace.symbol` defers the miss to the call that needs it. Each
 * symbol here therefore resolves in order — host pi, host-renamed equivalent,
 * local fallback — so the extension loads on any host and only the missing
 * nicety degrades. Keep it that way: the cost of a namespace read is one
 * property access, the cost of a named import is the whole extension.
 *
 * `tests/unit-pi-host.mjs` pins both hosts: the upstream shape (every symbol
 * present) and the omp shape (the shim's surface).
 */

import * as piAi from "@earendil-works/pi-ai";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import * as piTui from "@earendil-works/pi-tui";
import type { Skill } from "@earendil-works/pi-coding-agent";
// Type-only, so it is erased before any host resolves modules: nothing needs
// the `pi-ai/compat` subpath at runtime just because we type against it.
import type { getModels as hostGetModelsType } from "@earendil-works/pi-ai/compat";

/** A host module seen as a bag of maybe-present members. */
type HostModule = Record<string, unknown>;

export interface HostModules {
	ai: HostModule;
	codingAgent: HostModule;
	tui: HostModule;
}

const host: HostModules = {
	ai: piAi,
	codingAgent: piCodingAgent,
	tui: piTui,
};

/** Replace the host modules. Tests only: production reads the real imports. */
export function __setHostForTest(modules: Partial<HostModules>): void {
	Object.assign(host, modules);
}

/** The function under `name`, or undefined when the host does not export it. */
function hostFn(module: HostModule, name: string): ((...args: never[]) => unknown) | undefined {
	const value = module[name];
	return typeof value === "function" ? (value as (...args: never[]) => unknown) : undefined;
}

// --- Skills prompt ---------------------------------------------------------

/** XML-escape, as upstream's formatter does: names, descriptions and paths all
 *  land inside a `<skill>` element. */
function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/**
 * Port of pi's `formatSkillsForPrompt` (same output, verified against the
 * installed pi-ai catalog), used when the host does not export it. Both hosts
 * render the same block, so a skill block handed to Claude Code reads
 * identically whichever one loaded us.
 */
export function localFormatSkillsForPrompt(skills: Skill[], fileReadTool = "read"): string {
	const visible = skills.filter((skill) => !skill.disableModelInvocation);
	if (visible.length === 0) return "";
	const readInstruction =
		fileReadTool === "read"
			? "Use the read tool to load a skill's file when the task matches its description."
			: fileReadTool === "bash"
				? "Use bash to load a skill's file when the task matches its description."
				: "Load a skill's file when the task matches its description.";
	const lines = [
		"",
		"",
		"The following skills provide specialized instructions for specific tasks.",
		readInstruction,
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];
	for (const skill of visible) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}
	lines.push("</available_skills>");
	return lines.join("\n");
}

/** The host's skills-block formatter, or the local port when it has none (omp). */
export function formatSkillsForPrompt(skills: Skill[], fileReadTool = "read"): string {
	const hostFormatter = hostFn(host.codingAgent, "formatSkillsForPrompt");
	if (hostFormatter) {
		try {
			const block = hostFormatter(skills as never, fileReadTool as never);
			if (typeof block === "string") return block;
		} catch {
			// A host formatter that throws on our input is still a missing
			// formatter: fall through to the port rather than fail the turn.
		}
	}
	return localFormatSkillsForPrompt(skills, fileReadTool);
}

// --- Keybinding hints ------------------------------------------------------

/** A hint suffix for a TUI line: the host's themed hint when it has one, else
 *  the plain description. Cosmetic either way — never worth failing a render. */
export function keyHint(key: string, description: string): string {
	// Upstream exports it from pi-coding-agent; omp dropped it there and kept
	// `keyHint` in pi-tui (its pi-tui shim re-exports the canonical package).
	for (const module of [host.codingAgent, host.tui]) {
		const hint = hostFn(module, "keyHint");
		if (hint) {
			try {
				const rendered = hint(key as never, description as never);
				if (typeof rendered === "string" && rendered) return rendered;
			} catch {
				// An unknown keybinding name is a host-side lookup miss.
			}
		}
	}
	return description;
}

// --- TypeBox facade --------------------------------------------------------

/** The standalone `typebox` package, resolved at load and only when the host
 *  has no facade of its own: a host that does not ship the peer dependency
 *  (omp installs extension packages on its own terms) must not fail the whole
 *  extension over an opt-in tool's schema builder. */
async function importTypebox(): Promise<typeof import("typebox").Type | undefined> {
	try {
		return (await import("typebox")).Type;
	} catch {
		return undefined;
	}
}

let typeboxFallback: typeof import("typebox").Type | undefined = await importTypebox();

/** Replace the resolved TypeBox fallback. Tests only. */
export function __setTypeboxFallbackForTest(facade: typeof import("typebox").Type | undefined): void {
	typeboxFallback = facade;
}

/**
 * The TypeBox facade to build tool schemas with. Both hosts export it from the
 * pi-ai root (upstream pi-ai moved it there when the standalone package lost
 * the runtime export; omp bridges it to its own TypeBox facade), so the
 * host wins over the peer dependency, which may not be installed.
 */
export function hostType(): typeof import("typebox").Type | undefined {
	return (host.ai as { Type?: typeof import("typebox").Type }).Type ?? typeboxFallback;
}

// --- Model catalog ---------------------------------------------------------
/** `pi-ai/compat`'s getModels, resolved at load. The subpath is real in
 *  upstream pi-ai (`dist/compat.js`) and absent under omp, which serves the
 *  same catalog from the package root — so this cannot be a static import: a
 *  host without the subpath would fail the whole extension at load. The
 *  dynamic import sits behind `??`, so a host whose root already exports the
 *  catalog (omp) never evaluates it. */
async function importCompatCatalog(): Promise<((...args: never[]) => unknown) | undefined> {
	try {
		const compat = (await import("@earendil-works/pi-ai/compat")) as HostModule;
		return hostFn(compat, "getModels");
	} catch {
		return undefined;
	}
}

let compatCatalog: ((...args: never[]) => unknown) | undefined = await importCompatCatalog();

/** Replace the resolved compatibility catalog. Tests only, since in production
 *  it is resolved once, at load, from whichever pi-ai the host provides. */
export function __setCompatCatalogForTest(source: ((...args: never[]) => unknown) | undefined): void {
	compatCatalog = source;
}

/**
 * The anthropic model catalog. omp re-exports it from its pi-ai root
 * (`getModels` → `getBundledModels`, the pi-ai 15.1.0 home); upstream serves it
 * from the `pi-ai/compat` subpath. Try the root, then the subpath, and only
 * then report an empty catalog — the picker is empty either way, but the log
 * says why.
 */
export function getModels(provider: string): ReturnType<typeof hostGetModelsType> {
	const sources = [hostFn(host.ai, "getModels"), compatCatalog].filter(
		(source): source is (...args: never[]) => unknown => source !== undefined,
	);

	for (const source of sources) {
		try {
			const models = source(provider as never);
			if (Array.isArray(models) && models.length > 0) {
				return models as ReturnType<typeof hostGetModelsType>;
			}
		} catch (error) {
			console.error(`claude-bridge: host getModels("${provider}") failed: ${error}`);
		}
	}
	console.error(
		`claude-bridge: no ${provider} model catalog from this host — the model picker will be empty. ` +
			`Update @earendil-works/pi-ai (or the host's bundled copy) to a version that exports getModels from its root or its /compat subpath.`,
	);
	return [] as unknown as ReturnType<typeof hostGetModelsType>;
}
