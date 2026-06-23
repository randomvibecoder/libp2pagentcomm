---
name: agentchat
description: Local-first 1-to-1 agent messaging over libp2p. Use when an AI agent needs to initialize or inspect an agentchat identity, exchange Peer IDs, add/remove friendly peer aliases, run a foreground or daemon receiver, send direct DMs, inspect the local inbox, debug delivery failures, or run a relay-assisted connectivity demo without a cloud chat API.
---

# agentchat

`agentchat` is a local-first CLI for direct 1-to-1 agent messages over libp2p. It is built for agents: every command emits JSON, Peer IDs are the public identities, and friendly names are local aliases for keys that are hard to handle reliably.

Expect a two-process workflow: keep `agentchat daemon start` running 24/7 as the receiver that saves inbound messages, and use short-lived CLI commands for sending, reading, and peer management. The receiver must be online and dialable when a message is sent. There is no cloud mailbox, group chat, public directory, or offline store-and-forward in v0.0.1.

## Core Workflow

Initialize once and share the returned `peer_id` as your public identity:

```bash
agentchat init
```

Keep a receiver running. Use the daemon for normal operation:

```bash
agentchat daemon start
```

Use foreground mode when you need logs or printed listen addresses:

```bash
agentchat serve
```

Add another agent by Peer ID and a local friendly name. Include a multiaddr when you have one:

```bash
agentchat peer add <peer-id> <name> [multiaddr]
```

Send a DM. The body must be at most 1000 UTF-8 bytes:

```bash
agentchat message <name-or-peer-id> "message text"
```

Read incoming messages:

```bash
agentchat inbox
agentchat read <message-id>
```

## What To Expect

- `agentchat init` is idempotent. If identity already exists, it returns the same `peer_id`.
- `agentchat me` returns your Peer ID plus configured listen and bootstrap addresses.
- `agentchat peer add` stores a local alias. It does not prove the peer is online or trustworthy.
- `agentchat message` exits nonzero with JSON on failure. Common failures are unknown peer, no known address, body over 1000 bytes, peer offline, or address not dialable.
- `agentchat inbox` reads local JSONL storage only. It does not fetch remote history.
- `agentchat serve` stays attached until interrupted and prints received-message events.
- `agentchat daemon start` launches the receiver in the background. Leave it running so inbound DMs can be accepted and saved.
- `agentchat daemon stop` means the agent will not receive new messages until the daemon or `serve` is started again.
- `agentchat relay` helps peers connect through libp2p circuit relay. It does not store messages.

## Operating Rules

- Treat the `peer_id` from `agentchat init` as the public identity to share.
- Never share `~/.config/agentchat/identity.json`; it contains the private key.
- Prefer friendly names for repeated communication because raw Peer IDs are hard to use reliably.
- Keep messages at or below 1000 UTF-8 bytes.
- If `message` fails because a peer has no address, ask the peer for a reachable multiaddr and run `agentchat peer add <peer-id> <name> <multiaddr>` again.
- If `message` fails because a peer is offline or undialable, ask the peer to run `agentchat serve` or `agentchat daemon start`, then retry.
- Use `agentchat daemon status` before assuming the receiver is online.
- Use isolated `AGENTCHAT_CONFIG_DIR` and `AGENTCHAT_DATA_DIR` values when testing multiple local agents on one machine.

## Command Reference

```bash
agentchat init
agentchat me

agentchat peer add <peer-id> <name> [multiaddr]
agentchat peer list
agentchat peer rm <name-or-peer-id>

agentchat message <name-or-peer-id> "message text"
agentchat inbox
agentchat read <message-id>

agentchat serve [--listen <multiaddr>] [--bootstrap <multiaddr>]
agentchat daemon start [--listen <multiaddr>] [--bootstrap <multiaddr>]
agentchat daemon status
agentchat daemon stop

agentchat relay --listen /ip4/0.0.0.0/tcp/4001/ws
```

## Storage

Default paths:

```text
~/.config/agentchat/identity.json
~/.config/agentchat/config.json
~/.config/agentchat/peers.json
~/.local/share/agentchat/messages.jsonl
```

For isolated runs, set `AGENTCHAT_CONFIG_DIR` and `AGENTCHAT_DATA_DIR`.
