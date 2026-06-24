import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const bin = path.join(root, 'target', 'debug', process.platform === 'win32' ? 'chatterp2p.exe' : 'chatterp2p')

function runRaw (agent, args, options = {}) {
  return spawnSync(bin, args, {
    cwd: root,
    env: {
      ...process.env,
      CHATTERP2P_CONFIG_DIR: agent.config,
      CHATTERP2P_DATA_DIR: agent.data
    },
    encoding: 'utf8',
    ...options
  })
}

function runJson (agent, args) {
  const result = runRaw(agent, args)
  const output = result.stdout || result.stderr
  assert.equal(result.status, 0, `${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  return JSON.parse(output)
}

function runFail (agent, args) {
  const result = runRaw(agent, args)
  assert.notEqual(result.status, 0, `${args.join(' ')} unexpectedly succeeded`)
  return JSON.parse(result.stderr)
}

function agent (name) {
  const dir = mkdtempSync(path.join(tmpdir(), `chatterp2p-rust-${name}-`))
  return {
    dir,
    config: path.join(dir, 'config'),
    data: path.join(dir, 'data')
  }
}

function waitForCard (agent) {
  for (let i = 0; i < 80; i++) {
    const result = runRaw(agent, ['contact', 'card'])
    if (result.status === 0) {
      const card = JSON.parse(result.stdout)
      if (card.multiaddrs?.length > 0) return card
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
  }
  throw new Error(`daemon did not advertise addresses\n${readFileSync(path.join(agent.data, 'daemon.log'), 'utf8')}`)
}

const a = agent('a')
const b = agent('b')

try {
  const help = runRaw(a, ['--help'])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /peer show/)
  assert.doesNotMatch(help.stdout, /peer ping/)

  const version = runRaw(a, ['--version'])
  assert.equal(version.status, 0)
  assert.match(version.stdout, /^0\.0\.1\n$/)

  const aInit = runJson(a, ['init'])
  const aInitAgain = runJson(a, ['init'])
  const bInit = runJson(b, ['init'])
  assert.match(aInit.peer_id, /^12D3KooW/)
  assert.equal(aInit.peer_id, aInitAgain.peer_id)

  const me = runJson(a, ['me'])
  assert.equal(me.peer_id, aInit.peer_id)
  assert.deepEqual(me.listen, ['/ip4/0.0.0.0/tcp/0/ws'])
  assert.equal(me.relays, undefined)

  const removed = runFail(a, ['relay', 'list'])
  assert.match(removed.error, /Usage: chatterp2p <init\|me\|contact\|peer\|message\|inbox\|read\|daemon>/)

  runJson(b, ['daemon', 'start', '--listen', '/ip4/127.0.0.1/tcp/0/ws'])
  const card = waitForCard(b)
  assert.equal(card.peer_id, bInit.peer_id)
  const addr = card.multiaddrs.find(addr => addr.includes('/ws'))
  assert.ok(addr)

  const added = runJson(a, ['peer', 'add', bInit.peer_id, 'bob', addr])
  assert.equal(added.peer.name, 'bob')

  const shown = runJson(a, ['peer', 'show', 'bob'])
  assert.equal(shown.peer.peer_id, bInit.peer_id)
  assert.deepEqual(shown.peer.addresses, [addr])

  const listed = runJson(a, ['peer', 'list'])
  assert.equal(listed.peers.length, 1)

  const tooLarge = runFail(a, ['message', 'bob', 'x'.repeat(1001)])
  assert.match(tooLarge.error, /exceeds 1000/)

  const sent = runJson(a, ['message', 'bob', 'hello-rust-test'])
  assert.equal(sent.message.body, 'hello-rust-test')

  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)
  const inbox = runJson(b, ['inbox'])
  assert.equal(inbox.messages.length, 1)
  assert.equal(inbox.messages[0].body, 'hello-rust-test')

  const read = runJson(b, ['read', inbox.messages[0].id])
  assert.equal(read.message.id, inbox.messages[0].id)

  const stopped = runJson(b, ['daemon', 'stop'])
  assert.equal(stopped.stopped, true)

  const status = runJson(b, ['daemon', 'status'])
  assert.equal(status.running, false)
} finally {
  runRaw(b, ['daemon', 'stop'])
  rmSync(a.dir, { recursive: true, force: true })
  rmSync(b.dir, { recursive: true, force: true })
}
