// User-facing extension config. Loaded once at extension registration from
// the global agent dir (getAgentDir(), e.g. ~/.pi/agent/claude-bridge.json)
// and the project Pi config directory, project overriding global. Missing or
// unparseable files are ignored (error to console.error, empty object
// returned) so the extension always starts.

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { AccountsConfig } from "./accounts.js";

export interface Config {
	/** Date (YYYY-MM-DD) the one-time startup notice was shown. Written by the extension, not the user. */
	startupNoticeShown?: string;
	/** Date (YYYY-MM-DD) the AskClaude deprecation notice was shown. Written by the extension, not the user. */
	askClaudeDeprecationShown?: string;
	askClaude?: {
		enabled?: boolean;
		name?: string;
		label?: string;
		description?: string;
		defaultMode?: "full" | "read" | "none";
		defaultIsolated?: boolean;
		allowFullMode?: boolean;
		appendSkills?: boolean;
	};
	/** Per-directory Claude Code accounts. Read from the GLOBAL config file
	 *  only, via loadAccountsConfig(), and validated by accounts.ts — loadConfig
	 *  does not merge it, so a project file cannot reroute a machine. */
	accounts?: AccountsConfig;
	/** Low-level Claude Agent SDK plumbing. Most users won't need these. */
	provider?: {
		strictMcpConfig?: boolean;
		autoMemoryEnabled?: boolean;
		pathToClaudeCodeExecutable?: string;
		// Subscription plan tier. Setting to "max" enables Opus 4.6 at 1M context
		plan?: "pro" | "max";
		// Set to true to opt into metered 1M context usage ("extra usage" in
		// Anthropic billing). Enables Sonnet 4.6 [1m] on every plan and Opus 4.6
		// [1m] on Pro.
		longContextExtraUsage?: boolean;
		// Model ids (e.g. "claude-future-9") whose declared 1M context Claude Code
		// does not actually serve; pins them to the bare id at 200K.
		forceTwoHundredK?: string[];
	};
}

export function tryParseJson(path: string): Partial<Config> {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch (e) {
		console.error(`claude-bridge: failed to parse ${path}: ${e}`);
		return {};
	}
}

export function claudeCodeSettings(provider: Config["provider"] = {}): { autoMemoryEnabled: boolean } {
	return { autoMemoryEnabled: provider.autoMemoryEnabled ?? false };
}

export function globalConfigPath(): string {
	return join(getAgentDir(), "claude-bridge.json");
}

/** The global config's raw `accounts` block: per-directory Claude Code routing.
 *
 *  Global-only by design. One pi process serves sessions from several
 *  directories (a host like pi-web drives every session off one process cwd),
 *  while the router this feeds decides each Claude Code child's
 *  CLAUDE_CONFIG_DIR — so reading a project-relative file would apply the
 *  routing table of whichever directory happened to start the process.
 *
 *  Returned unvalidated: the caller parses it (see accounts.ts), because a
 *  routing table with a typo has to be reported, not silently ignored. */
export function loadAccountsConfig(): unknown {
	return tryParseJson(globalConfigPath()).accounts;
}

/** Fields that belong INSIDE `accounts` but that a hand-written config puts at
 *  the top level. A misplaced block is not a typo the parser can catch — the
 *  table reads as absent, so every directory silently falls back to the launch
 *  login while nothing looks wrong. Named here so the caller can warn. */
const MISPLACED_ACCOUNT_KEYS = ["paths", "dirs"] as const;

/** Account-routing keys found at the top level of the global config, where they
 *  do nothing. Empty when the block is where it belongs (or absent). */
export function misplacedAccountsKeys(): string[] {
	const raw = tryParseJson(globalConfigPath());
	return MISPLACED_ACCOUNT_KEYS.filter((key) => key in raw && !(key in (raw.accounts ?? {})));
}

/** Record today's date in the global config so the startup notice shows once, preserving every
 *  other field. Returns the config path for display either way.
 *
 *  Parses directly rather than through tryParseJson, which reports an unparseable file as `{}`:
 *  spreading that would replace a user's whole config with just this marker the first time they
 *  leave a trailing comma in it. Losing the notice is the cheaper failure, so the write is
 *  skipped and the notice simply shows again next session. */
export function markStartupNoticeShown(): string {
	const path = globalConfigPath();
	let existing: Partial<Config> = {};
	if (existsSync(path)) {
		try {
			existing = JSON.parse(readFileSync(path, "utf-8"));
		} catch (e) {
			console.error(`claude-bridge: leaving ${path} alone, it does not parse: ${e}`);
			return path;
		}
	}
	// en-CA renders YYYY-MM-DD in local time; toISOString() would report UTC.
	const next = { ...existing, startupNoticeShown: new Date().toLocaleDateString("en-CA") };
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
	return path;
}

/** Record when the AskClaude deprecation notice was shown in the global config, preserving every
 *  other field. Returns the config path either way. */
export function markAskClaudeDeprecationNoticeShown(): string {
	const path = globalConfigPath();
	let existing: Partial<Config> = {};
	if (existsSync(path)) {
		try {
			existing = JSON.parse(readFileSync(path, "utf-8"));
		} catch (e) {
			console.error(`claude-bridge: leaving ${path} alone, it does not parse: ${e}`);
			return path;
		}
	}
	// Match startupNoticeShown's local YYYY-MM-DD date format.
	const next = { ...existing, askClaudeDeprecationShown: new Date().toLocaleDateString("en-CA") };
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
	return path;
}

export function loadConfig(cwd: string): Config {
	const global = tryParseJson(globalConfigPath());
	const project = tryParseJson(join(cwd, CONFIG_DIR_NAME, "claude-bridge.json"));
	return {
		startupNoticeShown: project.startupNoticeShown ?? global.startupNoticeShown,
		askClaudeDeprecationShown: project.askClaudeDeprecationShown ?? global.askClaudeDeprecationShown,
		askClaude: { ...global.askClaude, ...project.askClaude },
		provider: { ...global.provider, ...project.provider },
	};
}
