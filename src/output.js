export function ok (data = {}) {
  process.stdout.write(`${JSON.stringify({ success: true, ...data }, null, 2)}\n`)
}

export function fail (message, code = 'ERROR', details = {}, exitCode = 1) {
  process.stderr.write(`${JSON.stringify({ success: false, error: message, code, ...details }, null, 2)}\n`)
  process.exitCode = exitCode
}
