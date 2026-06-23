import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const cli = path.resolve('src/cli.js')

async function tmpAgent (name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `agentchat-${name}-`))
  return {
    root,
    env: {
      ...process.env,
      AGENTCHAT_CONFIG_DIR: path.join(root, 'config'),
      AGENTCHAT_DATA_DIR: path.join(root, 'data')
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

async function waitForServeJson (child) {
  let stdout = ''
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`serve did not start: ${stdout}`)), 10000)
    child.stdout.on('data', chunk => {
      stdout += chunk
      try {
        const parsed = JSON.parse(stdout)
        clearTimeout(timer)
        resolve(parsed)
      } catch {}
    })
    child.stderr.on('data', chunk => {
      stdout += chunk
    })
    child.on('exit', code => reject(new Error(`serve exited early with ${code}: ${stdout}`)))
  })
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

  const added = await runJson(a, ['peer', 'add', bInit.body.peer_id, 'bob', '/ip4/127.0.0.1/tcp/9999/ws'])
  assert.equal(added.body.peer.name, 'bob')

  const listed = await runJson(a, ['peer', 'list'])
  assert.equal(listed.body.peers.length, 1)
  assert.equal(listed.body.peers[0].peer_id, bInit.body.peer_id)

  const removed = await runJson(a, ['peer', 'rm', 'bob'])
  assert.equal(removed.body.removed, 1)
})

test('relay add, invite, and peer import manage contact cards', async () => {
  const a = await tmpAgent('invite-a')
  const b = await tmpAgent('invite-b')
  await runJson(a, ['init'])
  await runJson(b, ['init'])

  const relayAddr = '/ip4/127.0.0.1/tcp/9998/ws/p2p/12D3KooWKH1ZRuCPiKBEstLVrEZhZTu6JhEvVMKE6sLVmypfpkAz'
  const relay = await runJson(a, ['relay', 'add', relayAddr])
  assert.deepEqual(relay.body.relays, [relayAddr])

  const invite = await runJson(a, ['invite', 'alice'])
  assert.equal(invite.body.agentchat.name, 'alice')
  assert.equal(invite.body.agentchat.configured_relays[0], relayAddr)

  const imported = await runJson(b, ['peer', 'import', JSON.stringify({
    agentchat: {
      peer_id: invite.body.agentchat.peer_id,
      name: 'alice',
      multiaddrs: ['/ip4/127.0.0.1/tcp/9999/ws']
    }
  })])
  assert.equal(imported.body.peer.name, 'alice')

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

  const server = spawn(process.execPath, [cli, 'serve', '--listen', '/ip4/127.0.0.1/tcp/0/ws'], {
    env: b.env
  })
  try {
    const started = await waitForServeJson(server)
    assert.equal(started.success, true)
    assert.ok(started.addresses.length > 0)

    await runJson(a, ['peer', 'add', bInit.body.peer_id, 'bob', started.addresses[0]])
    const sent = await runJson(a, ['message', 'bob', 'hello'])
    assert.equal(sent.body.message.body, 'hello')

    await new Promise(resolve => setTimeout(resolve, 500))
    const inbox = await runJson(b, ['inbox'])
    assert.equal(inbox.body.messages.length, 1)
    assert.equal(inbox.body.messages[0].body, 'hello')
    assert.equal(inbox.body.messages[0].from, sent.body.message.from)
  } finally {
    server.kill('SIGTERM')
  }
})

test('two local agents can send and persist a DM over circuit relay', async () => {
  const relay = await tmpAgent('relay')
  const listener = await tmpAgent('relay-listener')
  const sender = await tmpAgent('relay-sender')
  const relayInit = await runJson(relay, ['init'])
  const listenerInit = await runJson(listener, ['init'])
  await runJson(sender, ['init'])

  const relayServer = spawn(process.execPath, [cli, 'relay', '--listen', '/ip4/127.0.0.1/tcp/0/ws'], {
    env: relay.env
  })
  const listenerServer = spawn(process.execPath, [cli, 'serve', '--listen', '/ip4/127.0.0.1/tcp/0/ws'], {
    env: listener.env
  })
  let listenerWithRelay

  try {
    const relayStarted = await waitForServeJson(relayServer)
    assert.equal(relayStarted.peer_id, relayInit.body.peer_id)
    const relayAddr = relayStarted.addresses[0]

    await runJson(listener, ['relay', 'add', relayAddr])
    listenerServer.kill('SIGTERM')
    await new Promise(resolve => listenerServer.once('close', resolve))

    listenerWithRelay = spawn(process.execPath, [cli, 'serve', '--listen', '/ip4/127.0.0.1/tcp/0/ws'], {
      env: listener.env
    })
    const started = await waitForServeJson(listenerWithRelay)
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

    listenerWithRelay.kill('SIGTERM')
  } finally {
    relayServer.kill('SIGTERM')
    listenerServer.kill('SIGTERM')
    listenerWithRelay?.kill('SIGTERM')
  }
})
