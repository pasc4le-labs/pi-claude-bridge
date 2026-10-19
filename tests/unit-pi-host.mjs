/**
 * The host compatibility layer (pi-host.ts).
 *
 * pi extensions run under more than one host: upstream pi, and oh-my-pi (omp),
 * which aliases `@earendil-works/pi-*` onto its own bundled packages through a
 * legacy shim. That shim is missing `formatSkillsForPrompt` and `keyHint`, and
 * serves the model catalog from the pi-ai root instead of the `pi-ai/compat`
 * subpath. Each of those was a fatal load error under a static named import —
 * "Export named 'formatSkillsForPrompt' not found in module
 * 'omp-legacy-pi-bundled:@oh-my-pi/pi-coding-agent'" — so these tests pin both
 * the upstream shape and the omp shape.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import * as piAi from "@earendil-works/pi-ai";
import { __setCompatCatalogForTest, __setHostForTest, __setTypeboxFallbackForTest, contentText, formatSkillsForPrompt, getCurrentSystemMessage, getCurrentTools, getModels, hostType, keyHint, localContentText, localFormatSkillsForPrompt, localGetCurrentSystemMessage, localGetCurrentTools } from "../src/pi-host.js";
import { buildAskClaudeParams } from "../src/askclaude-schema.js";

/** The upstream subpath's catalog, which pi-host resolves at load. Read here so
 *  a test that clears it can put the real one back. */
const compatGetModels = (await import("@earendil-works/pi-ai/compat")).getModels;

const skill = (overrides = {}) => ({
	name: "pdf-table-extraction",
	description: "Parse tables out of PDFs & keep quotes \"intact\"",
	filePath: "/skills/pdf-table-extraction/SKILL.md",
	baseDir: "/skills/pdf-table-extraction",
	sourceInfo: {},
	disableModelInvocation: false,
	...overrides,
});

/** The omp shim's surface: the canonical re-export minus the two symbols it dropped. */
function ompCodingAgent() {
	const { formatSkillsForPrompt: _dropped, keyHint: _alsoDropped, ...rest } = piCodingAgent;
	return rest;
}

afterEach(() => {
	__setHostForTest({ ai: piAi, codingAgent: piCodingAgent, tui: {} });
	__setCompatCatalogForTest(compatGetModels);
});

describe("formatSkillsForPrompt", () => {
	it("matches the host's formatter byte for byte when the host has one", () => {
		const skills = [skill(), skill({ name: "excalidraw", description: "Hand-drawn diagrams", filePath: "/skills/excalidraw/SKILL.md" })];
		assert.equal(formatSkillsForPrompt(skills), piCodingAgent.formatSkillsForPrompt(skills));
		assert.equal(localFormatSkillsForPrompt(skills), piCodingAgent.formatSkillsForPrompt(skills));
	});

	it("renders the same block from the local port when the host dropped it (omp)", () => {
		__setHostForTest({ codingAgent: ompCodingAgent() });
		const skills = [skill()];
		const block = formatSkillsForPrompt(skills);
		assert.equal(block, piCodingAgent.formatSkillsForPrompt(skills), "the port must be equivalent to upstream's output");
		assert.match(block, /<available_skills>/);
		assert.match(block, /<name>pdf-table-extraction<\/name>/);
		// Escaped, or a description with an ampersand ends the XML attribute early.
		assert.match(block, /Parse tables out of PDFs &amp; keep quotes &quot;intact&quot;/);
	});

	it("honours disableModelInvocation and an empty list", () => {
		assert.equal(formatSkillsForPrompt([skill({ disableModelInvocation: true })]), "");
		assert.equal(formatSkillsForPrompt([]), "");
	});

	it("reads the read-tool instruction from the caller's tool choice", () => {
		assert.match(formatSkillsForPrompt([skill()], "bash"), /Use bash to load a skill's file/);
		assert.match(formatSkillsForPrompt([skill()], "none"), /^Load a skill's file when the task matches its description\./m);
	});

	it("falls back to the port when the host formatter throws", () => {
		__setHostForTest({ codingAgent: { ...ompCodingAgent(), formatSkillsForPrompt: () => { throw new Error("host bug"); } } });
		assert.equal(formatSkillsForPrompt([skill()]), localFormatSkillsForPrompt([skill()]));
	});
});

describe("keyHint", () => {
	it("prefers the host's themed hint when it renders", () => {
		__setHostForTest({ codingAgent: { ...ompCodingAgent(), keyHint: (key, description) => `ctrl+o ${description}` } });
		assert.equal(keyHint("app.tools.expand", "to expand"), "ctrl+o to expand");
	});

	it("degrades to the plain description when the host hint throws", () => {
		// The real host hint reads the terminal theme and throws outside a themed
		// TUI ("Theme not initialized. Call initTheme() first."), which is exactly
		// the shape a render-time helper must not propagate.
		__setHostForTest({ codingAgent: { ...ompCodingAgent(), keyHint: () => { throw new Error("Theme not initialized. Call initTheme() first."); } }, tui: {} });
		assert.equal(keyHint("app.tools.expand", "to expand"), "to expand");
	});

	it("falls back to the plain description when the host has no keyHint (omp)", () => {
		__setHostForTest({ codingAgent: ompCodingAgent(), tui: {} });
		assert.equal(keyHint("app.tools.expand", "to expand"), "to expand");
	});

	it("takes keyHint from pi-tui when the coding agent no longer exports it", () => {
		__setHostForTest({ codingAgent: ompCodingAgent(), tui: { keyHint: (key, description) => `${description} [ctrl+o]` } });
		assert.equal(keyHint("app.tools.expand", "to expand"), "to expand [ctrl+o]");
	});

	it("never throws out of a render when the host hint rejects our keybinding", () => {
		__setHostForTest({ codingAgent: { ...ompCodingAgent(), keyHint: () => { throw new Error("unknown keybinding"); } }, tui: {} });
		assert.equal(keyHint("app.tools.expand", "to expand"), "to expand");
	});
});

describe("transcript helpers", () => {
	const sys = (over = {}) => ({ role: "system", content: "", timestamp: 7, ...over });

	it("contentText returns strings as-is and joins only text blocks", () => {
		assert.equal(contentText("plain"), "plain");
		assert.equal(
			contentText([{ type: "text", text: "a" }, { type: "thinking", thinking: "t" }, { type: "text", text: "b" }]),
			"a\nb",
		);
		assert.equal(contentText([{ type: "text", text: "a" }, { type: "text", text: "b" }], " "), "a b");
	});

	it("getCurrentTools replays additions and removals across system messages", () => {
		const messages = [
			sys({ toolsAdded: [{ name: "read" }, { name: "bash" }] }),
			{ role: "user", content: "hi", timestamp: 8 },
			sys({ toolsRemoved: [{ name: "bash" }], toolsAdded: [{ name: "grep" }] }),
		];
		assert.deepEqual(getCurrentTools(messages).map((tool) => tool.name), ["read", "grep"]);
	});

	it("getCurrentSystemMessage appends content, patches sections and keeps the first timestamp", () => {
		const messages = [
			sys({ content: "base", sections: { docs: "d1", skills: "s1" }, toolsAdded: [{ name: "read" }] }),
			sys({ content: "patched", sections: { docs: "d2", skills: null }, timestamp: 99 }),
		];
		const merged = getCurrentSystemMessage(messages);
		assert.equal(merged.content, "base\n\npatched");
		assert.deepEqual(merged.sections, { docs: "d2" });
		assert.equal(merged.timestamp, 7, "the first system message owns the timestamp");
		assert.deepEqual((merged.toolsAdded ?? []).map((tool) => tool.name), ["read"]);
	});

	it("matches the host's helpers byte for byte where the host has them", () => {
		const messages = [
			sys({ content: "base", sections: { docs: "d1" }, toolsAdded: [{ name: "read" }, { name: "bash" }] }),
			sys({ content: [{ type: "text", text: "more" }], sections: { docs: null }, toolsRemoved: [{ name: "bash" }] }),
		];
		assert.deepEqual(localGetCurrentTools(messages), piAi.getCurrentTools(messages));
		assert.deepEqual(localGetCurrentSystemMessage(messages), piAi.getCurrentSystemMessage(messages));
		assert.equal(localContentText([{ type: "text", text: "x" }, { type: "text", text: "y" }]), piAi.contentText([{ type: "text", text: "x" }, { type: "text", text: "y" }]));
	});

	it("uses the local ports when the host carries none (omp)", () => {
		const { contentText: _a, getCurrentTools: _b, getCurrentSystemMessage: _c, ...aiWithoutTranscript } = piAi;
		__setHostForTest({ ai: aiWithoutTranscript });
		assert.equal(contentText("plain"), "plain");
		assert.deepEqual(getCurrentTools([sys({ toolsAdded: [{ name: "read" }] })]).map((tool) => tool.name), ["read"]);
		assert.equal(getCurrentSystemMessage([sys({ content: "base" })]).content, "base");
	});
});

describe("hostType", () => {
	it("takes the TypeBox facade from the host's pi-ai", () => {
		const facade = { Object: () => ({}), String: () => ({}) };
		__setHostForTest({ ai: { Type: facade } });
		assert.equal(hostType(), facade);
	});

	it("falls back to the typebox peer when the host has no facade", () => {
		__setHostForTest({ ai: {} });
		__setTypeboxFallbackForTest({ String: () => ({}) });
		assert.deepEqual(Object.keys(hostType()), ["String"]);
	});

	it("reports undefined when neither the host nor the peer is available", () => {
		__setHostForTest({ ai: {} });
		__setTypeboxFallbackForTest(undefined);
		assert.equal(hostType(), undefined);
		// ...and the AskClaude schema builder says so instead of throwing a
		// TypeError out of a missing property.
		assert.throws(() => buildAskClaudeParams({ isolated: false, allowFull: true, description: undefined, mode: "read" }), /no TypeBox facade/);
	});
});

describe("getModels", () => {
	it("uses the host root when it exports the catalog", () => {
		const models = getModels("anthropic");
		assert.ok(Array.isArray(models) && models.length > 0, "the dev dependency's catalog must resolve");
		assert.ok(models.some((model) => String(model.id).startsWith("claude-")), "and it must be the anthropic catalog");
	});

	it("falls back to the pi-ai/compat subpath when the root lacks it (upstream pi)", () => {
		const { getModels: _dropped, ...aiWithoutRootCatalog } = piAi;
		__setHostForTest({ ai: aiWithoutRootCatalog });
		const models = getModels("anthropic");
		assert.ok(Array.isArray(models) && models.length > 0, "pi-ai/compat is the upstream source");
	});

	it("reports an empty catalog instead of throwing when no source has it", () => {
		const errors = [];
		const original = console.error;
		console.error = (message) => errors.push(String(message));
		try {
			__setHostForTest({ ai: {} });
			__setCompatCatalogForTest(undefined);
			assert.deepEqual(getModels("anthropic"), []);
			assert.match(errors.join("\n"), /no anthropic model catalog from this host/);
		} finally {
			console.error = original;
			__setCompatCatalogForTest(piAi.getModels);
		}
	});
});
