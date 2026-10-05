# coding-sandbox

Small plain-HTTP job runner that lets n8n (or any HTTP client) run a coding agent, [OpenCode](https://opencode.ai) or
[Claude Code](https://claude.com/claude-code), against a git repository inside a hardened container.
No npm dependencies.

One job = one fresh clone. The git token is held in memory and passed to git per command, never written to `.git/config`,
and never given to the agent: the agent edits and commits, the caller tests and pushes.

## Run

See `compose.example.yaml` (read-only root, dropped capabilities, one writable mount, own network).

| Env | |
|---|---|
| `SANDBOX_TOKEN` | required; callers send `Authorization: Bearer <token>` |
| `ALLOWED_GIT_HOSTS` | required; comma separated hosts a job may clone from (https only) |
| `OPENROUTER_API_KEY` | OpenCode (and any agent pointed at OpenRouter) |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code with a Claude subscription (`claude setup-token`); `ANTHROPIC_API_KEY`, or `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`, work too |
| `MAX_JOBS` | concurrent jobs, default `1` (more get `429`) |
| `DEFAULT_TIMEOUT_S` / `MAX_TIMEOUT_S` | agent time limit, default 1800 / 7200 |
| `WORKSPACE` | clone directory, default `/workspace`; wiped on start |

## API

`GET /health` (no auth), then with the bearer token:

| | |
|---|---|
| `POST /jobs` | `{id, repo, branch, base?="main", token, agent: "opencode"\|"claude", prompt, model?, timeout_s?}` clones, branches from `base`, runs the agent headless. `202`-style: returns at once, poll the job |
| `GET /jobs/:id?since=N` | `{status: cloning\|running\|done\|failed\|timeout, exit_code, log, next}`; pass `next` as `since` to read only new output |
| `POST /jobs/:id/test` | `{cmd, timeout_s?}` runs `cmd` in the clone, returns `{exit_code, output}` (output tail) |
| `POST /jobs/:id/push` | `{message?, token?}` commits what is left, pushes `HEAD` to `branch`; returns `{branch, sha, commits, stat}` |
| `GET /jobs/:id/diff` | diff against the base branch |
| `DELETE /jobs/:id` | stops the agent and deletes the clone |

`model` for OpenCode is an OpenRouter model id (`deepseek/deepseek-v4.1-flash`); for Claude Code a Claude model alias or id.

## Releases

Pushes to `main` publish `ghcr.io/<owner>/coding-sandbox:latest` and `:sha-…`; tags `v1.2.3` publish `1.2.3` and `1.2`.
The base image is `node:current`; rebuild monthly.
