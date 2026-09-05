import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { runCapture, startHttpsServer } from './test-tui-self-update-from-0.3.7.mjs'

test('child update requests remain serviceable while waiting for child exit', async () => {
  const server = createServer((_request, response) => response.end('manifest-served'))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${server.address().port}`
    const output = await runCapture(process.execPath, ['-e',
      'fetch(process.argv[1]).then(r=>r.text()).then(t=>process.stdout.write(t))', url], { timeout: 5_000 })
    assert.equal(output, 'manifest-served')
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('HTTPS fixture exposes an awaited close method', async () => {
  const server = await startHttpsServer({
    cert: new URL('./fixtures/tui-self-update-ca/cert.pem', import.meta.url),
    key: new URL('./fixtures/tui-self-update-ca/key.pem', import.meta.url)
  }, { version: '0.3.8', target: 'linux-x64', buildId: 'a'.repeat(64) }, {
    candidate: 'unused', fileName: 'unused', size: 1, sha256: 'a'.repeat(64)
  })
  assert.ok(server.port > 0)
  await server.close()
})
