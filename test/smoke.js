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

Object.assign(process.env, {
  SANDBOX_TOKEN: 'secret', WORKSPACE: path.join(tmp, 'ws'), ALLOW_FILE_REPOS: '1', OPENCODE_BIN: opencode, CLAUDE_BIN: claude,
  OPENROUTER_API_KEY: 'or-key', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-tok', GIT_TOKEN: 'must-not-leak', MAX_JOBS: '1', PORT: '0', CAVEMAN_HOME: '/h/cave', DOCKER_HOST: 'tcp://dind:2375'
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
const job = (id, extra) => ({ id, repo: `file://${remote}`, branch: `huly/${id}`, agent: 'opencode', prompt: 'do it', model: 'deepseek/x', ...extra })

server.listen(0, async () => {
  try {
    assert.equal((await call('GET', '/jobs', null, 'wrong')).status, 401, 'bad token')
    assert.equal((await call('POST', '/jobs', job('../x'))).status, 400, 'bad id')
    assert.equal((await call('POST', '/jobs', job('j0', { repo: 'https://evil.example/x.git' }))).status, 400, 'host not allowed')
    assert.equal((await call('POST', '/jobs', job('j0', { agent: 'nope' }))).status, 400, 'bad agent')

    // opencode job: runs, edits, sees only its own secrets
    assert.equal((await call('POST', '/jobs', job('j1', { token: 'T' }))).status, 200)
    assert.equal((await call('POST', '/jobs', job('j2'))).status, 429, 'concurrency limit')
    let j = await finish('j1')
    assert.equal(j.status, 'done'); assert.equal(j.exit_code, 0)
    assert.match(j.log, /args: run --model openrouter\/deepseek\/x do it/)
    assert.match(j.log, /or=or-key git=\n/, 'agent must not see the git token')
    assert.equal((await call('GET', `/jobs/j1?since=${j.next}`)).body.log, '', 'log offset')

    // independent test run + push
    assert.equal((await call('POST', '/jobs/j1/test', { cmd: 'test -f made.txt' })).body.exit_code, 0)
    assert.equal((await call('POST', '/jobs/j1/test', { cmd: 'test -f nope.txt' })).body.exit_code, 1)
    assert.equal((await call('POST', '/jobs/j1/test', { cmd: 'auto' })).body.exit_code, 127, 'auto: no tests detected is not a pass')
    assert.match((await call('POST', '/jobs/j1/test', { cmd: 'echo $DOCKER_HOST' })).body.output, /tcp:\/\/dind:2375/), 'DOCKER_HOST reaches the commands'
    const p = (await call('POST', '/jobs/j1/push', { message: 'add made.txt' })).body
    assert.equal(p.branch, 'huly/j1'); assert.match(p.stat, /made.txt/)
    assert.equal(sh(`git --git-dir=${remote} show huly/j1:made.txt`).trim(), 'made')
    assert.ok(!/pycache/.test(sh(`git --git-dir=${remote} ls-tree -r --name-only huly/j1`)), 'build artifacts are not pushed')
    assert.equal((await call('POST', '/jobs/j1/push', {})).body.sha, p.sha, 're-push is a no-op')
    assert.match((await call('GET', '/jobs/j1/diff')).body.diff, /made.txt/)
    assert.equal((await call('DELETE', '/jobs/j1')).status, 200)
    assert.ok(!fs.existsSync(path.join(process.env.WORKSPACE, 'j1')), 'workspace removed')

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
