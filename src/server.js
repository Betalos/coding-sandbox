// Job runner for coding agents. n8n (or any HTTP client) starts a job, polls it, runs the tests itself and pushes.
// One job = one fresh clone under WORKSPACE. The git token lives only in memory and is passed to git per command
// (never written into .git/config), so the agent cannot push on its own. Plain HTTP: keep it on a private network.

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn, execFile } = require('node:child_process')

const env = process.env
const PORT = Number(env.PORT ?? 8080)
const WORKSPACE = env.WORKSPACE ?? '/workspace'
const MAX_JOBS = Number(env.MAX_JOBS ?? 1)
const DEFAULT_TIMEOUT_S = Number(env.DEFAULT_TIMEOUT_S ?? 1800)
const MAX_TIMEOUT_S = Number(env.MAX_TIMEOUT_S ?? 7200)
const ALLOWED_GIT_HOSTS = (env.ALLOWED_GIT_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean)
const ALLOW_FILE_REPOS = env.ALLOW_FILE_REPOS === '1' // tests only
const SANDBOX_TOKEN = env.SANDBOX_TOKEN
const AGENTS = {
  opencode: {
    get bin () { return env.OPENCODE_BIN ?? 'opencode' },
    args: (prompt, model) => ['run', ...(model ? ['--model', model.startsWith('openrouter/') ? model : `openrouter/${model}`] : []), prompt],
    secrets: ['OPENROUTER_API_KEY']
  },
  claude: {
    get bin () { return env.CLAUDE_BIN ?? 'claude' },
    args: (prompt, model) => ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', ...(model ? ['--model', model] : [])],
    secrets: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN']
  }
}
const LOG_CHUNK = 64 * 1024

if (!SANDBOX_TOKEN) {
  console.error('SANDBOX_TOKEN is required')
  process.exit(1)
}
if (!ALLOWED_GIT_HOSTS.length && !ALLOW_FILE_REPOS) {
  console.error('ALLOWED_GIT_HOSTS is required (comma separated hosts the jobs may clone from)')
  process.exit(1)
}

class HttpError extends Error {
  constructor (status, message) {
    super(message)
    this.status = status
  }
}

const jobs = new Map() // id -> { id, dir, logFile, status, exitCode, branch, base, token, proc, started, ended, agent }

const jobDir = (id) => path.join(WORKSPACE, id)
const logFile = (id) => path.join(WORKSPACE, '.logs', `${id}.log`)

function git (args, { cwd, token, input } = {}) {
  const auth = token ? ['-c', `http.extraHeader=Authorization: token ${token}`] : []
  return new Promise((resolve, reject) => {
    const child = execFile('git', [...auth, ...args], { cwd, maxBuffer: 16 * 1024 * 1024, env: { PATH: env.PATH, HOME: env.HOME, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      if (err) return reject(new HttpError(502, `git ${args[0]} failed: ${(stderr || err.message).replaceAll(token ?? '\0', '***').trim().slice(-500)}`))
      resolve(stdout)
    })
    if (input) child.stdin.end(input)
  })
}

function validate (b) {
  const id = String(b.id ?? '')
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(id) || id.startsWith('.')) throw new HttpError(400, '"id" must match [A-Za-z0-9._-]{1,64}')
  const repo = String(b.repo ?? '')
  const url = /^https:\/\//.test(repo) ? new URL(repo) : null
  if (url ? !ALLOWED_GIT_HOSTS.includes(url.host) : !(ALLOW_FILE_REPOS && repo.startsWith('file://'))) throw new HttpError(400, `"repo" must be an https URL on one of: ${ALLOWED_GIT_HOSTS.join(', ')}`)
  if (url && (url.username || url.password)) throw new HttpError(400, '"repo" must not contain credentials; pass "token"')
  for (const k of ['branch', 'base']) if (b[k] != null && !/^[A-Za-z0-9._/-]{1,100}$/.test(b[k])) throw new HttpError(400, `"${k}" is not a valid branch name`)
  if (!b.branch) throw new HttpError(400, '"branch" is required')
  const agent = AGENTS[b.agent]
  if (!agent) throw new HttpError(400, `"agent" must be one of: ${Object.keys(AGENTS).join(', ')}`)
  if (!b.prompt || typeof b.prompt !== 'string') throw new HttpError(400, '"prompt" is required')
  if (!agent.secrets.some((s) => env[s])) throw new HttpError(503, `agent "${b.agent}" has no credentials configured (${agent.secrets.join(' or ')})`)
  const timeout = Math.min(Number(b.timeout_s ?? DEFAULT_TIMEOUT_S), MAX_TIMEOUT_S)
  if (!(timeout > 0)) throw new HttpError(400, '"timeout_s" must be positive')
  return { id, repo, branch: b.branch, base: b.base ?? 'main', agent: b.agent, prompt: b.prompt, model: b.model, token: b.token, timeout }
}

// the agent gets only what it needs: no git token, no n8n-facing secrets
function agentEnv (agentName) {
  const out = { PATH: env.PATH, HOME: env.HOME, LANG: env.LANG ?? 'C.UTF-8', CI: '1' }
  for (const k of AGENTS[agentName].secrets) if (env[k]) out[k] = env[k]
  return out
}

function killTree (proc) {
  try { process.kill(-proc.pid, 'SIGKILL') } catch { /* already gone */ }
}

async function runJob (job, spec) {
  const log = fs.createWriteStream(job.logFile, { flags: 'a' })
  const say = (m) => log.write(`[sandbox] ${m}\n`)
  try {
    job.status = 'cloning'
    say(`cloning ${spec.repo}`)
    await git(['clone', spec.repo, job.dir], { token: spec.token })
    await git(['checkout', '-B', spec.branch, `origin/${spec.base}`], { cwd: job.dir })
    await git(['config', 'user.name', env.GIT_AUTHOR_NAME ?? 'dev-agent'], { cwd: job.dir })
    await git(['config', 'user.email', env.GIT_AUTHOR_EMAIL ?? 'dev-agent@synapia.cc'], { cwd: job.dir })
    job.status = 'running'
    say(`running ${spec.agent}`)
    const agent = AGENTS[spec.agent]
    const proc = spawn(agent.bin, agent.args(spec.prompt, spec.model), { cwd: job.dir, env: agentEnv(spec.agent), detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    job.proc = proc
    proc.stdout.pipe(log, { end: false })
    proc.stderr.pipe(log, { end: false })
    const timer = setTimeout(() => { job.timedOut = true; killTree(proc) }, spec.timeout * 1000)
    const code = await new Promise((resolve) => {
      proc.on('error', (e) => { say(`cannot start ${agent.bin}: ${e.message}`); resolve(127) })
      proc.on('close', (c) => resolve(c ?? 1))
    })
    clearTimeout(timer)
    job.exitCode = code
    job.status = job.timedOut ? 'timeout' : code === 0 ? 'done' : 'failed'
    say(`agent finished: ${job.status} (exit ${code})`)
  } catch (err) {
    job.status = 'failed'
    say(`error: ${err.message}`)
  } finally {
    job.ended = new Date().toISOString()
    job.proc = null
    log.end()
  }
}

function startJob (body) {
  const spec = validate(body)
  if (jobs.has(spec.id) || fs.existsSync(jobDir(spec.id))) throw new HttpError(409, `job "${spec.id}" already exists`)
  if ([...jobs.values()].filter((j) => j.status === 'cloning' || j.status === 'running').length >= MAX_JOBS) throw new HttpError(429, `busy: ${MAX_JOBS} job(s) already running`)
  fs.mkdirSync(path.dirname(logFile(spec.id)), { recursive: true })
  const job = { id: spec.id, dir: jobDir(spec.id), logFile: logFile(spec.id), status: 'queued', exitCode: null, branch: spec.branch, base: spec.base, token: spec.token, agent: spec.agent, started: new Date().toISOString(), ended: null, proc: null }
  jobs.set(job.id, job)
  runJob(job, spec)
  return { id: job.id, status: job.status }
}

function getJob (id) {
  const job = jobs.get(id)
  if (!job) throw new HttpError(404, `no job "${id}"`)
  return job
}

function readLog (job, since) {
  let size = 0
  try { size = fs.statSync(job.logFile).size } catch { /* no log yet */ }
  const start = Math.max(Number(since) || 0, 0)
  const from = Math.max(start, size - LOG_CHUNK) // a client that fell far behind skips ahead
  const buf = Buffer.alloc(Math.max(size - from, 0))
  if (buf.length) {
    const fd = fs.openSync(job.logFile, 'r')
    fs.readSync(fd, buf, 0, buf.length, from)
    fs.closeSync(fd)
  }
  return { log: buf.toString('utf8'), next: size, skipped: from > start }
}

function status (job, since) {
  const { id, status: s, exitCode, branch, agent, started, ended } = job
  return { id, status: s, exit_code: exitCode, branch, agent, started, ended, ...readLog(job, since) }
}

// n8n runs the tests itself; the agent's own claim that they pass is not trusted
function runTests (job, { cmd, timeout_s: t = 900 }) {
  if (!cmd || typeof cmd !== 'string') throw new HttpError(400, '"cmd" is required')
  if (job.status === 'running' || job.status === 'cloning') throw new HttpError(409, 'job is still running')
  return new Promise((resolve) => {
    const proc = spawn('sh', ['-c', cmd], { cwd: job.dir, env: agentEnv(job.agent), detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const add = (d) => { out = (out + d).slice(-20000) }
    proc.stdout.on('data', add)
    proc.stderr.on('data', add)
    const timer = setTimeout(() => killTree(proc), Math.min(Number(t), MAX_TIMEOUT_S) * 1000)
    proc.on('close', (code) => { clearTimeout(timer); resolve({ exit_code: code ?? 1, output: out }) })
  })
}

async function push (job, { message, token }) {
  const t = token ?? job.token
  if (!t) throw new HttpError(400, 'no git token for this job: pass "token"')
  const dirty = (await git(['status', '--porcelain'], { cwd: job.dir })).trim()
  if (dirty) {
    await git(['add', '-A'], { cwd: job.dir })
    await git(['commit', '-m', message || `Changes for ${job.branch}`], { cwd: job.dir })
  }
  const ahead = Number((await git(['rev-list', '--count', `origin/${job.base}..HEAD`], { cwd: job.dir })).trim())
  if (!ahead) throw new HttpError(409, 'nothing to push: the branch has no commits on top of the base')
  await git(['push', 'origin', `HEAD:refs/heads/${job.branch}`], { cwd: job.dir, token: t })
  const sha = (await git(['rev-parse', 'HEAD'], { cwd: job.dir })).trim()
  const stat = (await git(['diff', '--stat', `origin/${job.base}..HEAD`], { cwd: job.dir })).trim()
  return { branch: job.branch, sha, commits: ahead, stat }
}

async function diff (job) {
  return { diff: (await git(['diff', `origin/${job.base}`], { cwd: job.dir })).slice(0, 200 * 1024) }
}

function remove (job) {
  if (job.proc) killTree(job.proc)
  fs.rmSync(job.dir, { recursive: true, force: true })
  fs.rmSync(job.logFile, { force: true })
  jobs.delete(job.id)
  return { deleted: job.id }
}

const routes = [
  ['GET', /^\/jobs$/, () => [...jobs.values()].map((j) => ({ id: j.id, status: j.status, branch: j.branch, agent: j.agent, started: j.started, ended: j.ended }))],
  ['POST', /^\/jobs$/, (_p, _q, b) => startJob(b)],
  ['GET', /^\/jobs\/([^/]+)$/, ([id], q) => status(getJob(id), q.since)],
  ['POST', /^\/jobs\/([^/]+)\/test$/, ([id], _q, b) => runTests(getJob(id), b)],
  ['POST', /^\/jobs\/([^/]+)\/push$/, ([id], _q, b) => push(getJob(id), b)],
  ['GET', /^\/jobs\/([^/]+)\/diff$/, ([id]) => diff(getJob(id))],
  ['DELETE', /^\/jobs\/([^/]+)$/, ([id]) => remove(getJob(id))]
]

const authorized = (req) => {
  const given = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? ''
  const a = crypto.createHash('sha256').update(given).digest()
  const b = crypto.createHash('sha256').update(SANDBOX_TOKEN).digest()
  return crypto.timingSafeEqual(a, b)
}

async function readJson (req) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  if (!raw) return {}
  try { return JSON.parse(raw) } catch { throw new HttpError(400, 'Body must be JSON') }
}

function send (res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://sandbox')
  if (url.pathname === '/health') return send(res, 200, { ok: true, running: [...jobs.values()].filter((j) => j.status === 'running' || j.status === 'cloning').length })
  const started = Date.now()
  try {
    if (!authorized(req)) throw new HttpError(401, 'Authorization: Bearer <sandbox token> is required')
    const route = routes.find(([method, re]) => method === req.method && re.test(url.pathname))
    if (!route) throw new HttpError(404, `No route ${req.method} ${url.pathname}`)
    const params = route[1].exec(url.pathname).slice(1)
    const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readJson(req)
    send(res, 200, await route[2](params, Object.fromEntries(url.searchParams), body))
  } catch (err) {
    send(res, err.status ?? 500, { error: err.message })
  } finally {
    console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`)
  }
})

if (require.main === module) {
  // job state is in memory only: after a restart the old clones are orphans
  fs.rmSync(WORKSPACE, { recursive: true, force: true, maxRetries: 2 })
  fs.mkdirSync(path.join(WORKSPACE, '.logs'), { recursive: true })
  server.listen(PORT, () => console.log(`coding-sandbox listening on :${PORT}`))
}
module.exports = { server }
