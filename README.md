# pi-claude-bridge

[![npm version](https://img.shields.io/npm/v/@pasc4le-labs/pi-claude-bridge)](https://www.npmjs.com/package/@pasc4le-labs/pi-claude-bridge)

> **Fork.** This is a fork of
> [elidickinson/pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge),
> maintained by [pasc4le-labs](https://github.com/pasc4le-labs), and it adds
> exactly one feature — **per-directory Claude accounts**: a list of Claude Code
> config directories plus cwd-prefix rules, so a session in `/srv/work` runs on
> one login and one in `~/personal` on another, at the same time (see
> [Claude accounts per directory](#claude-accounts-per-directory)).
> It is published to npm under the scope this org owns
> ([`@pasc4le-labs/pi-claude-bridge`](https://www.npmjs.com/package/@pasc4le-labs/pi-claude-bridge)),
> because the unscoped name belongs to upstream. Everything else below is
> upstream's behaviour, and upstream remains the place to report bugs that are
> not about accounts.

Pi extension that integrates Claude Code via the [Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript). Originally based on [claude-agent-sdk-pi](https://github.com/prateekmedia/claude-agent-sdk-pi) by Prateek Sunal.

1. **Provider** — Use Opus/Sonnet/Haiku as models in pi, with all tool calls flowing through pi's TUI
2. **AskClaude tool** — Delegate tasks or questions to Claude Code when using another provider
3. **Per-directory accounts** *(fork)* — Run each session as the Claude Code login its cwd names


**FYI:** Anthropic [announced and then unannounced](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) a change to how you would be billed for tools that use the Agent SDK like this one. It currently uses your regular subscription quota just like Claude Code.

<p>
<a href="assets/claude-bridge1.png"><img src="assets/claude-bridge1.png" width="49%"></a>&nbsp;
<a href="assets/claude-bridge2.png"><img src="assets/claude-bridge2.png" width="49%"></a>
</p>

## Install

```
pi install npm:@pasc4le-labs/pi-claude-bridge
```

Or straight from the repository (`@dev` tracks integration work):

```
pi install git:github.com/pasc4le-labs/pi-claude-bridge@main
```

Requires pi 0.86.1 or newer.

## Provider

Use `/model` to select any Claude model in pi-ai's catalog, e.g. `claude-bridge/claude-fable-5-1`, `claude-bridge/claude-opus-5`, or `claude-bridge/claude-haiku-4-5`.

Behind the scenes, pi's tools are bridged to Claude Code but everything works like normal in pi. Bash commands get Claude Code's 120-second default timeout since pi's bash has none. Skills are forwarded to Claude Code's system prompt, and steering mid-turn reaches Claude at the next tool boundary.

The model list comes from pi-ai's Anthropic catalog automatically — when pi-ai adds a new Claude model, it appears in `/model` after updating the package, no bridge update needed. Dated snapshot ids (e.g. `claude-opus-4-5-20251101`) are not shown.

**1M Context:** Fable 5/5.1, Opus 5.5/5/4.8/4.7, and Sonnet 5.5/5 get 1M context. Opus 4.6 gets 1M only on a Max plan or with Extra Usage, and Sonnet 4.6 only with Extra Usage — set `provider.plan` and/or `provider.longContextExtraUsage` as described in [Configuration](#configuration).

## AskClaude Tool

**Deprecated:** AskClaude is an opt-in legacy tool and may be removed in a future release. You should set `askClaude.enabled` to `true` (see [Configuration](#configuration)) to use it. You can recreate similar functionality with one of the many Pi subagent extensions.

## Configuration

Config: `~/.pi/agent/claude-bridge.json` (global) or the project Pi config directory, usually `.pi/claude-bridge.json` (project; merged over global).

```json
{
  "askClaude": {
    "enabled": true,
    "allowFullMode": true,
    "defaultIsolated": false,
    "description": "Custom tool description override"
  },
  "provider": {
    "plan": "max",
    "longContextExtraUsage": false,
    "strictMcpConfig": true,
    "pathToClaudeCodeExecutable": "/home/you/.nix-profile/bin/claude"
  }
}
```

`askClaude`:
- `enabled` — register the AskClaude tool (default `false`). If it's unset, the startup notice below points this out once.
- `name` — override the tool's pi-side name (default `"AskClaude"`)
- `label` — override the TUI label (default `"Ask Claude Code"`)
- `description` — override the tool description. Default when `allowFullMode: true`: *"Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories), or to autonomously handle a task. Defaults to read-only mode — use full mode when the user wants to delegate a task that requires changes. Prefer to handle straightforward tasks yourself."*
- `defaultMode` — `"read"` (default), `"none"`, or `"full"`
- `defaultIsolated` — start each call in a fresh session (default `false`)
- `allowFullMode` — allow `mode: "full"`; set `false` to lock it out
- `appendSkills` — forward pi's skills block into the system prompt (default `true`)

`provider`:
- `plan` (default `"pro"`) — set to `"max"` if you have a Max (or Team Premium/Enterprise) Anthropic plan. This enables Opus with 1M context.
- `longContextExtraUsage` — set to `true` to enable 1M context models even if they cost money through Extra Usage on your plan. It enables Sonnet 4.6 with 1M on every plan and Opus 4.6 with 1M on Pro. Not needed for Opus 4.7 or 4.8.
- `forceTwoHundredK` — array of model ids to pin to 200K context (bare id, no `[1m]` suffix). Use if pi-ai declares a model at 1M but Claude Code won't serve it on your plan.
- `strictMcpConfig` — block MCP servers from `~/.claude.json` / `.mcp.json` (default `true`). Cloud MCP (Gmail/Drive via claude.ai OAuth) is always blocked.
- `autoMemoryEnabled` — enable Claude Code's auto-memory system (default `false`)
- `pathToClaudeCodeExecutable` — path to the `claude` binary. Useful if your OS/filesystem has the SDK's bundled musl/glibc binaries in a place where they can't run. For example, with Nix you can set the binary to e.g. `"/home/you/.nix-profile/bin/claude"`.


**Notices:** the startup notice points out when `provider.plan` is unset and records `startupNoticeShown` in the global config. There's also a deprecation notice on first use of AskClaude that records its display date as `askClaudeDeprecationShown`.

`accounts` *(fork-only)* — the per-directory routing table, read from the global
config file only; see [Claude accounts per directory](#claude-accounts-per-directory).

**Extension providers and models.json:** pi's `modelOverrides` in `~/.pi/agent/models.json` do not currently apply to extension-registered providers (like claude-bridge). Overriding `contextWindow` or other fields requires editing `src/models.ts` directly — to pin a model to 200K, use `provider.forceTwoHundredK` instead.

## Claude accounts per directory

*Fork-only feature.* Run different Claude Code logins side by side, chosen by the
directory a session runs in: `/srv/work/**` on a work subscription, `~/personal/**`
on a personal one, anything unmatched on the login pi was started with.

Nothing is signed in for you — an account is only a Claude Code config directory
(`CLAUDE_CONFIG_DIR`), so create and log into one first, the same way you would
for Claude Code on its own:

```sh
CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude auth login
```

Then list the directories and the prefixes that select them in the **global**
config file (`~/.pi/agent/claude-bridge.json`):

```json
{
  "accounts": {
    "dirs": {
      "work": "~/.claude-work",
      "client": "~/.claude-client-a",
      "personal": "~/.claude-personal"
    },
    "paths": {
      "/srv/work": "work",
      "/srv/work/client-a": "client",
      "~/personal": "personal"
    }
  }
}
```

Routing rules:

- The **longest matching prefix** wins, so a nested rule overrides its parent
  (`/srv/work/client-a` beats `/srv/work`).
- A prefix matches on a **path boundary**: `/srv/work` matches `/srv/work` and
  `/srv/work/app`, never `/srv/workshop`. A trailing `/` in the config is
  ignored.
- No match → the launch account.
- `default` is reserved for the launch account, so a rule can route a directory
  back to it (`"/srv/scratch": "default"`).

The **launch account** is the login pi itself was started with: it keeps
`CLAUDE_CONFIG_DIR` exactly as you set it (Claude Code's own `~/.claude` when
unset) and keeps any `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` /
`ANTHROPIC_AUTH_TOKEN` from the environment. A **routed account** gets its own
directory and drops those three variables: an env token wins over a config
directory's stored login, so inheriting one would run every account as that
single login while looking like routing worked.

Details worth knowing:

- **Global config only.** A project `.pi/claude-bridge.json` cannot reroute a
  machine: one pi process serves sessions from several directories (pi-web
  drives every session off one process cwd), so the table is read once per
  process, from the global file. Restart pi after editing it.
- **Per session, not per process.** Two sessions in different directories run
  under different logins at the same time, each keeping its session files under
  its own `<config dir>/projects/…`.
- **Moving between accounts rotates.** If a session's cwd moves to another
  account, the next turn starts a fresh Claude Code session there (another
  config directory cannot `--resume` this one's file) and the old session file
  is left where it is, so moving back still resumes it.
- **Compaction and AskClaude follow the account.** Compaction/branch-summary
  queries run as the conversation's account; AskClaude runs as the account of
  the session that called it.
- **Bad entries are reported, never fatal.** A missing directory, a relative
  path, a rule naming an unknown account or an unparseable `accounts` block is
  written to the log at startup and shown as a TUI warning; the affected
  directories fall back to the launch account. Two silent shapes are named
  explicitly: `dirs` without any `paths` rule ("defines N accounts but
  accounts.paths has no rules"), and a `paths`/`dirs` block written at the top
  level of the file instead of inside `accounts` — both parse fine and route
  nothing, so the only other symptom would be Claude answering on the wrong
  subscription.
- **Debugging:** `CLAUDE_BRIDGE_DEBUG=1` logs the table at activation and the
  account of every query (`account=work (/home/you/.claude-work)`), and every
  session-rebuild line names the account it moved between.

## Tests

`npm run test:unit` for offline tests. `npm test` adds integration tests that hit APIs; set `CLAUDE_BRIDGE_TESTING_ALT_MODEL` in `.env.test` for the alt-provider smoke test.

Integration tests spawn real `pi` and Claude Code subprocesses and need write access to `~/.claude` — a sandbox that blocks it makes `--resume` fail with `No conversation found with session ID`.

## Running under oh-my-pi (omp)

This extension loads under [oh-my-pi](https://www.npmjs.com/package/oh-my-pi) as well as
upstream pi. omp serves `@earendil-works/pi-*` imports from its own bundled packages
through a legacy shim, and that shim is missing two symbols upstream pi exports
(`formatSkillsForPrompt`, `keyHint`) and does not carry the `pi-ai/compat` subpath.
A static named import of any of those is a *load-time* failure — the extension never
starts — so every host symbol this extension needs is read through a namespace with a
local fallback in `src/pi-host.ts`:

| Symbol | Upstream pi | omp |
|---|---|---|
| `formatSkillsForPrompt` | host formatter | local port of it, identical output |
| `keyHint` | host hint | host pi-tui's `keyHint`, else the plain description |
| `contentText`, `getCurrentTools`, `getCurrentSystemMessage` | host helpers | local ports (omp's pi-ai has none of the three) |
| `getModels("anthropic")` | `pi-ai/compat` subpath | pi-ai root (`getModels` → `getBundledModels`) |
| `Type` (TypeBox) | pi-ai root | pi-ai root (omp's facade), else the `typebox` peer |

Nothing else changes: the provider, per-directory accounts, and the AskClaude tool
behave the same on both hosts. Install with omp's own package command, e.g.
`omp plugin install @pasc4le-labs/pi-claude-bridge` (or whatever your omp build calls it).

## Debugging

Set `CLAUDE_BRIDGE_DEBUG=1` to enable debug output:

- **Bridge log** at `claude-bridge.log` in pi's agent dir (`PI_CODING_AGENT_DIR`, default `~/.pi/agent`) — provider calls, session sync decisions, tool results, CC stderr. Override location with `CLAUDE_BRIDGE_DEBUG_PATH`.
- **Per-query CC CLI logs** at `cc-cli-logs/<timestamp>-<tag>-<seq>.log` in the same directory — the subprocess's own debug stream; tag is `provider` or `askclaude`. Shows CC's view of session loading, API requests, and tool calls.

When filing a bug about a session-resume failure (e.g. "No conversation found"), the most useful attachments are the `syncResult:` lines from the bridge log plus the matching `cc-cli-logs/` file for the failing query.

## Compatibility with other extensions

### Which injection routes reach Claude Code

The bridge forwards pi's structured parts — project context files, skills, custom prompt, appended instructions, and custom prompt sections (`systemPromptOptions.sections`) — and drops the rest. Measured against the request body (`diag/capture-proxy.mjs`):

| Route | Reaches Claude Code |
|---|---|
| `before_agent_start` -> `message` | Yes, as literal prompt text in the user turn |
| `context` editing the last user message | Yes, as literal prompt text |
| `--append-system-prompt` | Yes, with pi's appended instructions |
| `context_with_system` editing the system message | Yes when it wraps pi's prompt; the turn fails when it replaces one |
| `before_agent_start` -> `systemPromptOptions.sections` | Yes, one `<name>` block per section |
| `before_agent_start` -> `systemPrompt` | No, dropped |

Two traps. Returning `systemPrompt` from `before_agent_start` makes pi replace the whole system prompt, discarding any `context_with_system` edit in the same run — only one reaches the request. And system-prompt edits work by *wrapping*: replacing pi's prompt leaves the bridge with nothing to match, so it refuses the turn rather than send Claude Code a request missing your context files, skills and custom instructions. The error names the closest known prompt and where it diverged.

To add instructions, use `message`, `context`, or a system-message edit that keeps pi's prompt intact.

### Hooks written for Claude Code

`~/.claude/settings.json` hooks fire inside bridge turns, so a hook injecting Claude-specific guidance duplicates what pi's extensions already provide. pi sets `PI_CODING_AGENT=true` for child processes, including the Claude Code child; a hook can skip itself on that:

```sh
[ -n "$PI_CODING_AGENT" ] && exit 0
```

Hooks do not fire on isolated summary queries.

### Compaction and branch summaries

pi runs compaction and branch summaries natively. The bridge routes their `cacheRetention: "none"` calls to isolated Claude Code queries, leaving the live session untouched until pi completes the history rewrite. Other extensions can provide summaries through pi's hooks.

### System prompt rejections

Other extensions can change the system prompt. When the result still contains pi's built-in system prompt text, or the two documentation paths that Anthropic looks for (`docs/custom-provider.md` in the same prompt with `docs/packages.md`), the bridge stops the turn instead of sending it, since Anthropic may otherwise bill these requests as Extra Usage. Fix the source extension before retrying; `CLAUDE_BRIDGE_DEBUG=1` writes the full prompt to the bridge log when this happens.

### Plan usage for footers and quota extensions

The bridge does not show plan usage itself. Claude Code sends a `rate_limit_event` when a usage window changes, and the bridge passes it to pi's `after_provider_response` event as `anthropic-ratelimit-unified-*` headers. Events are not tied to one response: one that arrives after a turn has ended on a tool call is reported on the next provider call, and only the latest is kept. The headers use the names that the Anthropic API uses (for example `anthropic-ratelimit-unified-5h-utilization`). The bridge sends only the headers that it can make from the event: the status, the reset time, the representative claim, the overage status and reset, and the utilization and reset of each window. The status code is always 200. An extension that reads these headers for the built-in `anthropic` provider can also accept `claude-bridge` without other changes.

### Using claude bridge with @gotgenes/pi-subagents

Requires the following in `~/.pi/agent/subagents.json`:

```json
{"promptInheritance": {"claude-bridge": "portable"}}
```

## Known issues

**A session rebuild re-sends the whole conversation.** The bridge rewrites Claude Code's session from pi's history whenever the two diverge — after an abort, `/compact`, tree navigation, an API error, or on returning to a session — and the next request usually misses the prompt cache for everything past the system prompt. Abort-heavy sessions cost noticeably more.

**Files Claude Code edits are not carried across a rebuild.** The edit itself survives in the history as a tool call and result — what's lost is the post-edit file snapshot. `@file` expansions *are* carried.

**System prompt changes mid-session may not reach the model.** The bridge keeps Claude Code's default prompt recording: project context (AGENTS.md/CLAUDE.md), skills, and extension-written instructions are captured on the first request and reused on resume. This keeps the cached prefix stable, but later changes may not take effect until a rebuild or compaction. Start a new session if updated instructions must take effect immediately.

**Exported Anthropic environment variables override the Claude Code child (issue #107).** An exported `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, or `ANTHROPIC_AUTH_TOKEN` redirects Claude Code to that gateway and every turn fails with its auth error. Unset them for the pi process.
