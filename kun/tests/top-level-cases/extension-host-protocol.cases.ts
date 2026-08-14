import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ExtensionApiError } from '@kun/extension-api'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  ExtensionHostProcess,
  ExtensionLogWriter,
  ExtensionManager,
  ExtensionPaths,
  JsonRpcPeer,
  isViewIdleDeactivationEligible,
  manifestCompatibilityReport,
  parseExtensionManifest,
  type ExtensionCompatibility,
  type ExtensionPackageManager,
  type JsonValue,
  type ResolvedExtension,
  type RpcEnvelope
} from '../../src/extensions/index.js'
import { admissionFor, buildBuiltinRunner, eventually, fixturePackageManager, hostCompatibility, writeFixtureRunner, writeHandshakeMismatchRunner, writeResolvedExtension } from '../support/extension-host-fixtures.js'

  it('supports typed requests, cancellation, ordered stream acknowledgements, and bounds', async () => {
    let left!: JsonRpcPeer
    let right!: JsonRpcPeer
    let cancelledRequests = 0
    let releaseRequest!: () => void
    const requestGate = new Promise<void>((resolvePromise) => {
      releaseRequest = resolvePromise
    })
    let releaseStream!: () => void
    const streamGate = new Promise<void>((resolvePromise) => {
      releaseStream = resolvePromise
    })
    right = new JsonRpcPeer({
      send: async (envelope) => left.receive(structuredClone(envelope)),
      onRequest: async (method, params, context) => {
        if (method === 'echo') return params
        if (method === 'hold') {
          await requestGate
          return { released: true }
        }
        if (method === 'wait') {
          await new Promise<void>((_resolve, reject) => {
            context.signal.addEventListener('abort', () => {
              cancelledRequests += 1
              reject(new Error('cancelled'))
            }, { once: true })
          })
        }
        return null
      },
      onStream: async () => streamGate,
      maxMessageBytes: 512
    })
    left = new JsonRpcPeer({
      send: async (envelope) => right.receive(structuredClone(envelope)),
      maxMessageBytes: 512,
      maxConcurrentRequests: 1,
      streamWindow: 1
    })

    await expect(left.request('echo', { ok: true })).resolves.toEqual({ ok: true })
    const held = left.request('hold', null)
    await eventually(() => expect(left.pendingRequestCount).toBe(1))
    await expect(left.request('echo', null)).rejects.toMatchObject({
      code: 'EXTENSION_HOST_CONCURRENCY_LIMIT'
    })
    releaseRequest()
    await expect(held).resolves.toEqual({ released: true })

    const controller = new AbortController()
    const waiting = left.request('wait', null, { signal: controller.signal })
    controller.abort()
    await expect(waiting).rejects.toMatchObject({ code: 'EXTENSION_HOST_CANCELLED' })
    await eventually(() => expect(cancelledRequests).toBe(1))
    await expect(left.request('wait', null, { timeoutMs: 20 })).rejects.toMatchObject({
      code: 'EXTENSION_HOST_TIMEOUT'
    })
    await eventually(() => expect(cancelledRequests).toBe(2))

    const firstStream = left.sendStream('stream_1', { value: 1 })
    await expect(left.sendStream('stream_1', { value: 2 })).rejects.toMatchObject({
      code: 'EXTENSION_STREAM_BACKPRESSURE'
    })
    releaseStream()
    await expect(firstStream).resolves.toBeUndefined()

    await expect(
      left.receive({
        rpcVersion: 1,
        kind: 'notification',
        method: 'large',
        params: { value: 'x'.repeat(1_000) }
      })
    ).rejects.toMatchObject({ code: 'EXTENSION_HOST_MESSAGE_LIMIT' })
    left.close()
    right.close()
  })

  it('round-trips bundled public API errors without trusting unbranded error-shaped objects', async () => {
    let left!: JsonRpcPeer
    let right!: JsonRpcPeer
    right = new JsonRpcPeer({
      send: async (envelope) => left.receive(structuredClone(envelope)),
      onRequest: async (method) => {
        if (method === 'public-error') {
          const error = new ExtensionApiError({
            code: 'CONFLICT',
            message: 'The expected revision is stale.',
            retryable: true,
            details: {
              expectedRevision: 7,
              actualRevision: 8,
              authToken: 'must-not-cross-the-rpc-boundary'
            }
          })
          Object.setPrototypeOf(error, Error.prototype)
          throw error
        }
        throw Object.assign(new Error('untrusted implementation detail'), {
          code: 'CONFLICT',
          retryable: true,
          details: { leaked: true }
        })
      }
    })
    left = new JsonRpcPeer({
      send: async (envelope) => right.receive(structuredClone(envelope))
    })

    const publicError = await left.request('public-error', null).catch((error: unknown) => error)
    expect(publicError).toBeInstanceOf(ExtensionApiError)
    expect(publicError).toMatchObject({
      code: 'CONFLICT',
      message: 'The expected revision is stale.',
      retryable: true,
      details: {
        expectedRevision: 7,
        actualRevision: 8,
        authToken: '<redacted>'
      }
    })
    await expect(left.request('error-shaped-object', null)).rejects.toMatchObject({
      code: 'EXTENSION_INTERNAL_ERROR',
      message: 'Extension operation failed',
      details: {}
    })
    left.close()
    right.close()
  })
