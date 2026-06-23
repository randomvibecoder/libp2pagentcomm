#!/usr/bin/env node
import { daemonStatus, readDaemonInfo, startDaemon, stopDaemon } from './daemon.js'
import { configPath, identityPath, messagesPath, peersPath } from './paths.js'
import { pingPeer, sendMessage } from './p2p.js'
import { addPeer, addRelay, findPeer, importPeerContact, listMessages, loadConfig, loadIdentity, loadOrCreateIdentity, loadPeers, removePeer, removeRelay } from './storage.js'
import { fail, ok } from './output.js'

async function main () {
  const [cmd, subcmd, ...rest] = process.argv.slice(2)

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
      const [peerId, name, ...addrs] = rest
      if (peerId == null || name == null || addrs.length === 0) throw new Error('Usage: agentchat peer add <peer-id> <name> <multiaddr...>')
      let peer
      for (const addr of addrs) {
        peer = await addPeer(peerId, name, addr)
      }
      return ok({ peer })
    }
    if (subcmd === 'rm') {
      const [nameOrPeerId] = rest
      if (nameOrPeerId == null) throw new Error('Usage: agentchat peer rm <name-or-peer-id>')
      return ok({ removed: await removePeer(nameOrPeerId) })
    }
    if (subcmd === 'list') {
      return ok(await loadPeers())
    }
    if (subcmd === 'import') {
      const [name, ...inputParts] = rest
      const input = inputParts.join(' ')
      if (name == null || input.length === 0) throw new Error('Usage: agentchat peer import <name> <json-or-file>')
      return ok({ peer: await importPeerContact(input, name) })
    }
    if (subcmd === 'ping') {
      const [nameOrPeerId] = rest
      if (nameOrPeerId == null) throw new Error('Usage: agentchat peer ping <name-or-peer-id>')
      const peer = await findPeer(nameOrPeerId)
      if (peer == null) throw new Error(`Unknown peer: ${nameOrPeerId}`)
      return ok(await pingPeer({ peer }))
    }
    throw new Error('Usage: agentchat peer <add|rm|list|import|ping>')
  }

  if (cmd === 'message') {
    const [nameOrPeerId, ...bodyParts] = [subcmd, ...rest]
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

  if (cmd === 'contact') {
    if (subcmd !== 'card') throw new Error('Usage: agentchat contact card')
    const { peerId } = await loadIdentity()
    const info = await readDaemonInfo()
    process.stdout.write(`${JSON.stringify({
      peer_id: peerId.toString(),
      multiaddrs: info?.addresses ?? []
    }, null, 2)}\n`)
    return
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

  if (cmd === 'relay') {
    if (subcmd === 'add') {
      const [addr] = rest
      if (addr == null) throw new Error('Usage: agentchat relay add <relay-multiaddr>')
      return ok({ relays: await addRelay(addr) })
    }
    if (subcmd === 'list') {
      const cfg = await loadConfig()
      return ok({ relays: cfg.relays })
    }
    if (subcmd === 'rm') {
      const [addr] = rest
      if (addr == null) throw new Error('Usage: agentchat relay rm <relay-multiaddr>')
      return ok({ removed: await removeRelay(addr) })
    }
    throw new Error('Usage: agentchat relay <add|list|rm>')
  }

  throw new Error('Usage: agentchat <init|me|contact|peer|message|inbox|read|daemon|network|relay>')
}

main().catch(err => fail(err.message, err.code || 'ERROR'))
