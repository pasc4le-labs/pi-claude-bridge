/**
 * The account routing table: which Claude Code config directory a query runs
 * as. Pure logic, so the table is pinned here rather than through a query.
 *
 * The failure this guards against is silent: a rule that does not match
 * anything leaves the query on the launch login, which looks like routing
 * working (Claude answers) until the user notices the wrong subscription
 * paying for it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
	accountClaudeDir,
	accountEnv,
	accountLabel,
	CREDENTIAL_ENV_VARS,
	EMPTY_ACCOUNT_ROUTER,
	LAUNCH_ACCOUNT,
	parseAccounts,
	RESERVED_ACCOUNT_NAME,
} from "../src/accounts.js";

const HOME = "/home/tester";
/** Every configured directory exists unless the test says otherwise. */
const allDirs = () => true;

function router(raw, dirExists = allDirs) {
	return parseAccounts(raw, HOME, dirExists);
}

describe("parseAccounts", () => {
	it("treats a missing block as no routing at all", () => {
		for (const raw of [undefined, null]) {
			const { router: r, problems } = router(raw);
			assert.deepEqual(problems, []);
			assert.equal(r, EMPTY_ACCOUNT_ROUTER);
			assert.equal(r.resolve("/srv/work"), LAUNCH_ACCOUNT);
		}
	});

	it("routes by longest matching prefix", () => {
		const { router: r, problems } = router({
			dirs: { work: "/home/tester/.claude-work", client: "/home/tester/.claude-client" },
			paths: { "/srv/work": "work", "/srv/work/client-a": "client" },
		});
		assert.deepEqual(problems, []);
		assert.equal(r.resolve("/srv/work/client-a/repo").name, "client");
		assert.equal(r.resolve("/srv/work/other").name, "work");
		assert.equal(r.resolve("/srv/work").name, "work");
		assert.equal(r.resolve("/srv/workshop").name, "default", "/srv/workshop is not under /srv/work");
		assert.equal(r.resolve("/elsewhere").name, "default");
	});

	it("ignores a trailing separator on a prefix", () => {
		const { router: r } = router({ dirs: { work: "/w" }, paths: { "/srv/work/": "work" } });
		assert.equal(r.resolve("/srv/work/app").name, "work");
		assert.equal(r.resolve("/srv/workshop").name, "default");
	});

	it("expands ~ in dirs and in prefixes for the current user only", () => {
		const { router: r, problems } = router({
			dirs: { personal: "~/.claude-personal" },
			paths: { "~/personal": "personal" },
		});
		assert.deepEqual(problems, []);
		assert.equal(r.accounts[0].configDir, join(HOME, ".claude-personal"));
		assert.equal(r.resolve(join(HOME, "personal", "notes")).name, "personal");
		assert.equal(r.resolve("/root/personal").name, "default");
	});

	it("keeps `default` for the launch login, in both roles", () => {
		const { router: r, problems } = router({
			dirs: { default: "/nope", work: "/w" },
			paths: { "/srv/work": "work", "/srv/personal": "default" },
		});
		assert.equal(problems.length, 1);
		assert.match(problems[0], /accounts\.dirs\.default is reserved/);
		assert.deepEqual(
			r.accounts.map((a) => a.name),
			["work"],
			"the launch account is never a configured account",
		);
		// A rule may still name it: "route this back to the login pi started with".
		assert.equal(r.resolve("/srv/personal/proj"), LAUNCH_ACCOUNT);
		assert.equal(r.resolve("/srv/personal/proj").configDir, null);
	});

	it("drops an unusable dir with a message instead of throwing", () => {
		const { router: r, problems } = router({
			dirs: { relative: "work/claude", empty: "  ", tilde: "~/.claude-tilde", work: "/srv/claude-work" },
			paths: { "/srv/relative": "relative", "/srv/work": "work" },
		});
		assert.equal(r.accounts.length, 2, "relative and empty are dropped, tilde and work survive");
		assert.match(problems.join("\n"), /accounts\.dirs\.relative: "work\/claude" is not absolute/);
		assert.match(problems.join("\n"), /accounts\.dirs\.empty must be a non-empty directory path/);
		// The rule pointing at a dropped account falls with it: routing a
		// directory to a name that does not resolve would otherwise run it on
		// the launch login silently.
		assert.match(problems.join("\n"), /accounts\.paths\["\/srv\/relative"\]: no account named "relative"/);
		assert.equal(r.resolve("/srv/relative/x").name, "default");
		assert.equal(r.resolve("/srv/work/x").name, "work");
	});

	it("warns about a directory that does not exist, but keeps the account", () => {
		const { router: r, problems } = router(
			{ dirs: { work: "/srv/claude-work" }, paths: { "/srv/work": "work" } },
			(path) => path !== "/srv/claude-work",
		);
		assert.match(problems.join("\n"), /accounts\.dirs\.work: \/srv\/claude-work does not exist — log in there first: CLAUDE_CONFIG_DIR="\/srv\/claude-work" claude auth login/);
		assert.equal(r.resolve("/srv/work/x").name, "work", "a directory created later must not reroute to the launch login");
	});

	// Dirs without rules is the silent version of the same mistake: the table
	// looks configured and can never match anything.
	it("reports accounts that no rule can ever select", () => {
		const { router: r, problems } = router({ dirs: { work: "/srv/claude-work" } });
		assert.match(problems.join("\n"), /accounts\.dirs defines 1 account but accounts\.paths has no rules/);
		assert.equal(r.resolve("/srv/claude-work/x").name, "default", "an account's own directory is not a rule");
		// Not reported when there is nothing to route: an empty or absent block is
		// the pre-accounts configuration.
		assert.deepEqual(router({ dirs: {} }).problems, []);
		assert.deepEqual(router(undefined).problems, []);
	});

	it("keeps the first of two rules that normalize to the same prefix", () => {
		const { router: r, problems } = router({
			dirs: { a: "/a", b: "/b" },
			paths: { "/srv/work": "a", "/srv/work/": "b" },
		});
		assert.equal(r.rules.length, 1);
		assert.equal(r.resolve("/srv/work/x").name, "a");
		assert.match(problems.join("\n"), /duplicate prefix \/srv\/work — keeping the first rule/);
	});

	it("survives a malformed block", () => {
		assert.deepEqual(router("nope").problems, ["accounts must be an object with `dirs` and/or `paths` — ignoring it"]);
		assert.equal(router(["nope"]).router, EMPTY_ACCOUNT_ROUTER);
		assert.match(router({ dirs: "nope" }).problems.join("\n"), /accounts\.dirs must be an object/);
		assert.match(router({ paths: ["/srv/work"] }).problems.join("\n"), /accounts\.paths must be an object/);
		assert.match(router({ paths: { "/srv/work": 7 } }).problems.join("\n"), /accounts\.paths\["\/srv\/work"\] must name an account/);
	});
});

describe("accountEnv", () => {
	it("leaves the launch account's environment untouched, by identity", () => {
		const base = { PATH: "/bin", CLAUDE_CONFIG_DIR: "/srv/claude-launch", ANTHROPIC_API_KEY: "sk-launch" };
		const env = accountEnv(base, LAUNCH_ACCOUNT);
		assert.equal(env, base, "the launch path must not copy or edit the process env");
	});

	it("points a routed account at its directory", () => {
		const base = { PATH: "/bin", CLAUDE_CONFIG_DIR: "/srv/claude-launch" };
		const env = accountEnv(base, { name: "work", configDir: "/srv/claude-work" });
		assert.equal(env.CLAUDE_CONFIG_DIR, "/srv/claude-work");
		assert.equal(env.PATH, "/bin");
		assert.equal(base.CLAUDE_CONFIG_DIR, "/srv/claude-launch", "the input env is never mutated");
	});

	it("drops inherited credentials, which would otherwise win over the account's login", () => {
		const base = { CLAUDE_CONFIG_DIR: "/srv/claude-launch" };
		for (const key of CREDENTIAL_ENV_VARS) base[key] = "inherited";
		const env = accountEnv(base, { name: "work", configDir: "/srv/claude-work" });
		for (const key of CREDENTIAL_ENV_VARS) {
			assert.equal(env[key], undefined, `${key} would authenticate every account as the launch login`);
		}
		assert.equal(env.CLAUDE_CONFIG_DIR, "/srv/claude-work");
	});
});

describe("accountClaudeDir", () => {
	it("uses the account's directory when it has one, else the launch directory", () => {
		assert.equal(accountClaudeDir({ name: "work", configDir: "/srv/claude-work" }), "/srv/claude-work");
		assert.equal(accountClaudeDir(LAUNCH_ACCOUNT, "/srv/claude-launch"), "/srv/claude-launch");
		assert.equal(accountClaudeDir(LAUNCH_ACCOUNT), process.env.CLAUDE_CONFIG_DIR, "the launch account tracks the process env, set or unset");
	});
});

describe("accountLabel", () => {
	it("names the launch account and shows the directory of a routed one", () => {
		assert.equal(accountLabel(LAUNCH_ACCOUNT), "default");
		assert.equal(accountLabel({ name: "work", configDir: "/srv/claude-work" }), "work (/srv/claude-work)");
	});
});

describe("reserved name", () => {
	it("is exported, since the config file cannot define it", () => {
		assert.equal(RESERVED_ACCOUNT_NAME, "default");
	});
});
