/**
 * Per-directory Claude Code accounts, through the provider path: which config
 * directory each query's Claude Code child runs under, what its environment
 * carries, and what happens to the session file when a session moves between
 * accounts.
 *
 * The stakes are a wrong-but-working turn: routing a query to the launch login
 * instead of the account the directory names still produces an answer, just on
 * the wrong subscription, and a --resume against another account's directory
 * fails with "No conversation found" only once it is too late to recover the
 * conversation.
 */
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession } from "cc-session-io";
import activate, { __test } from "../src/index.js";
import { parseAccounts } from "../src/accounts.js";
import { globalConfigPath, loadAccountsConfig } from "../src/config.js";
import { forgetSessionCwd, rememberSessionCwd } from "../src/session-cwd.js";

/** The directory Claude Code uses when nothing routes the query: pi's own. */
const LAUNCH_DIR = process.env.CLAUDE_CONFIG_DIR;

const root = mkdtempSync(join(tmpdir(), "account-routing-"));
const workDir = join(root, "claude-work");
const personalDir = join(root, "claude-personal");
const workCwd = join(root, "work", "proj");
const personalCwd = join(root, "personal", "notes");
const launchCwd = join(root, "elsewhere");
const projectDir = join(root, "project");

const ACCOUNTS = {
	dirs: { work: workDir, personal: personalDir },
	paths: { [join(root, "work")]: "work", [join(root, "personal")]: "personal" },
};

/** pi's global config file, holding the routing table. */
function writeGlobalAccounts(accounts) {
	mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	writeFileSync(globalConfigPath(), JSON.stringify({ accounts }, null, 2));
}

const u = (body) => ({ role: "user", content: body, timestamp: 0 });
const a = (body) => ({ role: "assistant", content: [{ type: "text", text: body }], timestamp: 0 });
/** One completed turn behind the current one: priors the sync can rebuild from. */
const transcript = () => [u("hi"), a("hello"), u("again")];

/** activate() with a mock pi: the provider it registers plus its event handlers.
 *  Registration is deferred to session_start for any instance after the first,
 *  so `providerConfig` is read through a getter. */
function activateBridge() {
	const handlers = {};
	let providerConfig;
	activate({
		on: (name, fn) => { (handlers[name] ??= []).push(fn); },
		registerProvider: (_name, config) => { providerConfig = config; },
		registerTool: () => {},
	});
	return { handlers, get providerConfig() { return providerConfig; } };
}

/** Start a pi session the way pi does: a session_start carrying its cwd (and,
 *  in a terminal, the UI the extension notifies through). */
function startSession(bridge, sessionId, cwd, ui = null) {
	for (const fn of bridge.handlers.session_start) {
		fn({ reason: "new" }, { cwd, mode: "tui", ui, sessionManager: { getSessionId: () => sessionId }, modelRegistry: { getProvider: () => undefined } });
	}
	rememberSessionCwd(sessionId, cwd);
}

/** Run one provider turn, returning the options the SDK query was called with.
 *  The stub answers --resume with the id it was asked to resume, like Claude
 *  Code does, so the captured session id tracks the file on disk. */
async function turn(bridge, sessionId, messages) {
	let captured;
	__test.setQuery(({ options }) => {
		captured = options;
		const gen = (async function* () {
			yield { type: "system", subtype: "init", session_id: options.resume ?? "cc-fresh" };
			yield { type: "result", subtype: "success", is_error: false, result: "ok" };
		})();
		gen.interrupt = async () => {};
		gen.close = () => {};
		return gen;
	});
	await bridge.providerConfig.streamSimple(bridge.providerConfig.models[0], { messages, tools: [] }, { sessionId }).result();
	// Let the completion handler's state write land before asserting on it.
	await new Promise((resolve) => setTimeout(resolve, 10));
	return captured;
}

/** Set the routing table without activating: production reads the same block out
 *  of the global config and validates it the same way. */
function setRouter(accounts) {
	const { router, problems } = parseAccounts(accounts, root, () => true);
	assert.deepEqual(problems, [], "test routing tables must be valid");
	__test.setAccountRouter(router);
}

for (const dir of [workDir, personalDir, workCwd, personalCwd, launchCwd, projectDir]) mkdirSync(dir, { recursive: true });

let activation;
before(() => {
	writeGlobalAccounts(ACCOUNTS);
	activation = activateBridge();
	assert.ok(activation.providerConfig, "activation must register the provider");
});

afterEach(() => {
	__test.setQuery(null);
	__test.resetSharedSession();
	__test.setAccountRouter(null);
	__test.setPiUI(null);
	for (const id of ["s-work", "s-personal", "s-launch", "s-moved"]) forgetSessionCwd(id);
});

describe("account routing", () => {
	it("reads the routing table from the global config at activation", () => {
		const router = __test.getAccountRouter();
		assert.deepEqual(router.rules.map((rule) => rule.prefix), [join(root, "personal"), join(root, "work")]);
		assert.equal(router.resolve(workCwd).configDir, workDir);
		assert.deepEqual(router.accounts.map((account) => account.name).sort(), ["personal", "work"]);
	});

	// Documented promise: only the global file is read, because the router decides
	// every child's directory in a process that may serve many cwds.
	it("ignores a project config file, which would follow the wrong directory", () => {
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "claude-bridge.json"), JSON.stringify({ accounts: { dirs: { sneaky: "/sneaky" } } }));
		const cwd = process.cwd();
		try {
			process.chdir(projectDir);
			assert.deepEqual(loadAccountsConfig(), ACCOUNTS, "the global table is the only one read");
		} finally {
			process.chdir(cwd);
		}
	});

	it("runs each session as the account its cwd routes to", async () => {
		setRouter(ACCOUNTS);
		const bridge = activateBridge();
		startSession(bridge, "s-work", workCwd);
		startSession(bridge, "s-personal", personalCwd);

		const workQuery = await turn(bridge, "s-work", transcript());
		const personalQuery = await turn(bridge, "s-personal", transcript());

		assert.equal(workQuery.cwd, workCwd);
		assert.equal(workQuery.env.CLAUDE_CONFIG_DIR, workDir);
		assert.equal(personalQuery.cwd, personalCwd);
		assert.equal(personalQuery.env.CLAUDE_CONFIG_DIR, personalDir);
		assert.equal(process.env.CLAUDE_CONFIG_DIR, LAUNCH_DIR, "the process env is never rewritten");

		// Each account keeps its own session file: two conversations must not
		// collide in one directory's projects/ store.
		const workState = __test.getSharedSession("s-work");
		const personalState = __test.getSharedSession("s-personal");
		assert.equal(workState.claudeDir, workDir);
		assert.equal(personalState.claudeDir, personalDir);
		assert.ok(openSession({ sessionId: workState.sessionId, projectPath: workCwd, claudeDir: workDir }).records.length > 0);
		assert.ok(openSession({ sessionId: personalState.sessionId, projectPath: personalCwd, claudeDir: personalDir }).records.length > 0);
	});

	it("drops inherited credentials on a routed account, keeping them on the launch login", async () => {
		setRouter(ACCOUNTS);
		const bridge = activateBridge();
		startSession(bridge, "s-work", workCwd);
		startSession(bridge, "s-launch", launchCwd);

		const previousKey = process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_API_KEY = "sk-inherited";
		try {
			const routed = await turn(bridge, "s-work", transcript());
			assert.equal(routed.env.ANTHROPIC_API_KEY, undefined, "an inherited key would authenticate every account as this one");
			const launch = await turn(bridge, "s-launch", transcript());
			assert.equal(launch.env.ANTHROPIC_API_KEY, "sk-inherited", "the launch login keeps the environment pi was started with");
		} finally {
			if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = previousKey;
		}
	});

	it("keeps the launch login's behaviour for a cwd no rule matches", async () => {
		setRouter(ACCOUNTS);
		const bridge = activateBridge();
		startSession(bridge, "s-launch", launchCwd);

		const query = await turn(bridge, "s-launch", transcript());
		assert.equal(query.env.CLAUDE_CONFIG_DIR, LAUNCH_DIR);
		const state = __test.getSharedSession("s-launch");
		assert.equal(state.claudeDir, null, "no routing means no account recorded");
		assert.ok(openSession({ sessionId: state.sessionId, projectPath: launchCwd, claudeDir: LAUNCH_DIR }).records.length > 0);
	});

	it("rotates to a fresh session when a session moves to another account", async () => {
		setRouter(ACCOUNTS);
		const bridge = activateBridge();
		startSession(bridge, "s-moved", workCwd);
		await turn(bridge, "s-moved", transcript());
		const before = __test.getSharedSession("s-moved");
		assert.equal(before.claudeDir, workDir);

		// The same pi session now reports a cwd under the other account.
		rememberSessionCwd("s-moved", personalCwd);
		const query = await turn(bridge, "s-moved", [u("hi"), a("hello"), u("again"), a("more"), u("and again")]);
		const after = __test.getSharedSession("s-moved");

		assert.equal(query.env.CLAUDE_CONFIG_DIR, personalDir);
		assert.equal(after.claudeDir, personalDir);
		assert.notEqual(after.sessionId, before.sessionId, "another account's session file cannot be resumed, so the id must rotate");
		// The session it left behind stays readable: the account it belonged to was
		// not this query's to delete.
		assert.ok(openSession({ sessionId: before.sessionId, projectPath: workCwd, claudeDir: workDir }).records.length > 0, "the previous account's session file must survive the switch");
		assert.ok(openSession({ sessionId: after.sessionId, projectPath: personalCwd, claudeDir: personalDir }).records.length > 0);
	});

	it("reports a broken routing table instead of failing activation", () => {
		writeGlobalAccounts({ dirs: { work: "relative/dir" }, paths: { "/srv/work": "nope" } });
		const bridge = activateBridge();
		assert.deepEqual(__test.getAccountRouter().rules, [], "an unusable table routes nothing");
		assert.equal(__test.accountFor("/srv/work/x").configDir, null);

		const notified = [];
		const ui = { notify: (message, level) => notified.push({ message, level }) };
		startSession(bridge, "s-broken", launchCwd, ui);

		assert.equal(notified.length, 1);
		assert.equal(notified[0].level, "warning");
		assert.match(notified[0].message, /accounts\.dirs\.work: "relative\/dir" is not absolute/);
		assert.match(notified[0].message, /accounts\.paths\["\/srv\/work"\]: no account named "nope"/);
	});
});

after(() => rmSync(root, { recursive: true, force: true }));
