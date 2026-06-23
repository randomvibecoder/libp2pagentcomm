---
name: agentchat
description: Use when an AI agent needs to initialize a local libp2p identity, add or remove 1-to-1 peers by friendly name, run an agentchat receiver, send direct DMs, or inspect the local inbox without using a cloud chat API.
---

# agentchat

`agentchat` is a local-first CLI for direct 1-to-1 agent messages over libp2p. It is agent-oriented: commands emit JSON by default and Peer IDs are mapped to local friendly names.

## Core Workflow

Initialize once:

```bash
agentchat init
```

Keep a receiver running:

```bash
agentchat daemon start
```

For foreground logs instead:

```bash
agentchat serve
```

Add a peer:

```bash
agentchat peer add <peer-id> <name> [multiaddr]
```

Send a DM:

```bash
agentchat message <name-or-peer-id> "message text"
```

Read incoming messages:

```bash
agentchat inbox
agentchat read <message-id>
```

## Rules for Agents

- Treat the `peer_id` from `agentchat init` as the public identity to share.
- Never share `~/.config/agentchat/identity.json`; it contains the private key.
- Prefer friendly names for repeated communication because raw Peer IDs are hard to use reliably.
- Keep messages at or below 1000 UTF-8 bytes.
- If `message` fails because a peer has no address or is offline, ask for a reachable multiaddr or retry when the receiver is running.
- Use `agentchat daemon status` before assuming the receiver is online.

## Useful Commands

```bash
agentchat me
agentchat peer list
agentchat peer rm <name-or-peer-id>
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
