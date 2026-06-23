import { daemonLogPath, identityPath, messagesPath, peersPath } from './paths.js'
import { createNode } from './p2p.js'
import { loadIdentity, loadOrCreateIdentity } from './storage.js'

export function parseReceiverOptions (args) {
  const opts = { listen: [] }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--listen') {
      const addr = args[++i]
      if (addr == null) throw new Error('Usage: chatterp2p daemon start [--listen <multiaddr>]')
      opts.listen.push(addr)
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return opts
}

export async function runReceiver (args = []) {
  const opts = parseReceiverOptions(args)
  await loadOrCreateIdentity()
  const node = await createNode({
    listen: opts.listen.length > 0 ? opts.listen : undefined,
    onMessage: async message => {
      process.stdout.write(`${JSON.stringify({ event: 'message_received', message })}\n`)
    }
  })
  const { peerId } = await loadIdentity()
  await new Promise(resolve => setTimeout(resolve, 1500))
  process.stdout.write(`${JSON.stringify({
    success: true,
    mode: 'daemon',
    peer_id: peerId.toString(),
    addresses: node.getMultiaddrs().map(a => a.toString()),
    paths: {
      identity: identityPath(),
      peers: peersPath(),
      messages: messagesPath(),
      log: daemonLogPath()
    }
  }, null, 2)}\n`)
  await new Promise(resolve => {
    process.once('SIGINT', resolve)
    process.once('SIGTERM', resolve)
  })
  await node.stop()
}
