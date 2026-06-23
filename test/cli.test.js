import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const cli = path.resolve('src/cli.js')
const relayHelper = path.resolve('test_helpers/relay-helper.js')

async function tmpAgent (name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `chatterp2p-${name}-`))
  return {
    root,
    env: {
      ...process.env,
      CHATTERP2P_CONFIG_DIR: path.join(root, 'config'),
      CHATTERP2P_DATA_DIR: path.join(root, 'data')
    }
  }
}

function runCli (agent, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: agent.env,
      ...options
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
}

async function runJson (agent, args) {
  const result = await runCli(agent, args)
  const body = JSON.parse(result.stdout || result.stderr)
  return { ...result, body }
}

function parseFirstStartupJson (raw) {
  const lines = raw.split('\n')
  let acc = ''
  for (const line of lines) {
    if (line.trim() === '' && acc === '') continue
    acc += `${line}\n`
    try {
      const parsed = JSON.parse(acc)
      if (parsed.success === true && Array.isArray(parsed.addresses)) return parsed
    } catch {}
  }
  return null
}

async function waitForProcessJson (child, label) {
  let stdout = ''
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not start: ${stdout}`)), 10000)
    child.stdout.on('data', chunk => {
      stdout += chunk
      const parsed = parseFirstStartupJson(stdout)
      if (parsed != null) {
        clearTimeout(timer)
        resolve(parsed)
      }
    })
    child.stderr.on('data', chunk => {
      stdout += chunk
    })
    child.on('exit', code => reject(new Error(`${label} exited early with ${code}: ${stdout}`)))
  })
}

async function waitForDaemonJson (agent) {
  const log = path.join(agent.env.CHATTERP2P_DATA_DIR, 'daemon.log')
  const started = Date.now()
  while (Date.now() - started < 10000) {
    try {
      const parsed = parseFirstStartupJson(await fs.readFile(log, 'utf8'))
      if (parsed != null) return parsed
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`daemon did not start: ${await fs.readFile(log, 'utf8').catch(() => '')}`)
}

async function stopChild (child) {
  if (child.exitCode != null) return
  child.kill('SIGTERM')
  await new Promise(resolve => child.once('close', resolve))
}

test('init is idempotent and returns a Peer ID', async () => {
  const agent = await tmpAgent('init')
  const first = await runJson(agent, ['init'])
  const second = await runJson(agent, ['init'])
  assert.equal(first.code, 0)
  assert.equal(second.code, 0)
  assert.match(first.body.peer_id, /^12D3KooW/)
  assert.equal(first.body.peer_id, second.body.peer_id)
})

test('peer add, list, and rm manage friendly aliases', async () => {
  const a = await tmpAgent('peer-a')
  const b = await tmpAgent('peer-b')
  const bInit = await runJson(b, ['init'])
  await runJson(a, ['init'])

  const added = await runJson(a, [
    'peer',
    'add',
    bInit.body.peer_id,
    'bob',
    '/ip4/127.0.0.1/tcp/9999/ws',
    '/ip4/127.0.0.1/tcp/9998/ws'
  ])
  assert.equal(added.body.peer.name, 'bob')
  assert.equal(added.body.peer.addresses.length, 2)

  const listed = await runJson(a, ['peer', 'list'])
  assert.equal(listed.body.peers.length, 1)
  assert.equal(listed.body.peers[0].peer_id, bInit.body.peer_id)

  const removed = await runJson(a, ['peer', 'rm', 'bob'])
  assert.equal(removed.body.removed, 1)
})

test('contact card and peer import manage address cards', async () => {
  const a = await tmpAgent('contact-a')
  const b = await tmpAgent('contact-b')
  await runJson(a, ['init'])
  await runJson(b, ['init'])

  const relayAddr = '/ip4/127.0.0.1/tcp/9998/ws/p2p/12D3KooWKH1ZRuCPiKBEstLVrEZhZTu6JhEvVMKE6sLVmypfpkAz'
  const relay = await runJson(a, ['relay', 'add', relayAddr])
  assert.deepEqual(relay.body.relays, [relayAddr])

  const emptyCard = await runJson(a, ['contact', 'card'])
  assert.equal(emptyCard.body.peer_id, (await runJson(a, ['me'])).body.peer_id)
  assert.deepEqual(emptyCard.body.multiaddrs, [])

  const imported = await runJson(b, ['peer', 'import', 'alice', JSON.stringify({
    peer_id: emptyCard.body.peer_id,
    multiaddrs: ['/ip4/127.0.0.1/tcp/9999/ws', '/ip4/127.0.0.1/tcp/9997/ws']
  })])
  assert.equal(imported.body.peer.name, 'alice')
  assert.equal(imported.body.peer.addresses.length, 2)

  const listed = await runJson(b, ['peer', 'list'])
  assert.equal(listed.body.peers[0].name, 'alice')
})

test('message rejects bodies over 1000 UTF-8 bytes before dialing', async () => {
  const a = await tmpAgent('limit-a')
  const b = await tmpAgent('limit-b')
  const bInit = await runJson(b, ['init'])
  await runJson(a, ['init'])
  await runJson(a, ['peer', 'add', bInit.body.peer_id, 'bob', '/ip4/127.0.0.1/tcp/1'])

  const result = await runCli(a, ['message', 'bob', 'x'.repeat(1001)])
  assert.equal(result.code, 1)
  const err = JSON.parse(result.stderr)
  assert.match(err.error, /exceeds 1000/)
})

test('two local agents can send and persist a DM over WebSockets', async () => {
  const a = await tmpAgent('dm-a')
  const b = await tmpAgent('dm-b')
  await runJson(a, ['init'])
  const bInit = await runJson(b, ['init'])

  try {
    await runJson(b, ['daemon', 'start', '--listen', '/ip4/127.0.0.1/tcp/0/ws'])
    const started = await waitForDaemonJson(b)
    assert.equal(started.success, true)
    assert.ok(started.addresses.length > 0)
    const addr = started.addresses.find(addr => addr.includes('/ws') && !addr.includes('/p2p-circuit'))
    assert.ok(addr)
    const card = await runJson(b, ['contact', 'card'])
    assert.equal(card.body.peer_id, bInit.body.peer_id)
    assert.equal(card.body.success, undefined)
    assert.ok(card.body.multiaddrs.includes(addr))

    await runJson(a, ['peer', 'add', bInit.body.peer_id, 'bob', addr])
    const sent = await runJson(a, ['message', 'bob', 'hello'])
    assert.equal(sent.body.message.body, 'hello')

    await new Promise(resolve => setTimeout(resolve, 500))
    const inbox = await runJson(b, ['inbox'])
    assert.equal(inbox.body.messages.length, 1)
    assert.equal(inbox.body.messages[0].body, 'hello')
    assert.equal(inbox.body.messages[0].from, sent.body.message.from)
  } finally {
    await runJson(b, ['daemon', 'stop'])
  }
})

test('two local agents can send and persist a DM over circuit relay', async () => {
  const listener = await tmpAgent('relay-listener')
  const sender = await tmpAgent('relay-sender')
  const listenerInit = await runJson(listener, ['init'])
  await runJson(sender, ['init'])

  const relayServer = spawn(process.execPath, [relayHelper, '--listen', '/ip4/127.0.0.1/tcp/0/ws'])

  try {
    const relayStarted = await waitForProcessJson(relayServer, 'relay helper')
    const relayAddr = relayStarted.addresses[0]

    await runJson(listener, ['relay', 'add', relayAddr])
    await runJson(listener, ['daemon', 'start', '--listen', '/ip4/127.0.0.1/tcp/0/ws'])
    const started = await waitForDaemonJson(listener)
    const relayed = started.addresses.find(addr => addr.includes('/p2p-circuit/') && !addr.includes('/webrtc'))
    assert.ok(relayed)

    await runJson(sender, ['peer', 'add', listenerInit.body.peer_id, 'bob', relayed])
    const sent = await runJson(sender, ['message', 'bob', 'hello relay'])
    assert.equal(sent.body.message.body, 'hello relay')
    assert.match(sent.body.dialed, /p2p-circuit/)

    await new Promise(resolve => setTimeout(resolve, 500))
    const inbox = await runJson(listener, ['inbox'])
    assert.equal(inbox.body.messages.length, 1)
    assert.equal(inbox.body.messages[0].body, 'hello relay')

  } finally {
    await stopChild(relayServer)
    await runJson(listener, ['daemon', 'stop'])
  }
})

test('removed public receiver and relay server commands fail', async () => {
  const agent = await tmpAgent('removed-commands')
  await runJson(agent, ['init'])

  const serve = await runCli(agent, ['serve'])
  assert.equal(serve.code, 1)
  assert.match(JSON.parse(serve.stderr).error, /Usage: chatterp2p <init\|me\|contact\|peer\|message\|inbox\|read\|daemon\|network\|relay>/)

  const oldInvite = await runCli(agent, ['invite'])
  assert.equal(oldInvite.code, 1)
  assert.match(JSON.parse(oldInvite.stderr).error, /Usage: chatterp2p <init\|me\|contact\|peer\|message\|inbox\|read\|daemon\|network\|relay>/)

  const relayServer = await runCli(agent, ['relay', '--listen', '/ip4/127.0.0.1/tcp/0/ws'])
  assert.equal(relayServer.code, 1)
  assert.match(JSON.parse(relayServer.stderr).error, /Usage: chatterp2p relay <add\|list\|rm>/)
})
