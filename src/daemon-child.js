#!/usr/bin/env node
import { runReceiver } from './receiver.js'

runReceiver(process.argv.slice(2)).catch(err => {
  process.stderr.write(`${JSON.stringify({ success: false, error: err.message }, null, 2)}\n`)
  process.exitCode = 1
})
