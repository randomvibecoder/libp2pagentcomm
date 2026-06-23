import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import { webRTC } from '@libp2p/webrtc'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { dcutr } from '@libp2p/dcutr'
import { ping } from '@libp2p/ping'
import { multiaddr } from '@multiformats/multiaddr'
import { peerIdFromString } from '@libp2p/peer-id'
import { MAX_MESSAGE_BYTES, PROTOCOL } from './constants.js'
import { appendMessage, loadConfig, loadIdentity, messageId } from './storage.js'

function toBytes (chunk) {
  if (chunk instanceof Uint8Array) return chunk
  if (typeof chunk.subarray === 'function') return chunk.subarray()
  return Uint8Array.from(chunk)
}

async function readStream (stream, limit = MAX_MESSAGE_BYTES + 4096) {
  const chunks = []
  let size = 0
  for await (const chunk of stream) {
    const bytes = toBytes(chunk)
    size += bytes.byteLength
    if (size > limit) throw new Error('Incoming stream exceeded size limit.')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8')
}

export function normalizeAddrForPeer (addr, peerId) {
  const text = addr.toString()
  return text.includes('/p2p/') ? text : `${text}/p2p/${peerId}`
}

export async function createNode ({ listen, useConfiguredRelays = true, onMessage } = {}) {
  const { privateKey } = await loadIdentity()
  const cfg = await loadConfig()
  const services = {
    identify: identify(),
    dcutr: dcutr(),
    ping: ping()
  }
  const configuredRelays = useConfiguredRelays ? cfg.relays : []
  const listenAddrs = listen ?? cfg.listen
  const relayListenAddrs = configuredRelays.length > 0 ? ['/p2p-circuit', '/webrtc'] : []

  const node = await createLibp2p({
    privateKey,
    addresses: {
      listen: [...listenAddrs, ...relayListenAddrs]
    },
    transports: [
      tcp(),
      webSockets(),
      circuitRelayTransport(),
      webRTC()
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: {
      denyDialMultiaddr: () => false
    },
    services
  })

  for (const addr of configuredRelays) {
    try {
      await node.dial(multiaddr(addr), { signal: AbortSignal.timeout(5000) })
    } catch (err) {
      process.stderr.write(`${JSON.stringify({ event: 'relay_dial_error', relay: addr, error: err.message })}\n`)
    }
  }

  if (onMessage != null) {
    await node.handle(PROTOCOL, async (stream, connection) => {
      try {
        const raw = await readStream(stream)
        const parsed = JSON.parse(raw)
        const bodyBytes = Buffer.byteLength(parsed.body ?? '', 'utf8')
        if (bodyBytes > MAX_MESSAGE_BYTES) throw new Error('Message body exceeds 1000 bytes.')
        const message = {
          id: parsed.id || messageId(),
          from: parsed.from || connection.remotePeer.toString(),
          to: parsed.to,
          sent_at: parsed.sent_at || new Date().toISOString(),
          received_at: new Date().toISOString(),
          body: parsed.body
        }
        await appendMessage(message)
        await onMessage(message)
      } catch (err) {
        process.stderr.write(`${JSON.stringify({ event: 'message_error', error: err.message })}\n`)
        throw err
      }
    }, {
      runOnLimitedConnection: true
    })
  }

  return node
}

export async function sendMessage ({ peer, body }) {
  const bodyBytes = Buffer.byteLength(body, 'utf8')
  if (bodyBytes > MAX_MESSAGE_BYTES) {
    throw new Error(`Message body exceeds ${MAX_MESSAGE_BYTES} UTF-8 bytes.`)
  }
  if (peer.addresses.length === 0) {
    throw new Error(`Peer has no known addresses: ${peer.name}`)
  }

  const { peerId } = await loadIdentity()
  peerIdFromString(peer.peer_id)
  const node = await createNode({ listen: [], useConfiguredRelays: false })
  try {
    const addrs = peer.addresses.map(addr => multiaddr(normalizeAddrForPeer(addr, peer.peer_id)))
    let lastErr
    for (const addr of addrs) {
      try {
        const stream = await node.dialProtocol(addr, PROTOCOL, {
          runOnLimitedConnection: true,
          signal: AbortSignal.timeout(10000)
        })
        const msg = {
          id: messageId(),
          from: peerId.toString(),
          to: peer.peer_id,
          sent_at: new Date().toISOString(),
          body
        }
        stream.send(new TextEncoder().encode(JSON.stringify(msg)))
        await stream.close()
        return { message: msg, dialed: addr.toString() }
      } catch (err) {
        lastErr = err
      }
    }
    throw lastErr ?? new Error('No dial attempts were made.')
  } finally {
    await node.stop()
  }
}

export async function pingPeer ({ peer }) {
  if (peer.addresses.length === 0) {
    throw new Error(`Peer has no known addresses: ${peer.name}`)
  }
  const node = await createNode({ listen: [], useConfiguredRelays: false })
  try {
    let lastErr
    for (const addrText of peer.addresses) {
      const addr = multiaddr(normalizeAddrForPeer(addrText, peer.peer_id))
      try {
        const latency = await node.services.ping.ping(addr, { signal: AbortSignal.timeout(5000) })
        return { peer_id: peer.peer_id, name: peer.name, dialed: addr.toString(), latency_ms: Number(latency) }
      } catch (err) {
        lastErr = err
      }
    }
    throw lastErr ?? new Error('No ping attempts were made.')
  } finally {
    await node.stop()
  }
}
