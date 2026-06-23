import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import crypto from 'node:crypto'
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey, peerIdFromString } from '@libp2p/peer-id'
import { multiaddr } from '@multiformats/multiaddr'
import { DEFAULT_LISTEN_ADDRS } from './constants.js'
import { configDir, configPath, dataDir, identityPath, messagesPath, peersPath } from './paths.js'

async function ensureDirs () {
  await fs.mkdir(configDir(), { recursive: true, mode: 0o700 })
  await fs.mkdir(dataDir(), { recursive: true, mode: 0o700 })
}

async function readJson (file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return fallback
    throw err
  }
}

async function writeJson (file, data, mode = 0o600) {
  await ensureDirs()
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { mode })
}

export async function loadOrCreateIdentity () {
  await ensureDirs()
  if (existsSync(identityPath())) {
    return loadIdentity()
  }

  const privateKey = await generateKeyPair('Ed25519')
  const peerId = peerIdFromPrivateKey(privateKey)
  const encoded = Buffer.from(privateKeyToProtobuf(privateKey)).toString('base64')
  await writeJson(identityPath(), {
    type: 'Ed25519',
    private_key_protobuf_base64: encoded,
    peer_id: peerId.toString(),
    created_at: new Date().toISOString()
  })
  await loadConfig()
  await loadPeers()
  return { privateKey, peerId }
}

export async function loadIdentity () {
  const saved = await readJson(identityPath(), null)
  if (saved == null) {
    throw new Error('Identity not initialized. Run `agentchat init` first.')
  }
  const privateKey = privateKeyFromProtobuf(Buffer.from(saved.private_key_protobuf_base64, 'base64'))
  const peerId = peerIdFromPrivateKey(privateKey)
  return { privateKey, peerId }
}

export async function loadConfig () {
  const cfg = await readJson(configPath(), null)
  if (cfg != null) {
    return {
      listen: cfg.listen ?? DEFAULT_LISTEN_ADDRS,
      bootstrap: cfg.bootstrap ?? [],
      relays: cfg.relays ?? []
    }
  }
  const created = {
    listen: DEFAULT_LISTEN_ADDRS,
    bootstrap: [],
    relays: []
  }
  await writeJson(configPath(), created)
  return created
}

export async function saveConfig (cfg) {
  await writeJson(configPath(), {
    listen: cfg.listen ?? DEFAULT_LISTEN_ADDRS,
    bootstrap: cfg.bootstrap ?? [],
    relays: cfg.relays ?? []
  })
}

export async function addRelay (addr) {
  multiaddr(addr)
  const cfg = await loadConfig()
  if (!cfg.relays.includes(addr)) cfg.relays.push(addr)
  await saveConfig(cfg)
  return cfg.relays
}

export async function removeRelay (addr) {
  const cfg = await loadConfig()
  const before = cfg.relays.length
  cfg.relays = cfg.relays.filter(existing => existing !== addr)
  cfg.bootstrap = cfg.bootstrap.filter(existing => existing !== addr)
  await saveConfig(cfg)
  return before - cfg.relays.length
}

export async function importPeerContact (input, localName) {
  let payload = input
  if (typeof input === 'string') {
    try {
      payload = JSON.parse(input)
    } catch {
      const raw = await fs.readFile(input, 'utf8')
      payload = JSON.parse(raw)
    }
  }

  const card = payload.agentchat ?? payload
  const peerId = card.peer_id ?? card.peerId
  const name = localName ?? card.name ?? card.alias
  const addrs = [
    ...(card.multiaddr != null ? [card.multiaddr] : []),
    ...(card.multiaddrs ?? []),
    ...(card.direct_addresses ?? []),
    ...(card.relay_addresses ?? [])
  ].filter(Boolean)

  if (peerId == null || name == null) {
    throw new Error('Contact card must include peer_id and peer import must include a local name.')
  }
  if (addrs.length === 0) {
    throw new Error('Contact card must include at least one multiaddr.')
  }

  let peer
  for (const addr of addrs) {
    peer = await addPeer(peerId, name, addr)
  }
  return peer
}

export async function loadPeers () {
  const peers = await readJson(peersPath(), null)
  if (peers != null) return peers
  const created = { peers: [] }
  await writeJson(peersPath(), created)
  return created
}

export async function savePeers (peers) {
  await writeJson(peersPath(), peers)
}

export async function addPeer (peerIdText, name, addr) {
  const peerId = peerIdFromString(peerIdText).toString()
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
    throw new Error('Peer name must be 1-64 chars using letters, numbers, dot, underscore, or hyphen.')
  }
  if (addr == null) throw new Error('Peer multiaddr is required.')
  multiaddr(addr)

  const book = await loadPeers()
  if (book.peers.some(p => p.name === name && p.peer_id !== peerId)) {
    throw new Error(`Peer name already exists for a different Peer ID: ${name}`)
  }
  const existing = book.peers.find(p => p.peer_id === peerId || p.name === name)
  if (existing != null) {
    existing.peer_id = peerId
    existing.name = name
    if (!existing.addresses.includes(addr)) existing.addresses.push(addr)
    existing.updated_at = new Date().toISOString()
  } else {
    book.peers.push({
      peer_id: peerId,
      name,
      addresses: [addr],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
  }
  await savePeers(book)
  return book.peers.find(p => p.peer_id === peerId)
}

export async function removePeer (nameOrPeerId) {
  const book = await loadPeers()
  const before = book.peers.length
  book.peers = book.peers.filter(p => p.name !== nameOrPeerId && p.peer_id !== nameOrPeerId)
  await savePeers(book)
  return before - book.peers.length
}

export async function findPeer (nameOrPeerId) {
  const book = await loadPeers()
  return book.peers.find(p => p.name === nameOrPeerId || p.peer_id === nameOrPeerId)
}

export function messageId () {
  return `msg_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`
}

export async function appendMessage (message) {
  await ensureDirs()
  await fs.appendFile(messagesPath(), `${JSON.stringify(message)}\n`, { mode: 0o600 })
}

export async function listMessages () {
  try {
    const raw = await fs.readFile(messagesPath(), 'utf8')
    return raw.split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
}
