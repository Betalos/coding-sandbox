# coding-sandbox

Small plain-HTTP job runner that lets n8n (or any HTTP client) run a coding agent, [OpenCode](https://opencode.ai) or
[Claude Code](https://claude.com/claude-code), against a git repository inside a hardened container.
No npm dependencies.

One job = one fresh clone, taken from a local bare mirror of the repository (cloned once under `WORKSPACE/.mirrors`, refreshed with `git remote update --prune` at the start of every job and kept across restarts; the clone is a full copy, no hardlinks, so jobs cannot touch each other's objects, and `origin` points at the real repository). Jobs run in parallel up to `MAX_JOBS`; each gets its own `COMPOSE_PROJECT_NAME` so compose stacks on the shared Docker daemon do not collide (fixed host ports still can). The git token is held in memory and passed to git per command, never written to `.git/config`,
and never given to the agent: the agent edits and commits, the caller tests and pushes.

## Run

See `compose.example.yaml` (read-only root, dropped capabilities, one writable mount, own network).

| Env | |
|---|---|
| `SANDBOX_TOKEN` | required; callers send `Authorization: Bearer <token>` |
| `ALLOWED_GIT_HOSTS` | required; comma separated hosts a job may clone from (https only) |
| `OPENROUTER_API_KEY` | OpenCode (and any agent pointed at OpenRouter) |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code with a Claude subscription (`claude setup-token`); `ANTHROPIC_API_KEY`, or `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`, work too |
| `CLAUDE_WRAP` | `caveman` (the image default) runs Claude Code as `caveman wrap claude` for local context compression; empty runs it plain. Each job gets its own proxy port; `CAVEMAN_*` variables are passed through |
| `GIT_TOKEN` | default git token for jobs that pass none (a Forgejo PAT); used by git only, never given to the agent |
| `MAX_JOBS` | concurrent jobs, default `1` (more get `429`); each needs its own CPU, memory and Docker capacity |
| `MAX_LLM` | concurrent `POST /llm` calls, default `4` (own pool, not counted in `MAX_JOBS`; more get `429`) |
| `DEFAULT_TIMEOUT_S` / `MAX_TIMEOUT_S` | agent time limit, default 1800 / 7200 |
| `WORKSPACE` | clone directory, default `/workspace`; wiped on start |

## API

`GET /health` (no auth), then with the bearer token:

| | |
|---|---|
| `POST /jobs` | `{id, repo, branch, base?="main", from_branch?, token, agent: "opencode"\|"claude", prompt, model?, timeout_s?}` clones, branches from `base` (or continues the existing `branch` with `from_branch: true`, e.g. to fix a pull request), runs the agent headless. `202`-style: returns at once, poll the job |
| `GET /jobs/:id?since=N` | `{status: cloning\|running\|done\|failed\|timeout, exit_code, log, next}`; pass `next` as `since` to read only new output |
| `POST /jobs/:id/test` | `{cmd, timeout_s?}` runs `cmd` in the clone, returns `{exit_code, output}` (output tail). `cmd: "auto"` runs the project's own test command (npm test, make test, pytest/unittest); exit 127 if none is found |
| `POST /jobs/:id/push` | `{message?, token?}` commits what is left, pushes `HEAD` to `branch`; returns `{branch, sha, commits, stat}` |
| `GET /jobs/:id/diff` | diff against the base branch |
| `DELETE /jobs/:id` | stops the agent and deletes the clone |
| `POST /llm` | `{user, schema, system?, model?="sonnet", effort?, timeout_s?=300}`: one prompt in, JSON out. Runs `claude -p --json-schema` with no tools, no session and an empty working directory (no repository; the prompt goes in on stdin), so n8n can use Claude Code (a subscription login) like an LLM node. Returns `{data (validated against schema), text, model, usage: {prompt_tokens, completion_tokens, cached_tokens}, cost_usd (list-price equivalent, a subscription is not billed per token), turns, seconds}`; `502` if claude fails or returns no structured output, `504` on timeout, `503` without credentials |

`model` for OpenCode is an OpenRouter model id (`deepseek/deepseek-v4.1-flash`); for Claude Code a Claude model alias or id.

## Releases

Pushes to `main` publish `ghcr.io/<owner>/coding-sandbox:latest` and `:sha-…`; tags `v1.2.3` publish `1.2.3` and `1.2`.
The image is Oracle Linux 10 with the newest Node.js LTS (resolved at build time), git, a C/C++ toolchain, python3 and the Docker client (CLI, Compose, Buildx; no daemon, set `DOCKER_HOST`). Docker/Compose/Buildx versions are pinned in the Dockerfile; rebuild monthly and bump them.
