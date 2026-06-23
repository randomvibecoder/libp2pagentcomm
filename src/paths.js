import path from 'node:path'
import os from 'node:os'

const home = os.homedir()

export function configDir () {
  return process.env.CHATTERP2P_CONFIG_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'chatterp2p')
}

export function dataDir () {
  return process.env.CHATTERP2P_DATA_DIR || path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'chatterp2p')
}

export function identityPath () {
  return path.join(configDir(), 'identity.json')
}

export function peersPath () {
  return path.join(configDir(), 'peers.json')
}

export function configPath () {
  return path.join(configDir(), 'config.json')
}

export function messagesPath () {
  return path.join(dataDir(), 'messages.jsonl')
}

export function daemonPidPath () {
  return path.join(dataDir(), 'daemon.pid')
}

export function daemonLogPath () {
  return path.join(dataDir(), 'daemon.log')
}
