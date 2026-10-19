/**
 * Per-directory Claude Code accounts.
 *
 * An "account" here is nothing but a Claude Code config directory — the same
 * thing CLAUDE_CONFIG_DIR points Claude Code at, holding one login. The bridge
 * never logs in, and never reads, writes or copies credentials: it only picks
 * which directory each Claude Code subprocess runs against, from the session's
 * cwd. Signing in is the user's job, done with the same variable:
 *
 *   CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude auth login
 *
 * Config (the `accounts` block, global config file):
 *
 *   "accounts": {
 *     "dirs": {
 *       "work": "~/.claude-work",
 *       "personal": "~/.claude-personal"
 *     },
 *     "paths": {
 *       "/srv/work": "work",
 *       "/srv/work/client-a": "client-a",
 *       "~/personal": "personal"
 *     }
 *   }
 *
 * Routing rules, all deterministic:
 *  - The longest matching prefix wins, so a nested rule can override its parent.
 *  - A prefix matches on a path boundary: `/srv/work` matches `/srv/work` and
 *    `/srv/work/app`, but never `/srv/workshop`. A trailing separator in the
 *    config is ignored.
 *  - No match → the launch account: `process.env.CLAUDE_CONFIG_DIR` is left
 *    exactly as pi was started with it (and Claude Code's own default when that
 *    is unset). A config without an `accounts` block therefore behaves exactly
 *    as it did before this existed.
 *  - The name `default` is reserved for the launch account, so a rule can route
 *    a directory back to the login pi was started with.
 */

import { existsSync, statSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, sep } from "path";

/** A Claude Code account. `configDir: null` is the launch account — whatever
 *  login pi itself was started with. */
export interface Account {
	readonly name: string;
	readonly configDir: string | null;
}

/** The login pi was started with: `process.env.CLAUDE_CONFIG_DIR`, or Claude
 *  Code's own default (`~/.claude`) when that is unset. */
export const LAUNCH_ACCOUNT: Account = Object.freeze({ name: "default", configDir: null });

/** Reserved: a `dirs` entry may not define it, a rule may name it. */
export const RESERVED_ACCOUNT_NAME = "default";

export interface AccountRule {
	readonly prefix: string;
	readonly account: Account;
}

export interface AccountRouter {
	/** Configured (non-launch) accounts, in config order. */
	readonly accounts: readonly Account[];
	/** Every rule, longest prefix first. */
	readonly rules: readonly AccountRule[];
	/** The account a query in `cwd` runs as; the launch account when nothing matches. */
	resolve(cwd: string): Account;
}

/** No accounts configured: every query is the launch account. */
export const EMPTY_ACCOUNT_ROUTER: AccountRouter = Object.freeze({
	accounts: [],
	rules: [],
	resolve: () => LAUNCH_ACCOUNT,
});

export interface AccountsConfig {
	/** Account name → Claude Code config directory. */
	dirs?: Record<string, string>;
	/** cwd prefix → account name. */
	paths?: Record<string, string>;
}

export interface ParsedAccounts {
	readonly router: AccountRouter;
	/** Human-readable validation failures, for the activation log. Never throws:
	 *  a broken routing table must not take the extension down. */
	readonly problems: readonly string[];
}

/**
 * Env vars holding credentials for the login pi was started with.
 *
 * A routed account drops them: an env token wins over the config directory's
 * stored login, so inheriting one would run every account as that single login
 * — the routing would look like it works while nothing switched. The launch
 * account keeps them untouched (that is the point of the launch account).
 */
export const CREDENTIAL_ENV_VARS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

/** The Claude Code config directory a query's files live under: the account's
 *  own when it has one, else the launch directory (unset → Claude Code decides). */
export function accountClaudeDir(account: Account, launchDir = process.env.CLAUDE_CONFIG_DIR): string | undefined {
	return account.configDir ?? launchDir;
}

/** The env for a Claude Code child running as `account`. Never mutates `base`. */
export function accountEnv(base: NodeJS.ProcessEnv, account: Account): NodeJS.ProcessEnv {
	if (account.configDir === null) return base;
	const env: NodeJS.ProcessEnv = { ...base, CLAUDE_CONFIG_DIR: account.configDir };
	for (const key of CREDENTIAL_ENV_VARS) delete env[key];
	return env;
}

/** One-line account tag for debug lines. */
export function accountLabel(account: Account): string {
	return account.configDir === null ? "default" : `${account.name} (${account.configDir})`;
}

/** `~`/`~user`-free expansion: only the current user's home is supported, which
 *  is all a per-machine routing table needs. */
export function expandHome(value: string, home: string): string {
	if (value === "~") return home;
	if (value.startsWith(`~${sep}`) || (sep !== "/" && value.startsWith("~/"))) return join(home, value.slice(2));
	return value;
}

/** Drop trailing separators so `/srv/work/` and `/srv/work` are one prefix —
 *  but keep a bare root usable. */
function stripTrailingSep(prefix: string): string {
	let out = prefix;
	while (out.length > 1 && out.endsWith(sep)) out = out.slice(0, -1);
	return out;
}

/** Does `cwd` sit at or under `prefix`, on a path boundary? */
function matchesPrefix(cwd: string, prefix: string): boolean {
	if (cwd === prefix) return true;
	if (!cwd.startsWith(prefix)) return false;
	return cwd.startsWith(`${prefix}${sep}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Build a router, dropping rules whose prefix normalizes to a duplicate —
 *  including one that only a duplicate produces, so the table stays a function
 *  of the config rather than of key order. */
function buildRouter(accounts: readonly Account[], rules: readonly AccountRule[], problems: string[]): AccountRouter {
	const sorted = [...rules].sort((a, b) => b.prefix.length - a.prefix.length);
	const kept: AccountRule[] = [];
	for (const rule of sorted) {
		// Equal lengths sort stably, so the first-declared of a duplicated
		// (same-length) prefix is the one kept.
		if (kept.some((k) => k.prefix === rule.prefix)) {
			problems.push(`accounts.paths: duplicate prefix ${rule.prefix} — keeping the first rule for it`);
			continue;
		}
		kept.push(rule);
	}
	return {
		accounts,
		rules: kept,
		resolve(cwd: string): Account {
			for (const rule of kept) if (matchesPrefix(cwd, rule.prefix)) return rule.account;
			return LAUNCH_ACCOUNT;
		},
	};
}

/**
 * Validate a raw `accounts` block into a router. Everything invalid is dropped
 * with a problem string instead of throwing — a typo in a routing table must
 * not take the extension down, and the activation log names it.
 *
 * `dirExists` is injected so tests can exercise the missing-directory warning
 * without touching a real filesystem.
 */
export function parseAccounts(
	raw: unknown,
	home = homedir(),
	dirExists: (path: string) => boolean = isDirectory,
): ParsedAccounts {
	const problems: string[] = [];
	if (raw === undefined || raw === null) return { router: EMPTY_ACCOUNT_ROUTER, problems };
	if (!isPlainObject(raw)) {
		problems.push("accounts must be an object with `dirs` and/or `paths` — ignoring it");
		return { router: EMPTY_ACCOUNT_ROUTER, problems };
	}

	const accounts = new Map<string, Account>([[RESERVED_ACCOUNT_NAME, LAUNCH_ACCOUNT]]);
	const rawDirs = raw.dirs;
	if (rawDirs !== undefined) {
		if (!isPlainObject(rawDirs)) {
			problems.push("accounts.dirs must be an object of account name → config directory");
		} else {
			for (const [name, value] of Object.entries(rawDirs)) {
				if (!name.trim()) {
					problems.push("accounts.dirs has an empty account name — skipping it");
					continue;
				}
				if (name === RESERVED_ACCOUNT_NAME) {
					problems.push(`accounts.dirs.${name} is reserved for the login pi was started with — ignoring it`);
					continue;
				}
				if (typeof value !== "string" || !value.trim()) {
					problems.push(`accounts.dirs.${name} must be a non-empty directory path — skipping it`);
					continue;
				}
				const dir = stripTrailingSep(expandHome(value.trim(), home));
				if (!isAbsolute(dir)) {
					problems.push(`accounts.dirs.${name}: "${value}" is not absolute after ~ expansion ("${dir}") — skipping it`);
					continue;
				}
				if (!dirExists(dir)) {
					// Keep the account: the directory may be created (and logged
					// in) later, and dropping it would silently reroute its
					// directories to the launch login.
					problems.push(`accounts.dirs.${name}: ${dir} does not exist — log in there first: CLAUDE_CONFIG_DIR="${dir}" claude auth login`);
				}
				accounts.set(name, { name, configDir: dir });
			}
		}
	}

	const rules: AccountRule[] = [];
	const rawPaths = raw.paths;
	if (rawPaths !== undefined) {
		if (!isPlainObject(rawPaths)) {
			problems.push("accounts.paths must be an object of cwd prefix → account name");
		} else {
			for (const [key, value] of Object.entries(rawPaths)) {
				if (typeof value !== "string") {
					problems.push(`accounts.paths["${key}"] must name an account — skipping it`);
					continue;
				}
				const account = accounts.get(value);
				if (!account) {
					problems.push(`accounts.paths["${key}"]: no account named "${value}" (known: ${[...accounts.keys()].join(", ")}) — skipping it`);
					continue;
				}
				const prefix = stripTrailingSep(expandHome(key.trim(), home));
				if (!isAbsolute(prefix)) {
					problems.push(`accounts.paths["${key}"]: "${key}" is not an absolute path after ~ expansion — skipping it`);
					continue;
				}
				rules.push({ prefix, account });
			}
		}
	}

	const configured = [...accounts.values()].filter((account) => account !== LAUNCH_ACCOUNT);
	// Accounts without rules is the silent half of the same mistake: the table
	// looks configured and routes nothing. Reported, not fatal — dirs alone is
	// legal, and a rule added later must not require a code change.
	if (configured.length > 0 && rules.length === 0) {
		problems.push(
			`accounts.dirs defines ${configured.length} account${configured.length === 1 ? "" : "s"} but accounts.paths has no rules — every directory still runs on the launch login (add e.g. "paths": { "/srv/work": "work" } inside the "accounts" block)`,
		);
	}
	return { router: buildRouter(configured, rules, problems), problems };
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return existsSync(path);
	}
}
