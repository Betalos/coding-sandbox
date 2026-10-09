// End-to-end check with fake agents and a local bare repo: no network, no LLM.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-'))
const sh = (cmd, cwd) => execFileSync('sh', ['-c', cmd], { cwd, stdio: 'pipe' }).toString()

// bare "remote" with one commit on main
const remote = path.join(tmp, 'remote.git')
sh(`git init -q --bare -b main ${remote}`)
const seed = path.join(tmp, 'seed')
sh(`git clone -q ${remote} ${seed} && cd ${seed} && git checkout -q -b main && echo one > a.txt && git add . && git -c user.name=t -c user.email=t@t commit -qm init && git push -q origin main`)

// fake agents: write a file, print the secrets it can see (must be none of the git token)
const fake = (name, body) => { const f = path.join(tmp, name); fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); return f }
const opencode = fake('opencode', 'echo "args: $@"; echo made > made.txt; mkdir -p __pycache__; echo x > __pycache__/a.pyc; echo "or=$OPENROUTER_API_KEY git=$GIT_TOKEN"')
const claude = fake('claude', 'echo "claude $@"; echo c > claude.txt; echo "oauth=$CLAUDE_CODE_OAUTH_TOKEN or=$OPENROUTER_API_KEY"')
const caveman = fake('caveman', 'echo "caveman $@ listen=$CAVEMAN_LISTEN home=$CAVEMAN_HOME"; shift 2; exec "$CAVEMAN_FAKE_CLAUDE" "$@"')
const slow = fake('slow', 'sleep 30')
// fake claude for POST /llm: reads the prompt from stdin, records its arguments and secrets, answers like `claude -p --output-format json`
const llmArgs = path.join(tmp, 'llm-args.txt')
const llmClaude = fake('llm-claude', `in=$(cat); echo "$@" > ${llmArgs}; echo "oauth=$CLAUDE_CODE_OAUTH_TOKEN or=$OPENROUTER_API_KEY git=$GIT_TOKEN cwd=$(pwd)" >> ${llmArgs}
case "$in" in
  FAIL*) echo boom >&2; exit 3;;
  ERR*) echo '{"is_error":true,"result":"model overloaded"}'; exit 0;;
  NOSTRUCT*) echo '{"is_error":false,"result":"just text"}'; exit 0;;
  SLEEP*) sleep 30;;
  WAIT*) sleep 2;;
esac
echo '{"is_error":false,"result":"{}","structured_output":{"chars":'\${#in}'},"usage":{"input_tokens":4,"cache_creation_input_tokens":10,"cache_read_input_tokens":6,"output_tokens":7},"total_cost_usd":0.01,"modelUsage":{"claude-haiku-5-5":{}},"num_turns":3}'`)

Object.assign(process.env, {
  SANDBOX_TOKEN: 'secret', WORKSPACE: path.join(tmp, 'ws'), ALLOW_FILE_REPOS: '1', OPENCODE_BIN: opencode, CLAUDE_BIN: claude,
  OPENROUTER_API_KEY: 'or-key', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-tok', GIT_TOKEN: 'must-not-leak', MAX_JOBS: '2', MAX_LLM: '1', PORT: '0', CAVEMAN_HOME: '/h/cave', DOCKER_HOST: 'tcp://dind:2375'
})
fs.mkdirSync(path.join(process.env.WORKSPACE, '.logs'), { recursive: true })
const { server, cleanWorkspace } = require('../src/server')

// startup cleanup keeps the workspace directory itself (it is a mount point in production) and removes stale clones
fs.mkdirSync(path.join(process.env.WORKSPACE, 'stale', 'sub'), { recursive: true })
cleanWorkspace()
assert.deepEqual(fs.readdirSync(process.env.WORKSPACE), ['.logs'])

const call = async (method, p, body, token = 'secret') => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, body: await r.json() }
}
const finish = async (id) => { for (let i = 0; i < 100; i++) { const r = await call('GET', `/jobs/${id}`); if (!['queued', 'cloning', 'running'].includes(r.body.status)) return r.body; await new Promise((s) => setTimeout(s, 100)) } throw new Error('job did not finish') }
const job = (id, extra) => ({ id, repo: `file://${remote}`, branch: `job/${id}`, agent: 'opencode', prompt: 'do it', model: 'deepseek/x', ...extra })

server.listen(0, async () => {
  try {
    assert.equal((await call('GET', '/jobs', null, 'wrong')).status, 401, 'bad token')
    assert.equal((await call('POST', '/jobs', job('../x'))).status, 400, 'bad id')
    assert.equal((await call('POST', '/jobs', job('j0', { repo: 'https://evil.example/x.git' }))).status, 400, 'host not allowed')
    assert.equal((await call('POST', '/jobs', job('j0', { agent: 'nope' }))).status, 400, 'bad agent')

    // opencode job: runs, edits, sees only its own secrets
    assert.equal((await call('POST', '/jobs', job('j1', { token: 'T' }))).status, 200)
    assert.equal((await call('POST', '/jobs', job('jb'))).status, 200, 'MAX_JOBS=2: a second job runs alongside')
    assert.equal((await call('POST', '/jobs', job('j2'))).status, 429, 'concurrency limit')
    await finish('jb'); await call('DELETE', '/jobs/jb')
    let j = await finish('j1')
    assert.equal(j.status, 'done'); assert.equal(j.exit_code, 0)
    assert.match(j.log, /args: run --model openrouter\/deepseek\/x do it/)
    assert.match(j.log, /or=or-key git=\n/, 'agent must not see the git token')
    assert.match(j.log, /updating mirror .*cloning from mirror/s, 'clone comes from the local mirror')
    const ws = process.env.WORKSPACE
    assert.equal(fs.readdirSync(path.join(ws, '.mirrors')).filter((n) => n.endsWith('.git')).length, 1, 'one mirror for the repo, shared by both jobs')
    assert.equal(sh('git remote get-url origin', path.join(ws, 'j1')).trim(), `file://${remote}`, 'origin points at the real repository, not the mirror')
    assert.equal(sh('find .git/objects -type f -links +1 | wc -l', path.join(ws, 'j1')).trim(), '0', 'no hardlinks into the mirror')
    assert.equal((await call('GET', `/jobs/j1?since=${j.next}`)).body.log, '', 'log offset')

    // independent test run + push
    assert.equal((await call('POST', '/jobs/j1/test', { cmd: 'test -f made.txt' })).body.exit_code, 0)
    assert.equal((await call('POST', '/jobs/j1/test', { cmd: 'test -f nope.txt' })).body.exit_code, 1)
    assert.equal((await call('POST', '/jobs/j1/test', { cmd: 'echo $COMPOSE_PROJECT_NAME' })).body.output.trim(), 'j1', 'own compose project per job')
    assert.equal((await call('POST', '/jobs/j1/test', { cmd: 'auto' })).body.exit_code, 127, 'auto: no tests detected is not a pass')
    assert.match((await call('POST', '/jobs/j1/test', { cmd: 'echo $DOCKER_HOST' })).body.output, /tcp:\/\/dind:2375/), 'DOCKER_HOST reaches the commands'
    const p = (await call('POST', '/jobs/j1/push', { message: 'add made.txt' })).body
    assert.equal(p.branch, 'job/j1'); assert.match(p.stat, /made.txt/)
    assert.equal(sh(`git --git-dir=${remote} show job/j1:made.txt`).trim(), 'made')
    assert.ok(!/pycache/.test(sh(`git --git-dir=${remote} ls-tree -r --name-only job/j1`)), 'build artifacts are not pushed')
    assert.equal((await call('POST', '/jobs/j1/push', {})).body.sha, p.sha, 're-push is a no-op')
    assert.match((await call('GET', '/jobs/j1/diff')).body.diff, /made.txt/)
    assert.equal((await call('DELETE', '/jobs/j1')).status, 200)
    assert.ok(!fs.existsSync(path.join(process.env.WORKSPACE, 'j1')), 'workspace removed')

    // from_branch: continue the branch pushed by j1 (a PR being fixed): its commit is there, new work lands on top, push is a fast-forward
    assert.equal((await call('POST', '/jobs', job('j6', { branch: 'job/j1', from_branch: true }))).status, 200)
    j = await finish('j6'); assert.equal(j.status, 'done')
    assert.equal((await call('POST', '/jobs/j6/test', { cmd: 'git log --oneline | grep -q "add made.txt"' })).body.exit_code, 0, 'previous commit is in the history')
    await call('POST', '/jobs/j6/test', { cmd: 'echo more >> made.txt' })
    assert.equal((await call('POST', '/jobs/j6/push', { message: 'fix round' })).body.commits, 2, 'two commits on the branch now')
    await call('DELETE', '/jobs/j6')

    // claude job
    assert.equal((await call('POST', '/jobs', job('j3', { agent: 'claude', model: 'sonnet' }))).status, 200)
    j = await finish('j3')
    assert.equal(j.status, 'done'); assert.match(j.log, /claude -p do it --output-format stream-json .*--model sonnet/)
    assert.match(j.log, /oauth=oauth-tok or=\n/, 'claude gets only its own secrets')
    await call('DELETE', '/jobs/j3')

    // claude wrapped with caveman
    Object.assign(process.env, { CLAUDE_WRAP: 'caveman', CAVEMAN_BIN: caveman, CAVEMAN_FAKE_CLAUDE: claude })
    assert.equal((await call('POST', '/jobs', job('j5', { agent: 'claude' }))).status, 200)
    j = await finish('j5')
    assert.equal(j.status, 'done'); assert.match(j.log, /caveman wrap claude -p do it .*listen=127\.0\.0\.1:180\d\d home=\/h\/cave/)
    assert.match(j.log, /oauth=oauth-tok/)
    await call('DELETE', '/jobs/j5')
    delete process.env.CLAUDE_WRAP

    // POST /llm: prompt on stdin, schema + flags on the command line, no repo, only claude's own secrets
    const schema = { type: 'object', properties: { chars: { type: 'number' } } }
    process.env.CLAUDE_BIN = llmClaude
    let l = await call('POST', '/llm', { user: 'x'.repeat(200000), system: 'be brief', schema, model: 'haiku', effort: 'low' })
    assert.equal(l.status, 200); assert.deepEqual(l.body.data, { chars: 200000 }, 'a 200k prompt gets through (stdin, not argv)')
    assert.equal(l.body.model, 'claude-haiku-5-5'); assert.deepEqual(l.body.usage, { prompt_tokens: 20, completion_tokens: 7, cached_tokens: 6 }); assert.equal(l.body.cost_usd, 0.01)
    const seen = fs.readFileSync(llmArgs, 'utf8')
    assert.match(seen, /^-p --output-format json --json-schema \{.*\} --tools {2}--no-session-persistence --model haiku --system-prompt be brief --effort low/)
    assert.match(seen, /oauth=oauth-tok or= git= cwd=.*\.llm-/, 'only the claude secret, empty temp cwd')
    assert.deepEqual(fs.readdirSync(process.env.WORKSPACE).filter((n) => n.startsWith('.llm-')), [], 'temp dir removed')
    assert.equal((await call('POST', '/llm', { user: 'FAIL', schema })).status, 502, 'non-zero exit')
    assert.match((await call('POST', '/llm', { user: 'ERR', schema })).body.error, /model overloaded/)
    assert.match((await call('POST', '/llm', { user: 'NOSTRUCT', schema })).body.error, /no structured output/)
    assert.equal((await call('POST', '/llm', { schema })).status, 400, 'user required')
    assert.equal((await call('POST', '/llm', { user: 'a' })).status, 400, 'schema required')
    assert.equal((await call('POST', '/llm', { user: 'a', schema, model: 'a b' })).status, 400, 'bad model')
    assert.equal((await call('POST', '/llm', { user: 'a', schema, effort: 'turbo' })).status, 400, 'bad effort')
    assert.equal((await call('POST', '/llm', { user: 'SLEEP', schema, timeout_s: 1 })).status, 504, 'timeout')
    const first = call('POST', '/llm', { user: 'WAIT', schema }); await new Promise((r) => setTimeout(r, 500))
    assert.equal((await call('POST', '/llm', { user: 'a', schema })).status, 429, 'own pool of MAX_LLM calls')
    assert.equal((await first).status, 200)
    const keep = Object.fromEntries(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'].map((k) => [k, process.env[k]]))
    for (const k of Object.keys(keep)) delete process.env[k]
    assert.equal((await call('POST', '/llm', { user: 'a', schema })).status, 503, 'no credentials')
    for (const [k, v] of Object.entries(keep)) if (v !== undefined) process.env[k] = v
    assert.equal((await call('POST', '/llm', { user: 'a', schema }, 'wrong')).status, 401)
    process.env.CLAUDE_BIN = claude

    // the mirror is refreshed by every job: a commit pushed after it was created is in the next clone
    sh(`cd ${seed} && echo two > b.txt && git add . && git -c user.name=t -c user.email=t@t commit -qm two && git push -q origin main`)
    assert.equal((await call('POST', '/jobs', job('j7'))).status, 200)
    assert.equal((await finish('j7')).status, 'done')
    assert.equal((await call('POST', '/jobs/j7/test', { cmd: 'test -f b.txt' })).body.exit_code, 0, 'new commit reached the clone through the refreshed mirror')
    await call('DELETE', '/jobs/j7')

    // parallel jobs (MAX_JOBS=2): two run side by side in their own clones, a third waits (429)
    process.env.OPENCODE_BIN = slow
    assert.equal((await call('POST', '/jobs', job('p1'))).status, 200); assert.equal((await call('POST', '/jobs', job('p2'))).status, 200)
    for (let i = 0; i < 100; i++) { const a = (await call('GET', '/jobs/p1')).body.status; const b = (await call('GET', '/jobs/p2')).body.status; if (a === 'running' && b === 'running') break; await new Promise((r) => setTimeout(r, 100)) }
    assert.equal((await call('GET', '/jobs/p1')).body.status, 'running'); assert.equal((await call('GET', '/jobs/p2')).body.status, 'running', 'two jobs running at the same time')
    assert.equal((await call('POST', '/jobs', job('p3'))).status, 429, 'third job is refused')
    assert.notEqual(fs.realpathSync(path.join(ws, 'p1')), fs.realpathSync(path.join(ws, 'p2')))
    await call('DELETE', '/jobs/p1'); await call('DELETE', '/jobs/p2')
    process.env.OPENCODE_BIN = opencode

    // timeout kills the agent
    process.env.OPENCODE_BIN = slow
    assert.equal((await call('POST', '/jobs', job('j4', { timeout_s: 1 }))).status, 200)
    j = await finish('j4')
    assert.equal(j.status, 'timeout')
    await call('DELETE', '/jobs/j4')
    console.log('smoke ok')
  } catch (e) {
    console.error('smoke FAILED:', e.message)
    process.exitCode = 1
  } finally {
    server.close(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit()
  }
})
