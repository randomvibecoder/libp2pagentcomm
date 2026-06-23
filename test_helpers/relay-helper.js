import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import { circuitRelayServer } from '@libp2p/circuit-relay-v2'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { dcutr } from '@libp2p/dcutr'
import { generateKeyPair } from '@libp2p/crypto/keys'

function parseArgs (args) {
  const opts = { listen: ['/ip4/127.0.0.1/tcp/0/ws'] }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--listen') opts.listen = [args[++i]]
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return opts
}

const opts = parseArgs(process.argv.slice(2))
const privateKey = await generateKeyPair('Ed25519')
const node = await createLibp2p({
  privateKey,
  addresses: { listen: opts.listen },
  transports: [tcp(), webSockets()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  connectionGater: { denyDialMultiaddr: () => false },
  services: {
    identify: identify(),
    dcutr: dcutr(),
    relay: circuitRelayServer()
  }
})

process.stdout.write(`${JSON.stringify({
  success: true,
  peer_id: node.peerId.toString(),
  addresses: node.getMultiaddrs().map(addr => addr.toString())
}, null, 2)}\n`)

await new Promise(resolve => {
  process.once('SIGINT', resolve)
  process.once('SIGTERM', resolve)
})
await node.stop()
