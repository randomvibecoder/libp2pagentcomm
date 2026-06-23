import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { daemonLogPath, daemonPidPath } from './paths.js'
import { parseReceiverOptions } from './receiver.js'

export async function startDaemon (extraArgs = []) {
  parseReceiverOptions(extraArgs)
  if (existsSync(daemonPidPath())) {
    const current = await daemonStatus()
    if (current.running) return current
    await fs.rm(daemonPidPath(), { force: true })
  }
  await fs.mkdir(path.dirname(daemonLogPath()), { recursive: true })
  const out = await fs.open(daemonLogPath(), 'a')
  const child = spawn(process.execPath, [new URL('./daemon-child.js', import.meta.url).pathname, ...extraArgs], {
    detached: true,
    stdio: ['ignore', out.fd, out.fd]
  })
  child.unref()
  await fs.writeFile(daemonPidPath(), `${child.pid}\n`, { mode: 0o600 })
  await out.close()
  return { running: true, pid: child.pid, log: daemonLogPath() }
}

export async function daemonStatus () {
  try {
    const pid = Number((await fs.readFile(daemonPidPath(), 'utf8')).trim())
    process.kill(pid, 0)
    return { running: true, pid, log: daemonLogPath() }
  } catch {
    return { running: false }
  }
}

export async function stopDaemon () {
  const status = await daemonStatus()
  if (!status.running) return { stopped: false }
  process.kill(status.pid, 'SIGTERM')
  await fs.rm(daemonPidPath(), { force: true })
  return { stopped: true, pid: status.pid }
}

export async function readDaemonInfo () {
  try {
    const raw = await fs.readFile(daemonLogPath(), 'utf8')
    const lines = raw.split('\n')
    let acc = ''
    let latest = null
    for (const line of lines) {
      if (line.trim() === '' && acc === '') continue
      acc += `${line}\n`
      try {
        const parsed = JSON.parse(acc)
        if (parsed.success === true && Array.isArray(parsed.addresses)) latest = parsed
        acc = ''
      } catch {}
    }
    if (latest != null) return latest
  } catch {}
  return null
}
