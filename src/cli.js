#!/usr/bin/env node
import { daemonStatus, readDaemonInfo, startDaemon, stopDaemon } from './daemon.js'
import { configPath, daemonLogPath, identityPath, messagesPath, peersPath } from './paths.js'
import { createNode, pingPeer, sendMessage } from './p2p.js'
import { addPeer, addRelay, findPeer, importPeerInvite, listMessages, loadConfig, loadIdentity, loadOrCreateIdentity, loadPeers, removePeer, removeRelay } from './storage.js'
import { fail, ok } from './output.js'

function parseOptions (args) {
  const positional = []
  const opts = { listen: [], bootstrap: [] }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--listen') opts.listen.push(args[++i])
    else if (arg === '--bootstrap') opts.bootstrap.push(args[++i])
    else if (arg === '--daemon-child') opts.daemonChild = true
    else positional.push(arg)
  }
  return { positional, opts }
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function main () {
  const [cmd, subcmd, ...rest] = process.argv.slice(2)
  const commandArgs = process.argv.slice(2)
  const { positional, opts } = parseOptions(rest)

  if (cmd === 'init') {
    const { peerId } = await loadOrCreateIdentity()
    return ok({
      peer_id: peerId.toString(),
      paths: {
        identity: identityPath(),
        config: configPath(),
        peers: peersPath(),
        messages: messagesPath()
      }
    })
  }

  if (cmd === 'me') {
    const { peerId } = await loadIdentity()
    const cfg = await loadConfig()
    return ok({ peer_id: peerId.toString(), listen: cfg.listen, bootstrap: cfg.bootstrap, relays: cfg.relays })
  }

  if (cmd === 'peer') {
    if (subcmd === 'add') {
      const [peerId, name, addr] = positional
      if (peerId == null || name == null) throw new Error('Usage: agentchat peer add <peer-id> <name> [multiaddr]')
      return ok({ peer: await addPeer(peerId, name, addr) })
    }
    if (subcmd === 'rm') {
      const [nameOrPeerId] = positional
      if (nameOrPeerId == null) throw new Error('Usage: agentchat peer rm <name-or-peer-id>')
      return ok({ removed: await removePeer(nameOrPeerId) })
    }
    if (subcmd === 'list') {
      return ok(await loadPeers())
    }
    if (subcmd === 'import') {
      const input = positional.join(' ')
      if (input.length === 0) throw new Error('Usage: agentchat peer import <json-or-file>')
      return ok({ peer: await importPeerInvite(input) })
    }
    if (subcmd === 'ping') {
      const [nameOrPeerId] = positional
      if (nameOrPeerId == null) throw new Error('Usage: agentchat peer ping <name-or-peer-id>')
      const peer = await findPeer(nameOrPeerId)
      if (peer == null) throw new Error(`Unknown peer: ${nameOrPeerId}`)
      return ok(await pingPeer({ peer }))
    }
    throw new Error('Usage: agentchat peer <add|rm|list|import|ping>')
  }

  if (cmd === 'message') {
    const [nameOrPeerId, ...bodyParts] = [subcmd, ...positional]
    const body = bodyParts.join(' ')
    if (nameOrPeerId == null || body.length === 0) throw new Error('Usage: agentchat message <name-or-peer-id> <message>')
    const peer = await findPeer(nameOrPeerId)
    if (peer == null) throw new Error(`Unknown peer: ${nameOrPeerId}`)
    const result = await sendMessage({ peer, body })
    return ok(result)
  }

  if (cmd === 'inbox') {
    return ok({ messages: await listMessages() })
  }

  if (cmd === 'read') {
    const id = subcmd
    if (id == null) throw new Error('Usage: agentchat read <message-id>')
    const msg = (await listMessages()).find(m => m.id === id)
    if (msg == null) throw new Error(`Message not found: ${id}`)
    return ok({ message: msg })
  }

  if (cmd === 'daemon') {
    if (subcmd === 'start') return ok(await startDaemon(rest))
    if (subcmd === 'status') return ok(await daemonStatus())
    if (subcmd === 'stop') return ok(await stopDaemon())
    throw new Error('Usage: agentchat daemon <start|status|stop>')
  }

  if (cmd === 'invite') {
    const { peerId } = await loadIdentity()
    const cfg = await loadConfig()
    const info = await readDaemonInfo()
    const addresses = info?.addresses ?? []
    const direct = addresses.filter(addr => !addr.includes('/p2p-circuit') && !addr.includes('/webrtc'))
    const relayAddrs = addresses.filter(addr => addr.includes('/p2p-circuit') || addr.includes('/webrtc'))
    return ok({
      agentchat: {
        peer_id: peerId.toString(),
        name: subcmd ?? positional[0] ?? 'agent',
        multiaddrs: addresses,
        direct_addresses: direct,
        relay_addresses: relayAddrs,
        configured_relays: cfg.relays
      },
      daemon_running: (await daemonStatus()).running,
      hint: addresses.length === 0 ? 'Start `agentchat daemon start` or `agentchat serve` to advertise live dialable addresses.' : undefined
    })
  }

  if (cmd === 'network') {
    if (subcmd === 'status') {
      const { peerId } = await loadIdentity()
      const cfg = await loadConfig()
      const daemon = await daemonStatus()
      const info = await readDaemonInfo()
      return ok({
        peer_id: peerId.toString(),
        daemon,
        listen: cfg.listen,
        relays: cfg.relays,
        bootstrap: cfg.bootstrap,
        advertised_addresses: info?.addresses ?? []
      })
    }
    throw new Error('Usage: agentchat network status')
  }

  if (cmd === 'serve' || cmd === 'relay') {
    if (cmd === 'relay' && ['add', 'list', 'rm'].includes(subcmd)) {
      if (subcmd === 'add') {
        const [addr] = positional
        if (addr == null) throw new Error('Usage: agentchat relay add <relay-multiaddr>')
        return ok({ relays: await addRelay(addr) })
      }
      if (subcmd === 'list') {
        const cfg = await loadConfig()
        return ok({ relays: cfg.relays })
      }
      if (subcmd === 'rm') {
        const [addr] = positional
        if (addr == null) throw new Error('Usage: agentchat relay rm <relay-multiaddr>')
        return ok({ removed: await removeRelay(addr) })
      }
    }
    const { opts: serveOpts } = parseOptions(commandArgs.slice(1))
    await loadOrCreateIdentity()
    const relay = cmd === 'relay'
    const node = await createNode({
      relay,
      listen: serveOpts.listen.length > 0 ? serveOpts.listen : undefined,
      bootstrapAddrs: serveOpts.bootstrap,
      onMessage: async message => {
        process.stdout.write(`${JSON.stringify({ event: 'message_received', message })}\n`)
      }
    })
    const { peerId } = await loadIdentity()
    await sleep(1500)
    process.stdout.write(`${JSON.stringify({
      success: true,
      mode: relay ? 'relay' : 'serve',
      peer_id: peerId.toString(),
      addresses: node.getMultiaddrs().map(a => a.toString()),
      log: serveOpts.daemonChild ? daemonLogPath() : undefined
    }, null, 2)}\n`)
    await new Promise(resolve => {
      process.once('SIGINT', resolve)
      process.once('SIGTERM', resolve)
    })
    await node.stop()
    return
  }

  throw new Error('Usage: agentchat <init|me|invite|peer|message|inbox|read|daemon|network|serve|relay>')
}

main().catch(err => fail(err.message, err.code || 'ERROR'))
