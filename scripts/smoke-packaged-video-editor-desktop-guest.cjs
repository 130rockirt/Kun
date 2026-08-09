'use strict'

const { createHash } = require('node:crypto')
const { createServer: createHttpServer } = require('node:http')
const { createServer: createNetServer } = require('node:net')
const {
  EXTENSION_ID,
  EXTENSION_VERSION,
  MODEL_NAME,
  VIDEO_EDITOR_PERMISSIONS
} = require('./smoke-packaged-video-editor-desktop-constants.cjs')

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

function assertLocalizedFirstLaunchPermissionPrompt(prompt, { workspaceRoot }) {
  if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt)) {
    throw new Error(`Expected one localized protected ${EXTENSION_ID} permission prompt`)
  }
  const expectedFields = {
    title: '更改扩展权限',
    heading: '更改扩展权限',
    approveLabel: '同意更改',
    cancelLabel: '取消',
    approveVisible: true,
    cancelVisible: true,
    scrollOverflowY: 'auto'
  }
  for (const [field, expected] of Object.entries(expectedFields)) {
    if (JSON.stringify(prompt[field]) !== JSON.stringify(expected)) {
      throw new Error(
        `Localized permission prompt ${field} mismatch: expected ${JSON.stringify(expected)}, ` +
        `got ${JSON.stringify(prompt[field])}`
      )
    }
  }
  if (!prompt.message.includes(`${EXTENSION_ID} ${EXTENSION_VERSION}`)) {
    throw new Error(`Localized permission prompt omitted extension identity: ${prompt.message}`)
  }

  const expectedMeta = {
    扩展: `${EXTENSION_ID} ${EXTENSION_VERSION}`,
    操作: 'extension.permissions',
    工作区: workspaceRoot
  }
  if (JSON.stringify(prompt.meta) !== JSON.stringify(expectedMeta)) {
    throw new Error(
      `Localized permission prompt metadata mismatch: expected ${JSON.stringify(expectedMeta)}, ` +
      `got ${JSON.stringify(prompt.meta)}`
    )
  }

  const detailEvidence = [
    '此次权限变更仅适用于所选工作区。',
    '变更后的 Broker 权限：',
    'Kun 生成的风险摘要：',
    'Node 代码使用当前操作系统用户的权限运行。',
    '工作区读取权限可访问已批准工作区中的文件和扩展状态。',
    '工作区写入权限可在已批准的工作区中创建或修改文件。',
    '媒体读取权限可通过不透明授权检查用户选择的本地媒体。',
    '媒体处理和任务权限可运行并管理持久化的本地任务。',
    '媒体导出权限可写入用户批准的输出位置。',
    'Agent 和工具权限可启动私有 Agent 运行，并向 Kun 提供声明的工具。',
    '扩展 Node Host 本身并不是操作系统沙箱。',
    ...VIDEO_EDITOR_PERMISSIONS.map((permission) => `• ${permission}`)
  ]
  for (const evidence of detailEvidence) {
    if (!prompt.detail.includes(evidence)) {
      throw new Error(
        `Localized permission prompt omitted ${JSON.stringify(evidence)}: ${prompt.detail}`
      )
    }
  }
  if (
    !Number.isFinite(prompt.scrollClientHeight) || prompt.scrollClientHeight <= 0 ||
    !Number.isFinite(prompt.scrollHeight) || prompt.scrollHeight < prompt.scrollClientHeight
  ) {
    throw new Error(
      `Localized permission prompt review region cannot scroll safely: ${JSON.stringify(prompt)}`
    )
  }
  if (
    !Number.isFinite(prompt.viewportHeight) || prompt.viewportHeight <= 0 ||
    !Number.isFinite(prompt.scrollTop) || prompt.scrollTop < -1 ||
    !Number.isFinite(prompt.scrollBottom) ||
    !Number.isFinite(prompt.footerTop) || prompt.scrollBottom > prompt.footerTop + 1 ||
    !Number.isFinite(prompt.footerBottom) || prompt.footerBottom > prompt.viewportHeight + 1
  ) {
    throw new Error(
      `Localized permission prompt footer is outside the visible protected window: ${JSON.stringify(prompt)}`
    )
  }
  return prompt
}

async function hasVideoEditorGuest(electronApplication) {
  return electronApplication.evaluate(({ webContents }, extensionId) =>
    webContents.getAllWebContents().some((contents) =>
      contents.getType() === 'webview' &&
      contents.getURL().startsWith(`kun-extension://${extensionId}/`)
    ), EXTENSION_ID)
}

async function evaluateVideoEditorGuest(electronApplication, expression) {
  return electronApplication.evaluate(async ({ webContents }, input) => {
    const guest = webContents.getAllWebContents().find((contents) =>
      contents.getType() === 'webview' &&
      contents.getURL().startsWith(`kun-extension://${input.extensionId}/`)
    )
    if (!guest || guest.isDestroyed()) throw new Error('Kun Video Editor guest WebContents is unavailable')
    return guest.executeJavaScript(input.expression, true)
  }, { extensionId: EXTENSION_ID, expression })
}

async function readGuestSnapshot(electronApplication) {
  return evaluateVideoEditorGuest(electronApplication, `(() => {
    const text = document.body?.innerText ?? ''
    const projectSelect = document.querySelector('.project-controls select')
    const projectName = projectSelect?.selectedOptions?.[0]?.textContent?.split(' · r')[0]?.trim() ?? ''
    const revisionText = document.querySelector('.project-actions .revision-badge')?.textContent ?? ''
    return {
      ready: document.readyState === 'complete' && typeof globalThis.kunExtension?.request === 'function',
      busy: document.querySelector('#video-editor-main')?.getAttribute('aria-busy') === 'true',
      lang: document.documentElement.lang || '',
      theme: document.documentElement.dataset.theme || document.querySelector('.editor-app')?.dataset.theme || '',
      text: text.slice(0, 32_000),
      projectId: projectSelect?.value ?? '',
      projectName,
      revision: Number((revisionText.match(/r(\\d+)/) ?? [])[1] ?? -1),
      assets: [...document.querySelectorAll('.media-card strong')].map((node) => node.textContent?.trim() ?? ''),
      selectedAssetName: document.querySelector('.media-card[aria-pressed="true"] strong')?.textContent?.trim() ?? '',
      mediaSources: [...document.querySelectorAll('video[src], audio[src], img[src]')]
        .map((node) => ({ tag: node.tagName.toLowerCase(), src: node.getAttribute('src') ?? '' }))
        .slice(0, 8),
      transcriptCount: document.querySelectorAll('.transcript-row').length,
      captionCount: document.querySelectorAll('.caption-list li').length,
      jobStates: [...document.querySelectorAll('.job')].map((node) =>
        [...node.classList].find((name) => name.startsWith('job-') && name !== 'job')?.slice(4) ?? ''
      ).filter(Boolean),
      syncText: document.querySelector('.agent-sync-status')?.textContent?.trim() ?? '',
      capabilityTitle: document.querySelector('.connection[title]')?.getAttribute('title') ?? '',
      notices: [...document.querySelectorAll('.notice')].map((node) => ({
        className: node.className,
        text: node.textContent?.trim() ?? ''
      })).slice(0, 16),
      boundaryNotes: [...document.querySelectorAll('.boundary-note')]
        .map((node) => node.textContent?.trim() ?? '')
        .filter(Boolean)
        .slice(0, 12)
    }
  })()`)
}

async function waitForGuestSnapshot(electronApplication, predicate, description, timeoutMs) {
  let last
  try {
    return await pollUntil(async () => {
      last = await readGuestSnapshot(electronApplication)
      return predicate(last) ? last : undefined
    }, { timeoutMs, description })
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; ` +
      `last guest state: ${guestDiagnostic(last)}`
    )
  }
}

async function setGuestFormValue(electronApplication, selector, value) {
  const updated = await evaluateVideoEditorGuest(electronApplication, `(() => {
    const input = document.querySelector(${JSON.stringify(selector)})
    if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) return false
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    setter?.call(input, ${JSON.stringify(value)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  if (!updated) throw new Error(`Cannot set Kun Video Editor form control: ${selector}`)
}

async function submitGuestForm(electronApplication, selector) {
  const submitted = await evaluateVideoEditorGuest(electronApplication, `(() => {
    const form = document.querySelector(${JSON.stringify(selector)})
    if (!(form instanceof HTMLFormElement)) return false
    form.requestSubmit()
    return true
  })()`)
  if (!submitted) throw new Error(`Cannot submit Kun Video Editor form: ${selector}`)
}

async function clickGuestButton(electronApplication, text, withinSelector, timeoutMs = 15_000) {
  try {
    await pollUntil(() => evaluateVideoEditorGuest(electronApplication, `(() => {
      const root = ${withinSelector ? `document.querySelector(${JSON.stringify(withinSelector)})` : 'document'}
      if (!root) return false
      const button = [...root.querySelectorAll('button')].find((candidate) =>
        (
          candidate.textContent?.trim() === ${JSON.stringify(text)} ||
          candidate.querySelector('strong')?.textContent?.trim() === ${JSON.stringify(text)} ||
          candidate.childNodes[0]?.textContent?.trim() === ${JSON.stringify(text)}
        ) && !candidate.disabled
      )
      if (!button) return false
      button.click()
      return true
    })()`), {
      timeoutMs,
      description: `enabled video editor button ${JSON.stringify(text)}`
    })
  } catch (error) {
    const snapshot = await readGuestSnapshot(electronApplication).catch(() => undefined)
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}: ${guestDiagnostic(snapshot)}`
    )
  }
}

async function clickGuestSelector(electronApplication, selector, index = 0) {
  const clicked = await evaluateVideoEditorGuest(electronApplication, `(() => {
    const candidate = document.querySelectorAll(${JSON.stringify(selector)})[${Number(index)}]
    if (!(candidate instanceof HTMLElement) || candidate.matches(':disabled')) return false
    candidate.click()
    return true
  })()`)
  if (!clicked) throw new Error(`Cannot click video editor selector ${selector} at index ${index}`)
}

async function applyWorkbenchSettings(workbench, patch) {
  const result = await workbench.evaluate(async (settingsPatch) => {
    const saved = await globalThis.kunGui.setSettings(settingsPatch)
    globalThis.dispatchEvent(new CustomEvent('kun:settings-changed', { detail: saved }))
    return { locale: saved.locale, theme: saved.theme }
  }, patch)
  if (result.locale !== patch.locale || result.theme !== patch.theme) {
    throw new Error(`Kun did not persist locale/theme E2E patch: ${JSON.stringify(result)}`)
  }
}

async function startAgentToolTurn(workbench, workspaceRoot) {
  return workbench.evaluate(async ({ workspace, model }) => {
    const request = async (path, method, body) => {
      const response = await globalThis.kunGui.runtimeRequest(
        path,
        method,
        body === undefined ? undefined : JSON.stringify(body)
      )
      if (!response.ok) throw new Error(`${method} ${path} failed (${response.status}): ${response.body}`)
      return response.body ? JSON.parse(response.body) : undefined
    }
    const thread = await request('/v1/threads', 'POST', {
      title: 'Kun Video Editor desktop E2E Agent sync',
      workspace,
      model,
      mode: 'agent',
      approvalPolicy: 'auto',
      sandboxMode: 'danger-full-access'
    })
    const turn = await request(`/v1/threads/${encodeURIComponent(thread.id)}/turns`, 'POST', {
      prompt: 'Select the requested video project using the registered video-project extension tool.',
      model,
      approvalPolicy: 'auto',
      sandboxMode: 'danger-full-access',
      disableUserInput: true
    })
    return { threadId: thread.id, turnId: turn.turnId }
  }, { workspace: workspaceRoot, model: MODEL_NAME })
}

async function waitForAgentTurn(workbench, turn, timeoutMs) {
  return pollUntil(async () => {
    const response = await workbench.evaluate(async ({ threadId, turnId }) => {
      return globalThis.kunGui.runtimeRequest(
        `/v1/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}`,
        'GET'
      )
    }, turn)
    if (!response.ok) throw new Error(`Cannot read Agent E2E turn (${response.status}): ${response.body}`)
    const body = JSON.parse(response.body)
    return ['completed', 'failed', 'aborted'].includes(body.status) ? body : undefined
  }, { timeoutMs, description: 'Main Agent extension-tool turn completion' })
}

async function startOfflineModelFixture() {
  const state = {
    targetProjectId: '',
    requests: 0,
    toolCallIssued: false,
    toolResultObserved: false,
    lastToolNames: [],
    lastPath: ''
  }
  const server = createHttpServer(async (request, response) => {
    state.lastPath = request.url ?? ''
    if (request.method === 'GET' && /\/models(?:\?|$)/u.test(request.url ?? '')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ object: 'list', data: [{ id: MODEL_NAME, object: 'model' }] }))
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'offline model fixture only supports POST chat completions' } }))
      return
    }
    let body = ''
    for await (const chunk of request) body = `${body}${String(chunk)}`.slice(-4 * 1024 * 1024)
    let parsed
    try {
      parsed = JSON.parse(body)
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'invalid JSON' } }))
      return
    }
    state.requests += 1
    const toolNames = Array.isArray(parsed.tools)
      ? parsed.tools.map((tool) => tool?.function?.name).filter((name) => typeof name === 'string')
      : []
    state.lastToolNames = toolNames
    const projectTool = toolNames.find((name) => name.endsWith('_video-project'))
    const messages = Array.isArray(parsed.messages) ? parsed.messages : []
    const sawToolResult = messages.some((message) => message?.role === 'tool')
    if (sawToolResult) state.toolResultObserved = true

    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    if (!state.toolCallIssued && state.targetProjectId && projectTool) {
      state.toolCallIssued = true
      for (const frame of openAiToolCallFrames({
        toolName: projectTool,
        argumentsJson: JSON.stringify({ action: 'select', projectId: state.targetProjectId })
      })) response.write(frame)
    } else {
      for (const frame of openAiTextFrames(
        sawToolResult
          ? 'Kun Video Editor desktop E2E selected the project through the extension tool.'
          : 'Kun Video Editor desktop E2E model fixture is ready.'
      )) response.write(frame)
    }
    response.end()
  })
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  if (!port) throw new Error('Could not start the offline desktop E2E model fixture')
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    setTargetProjectId(projectId) {
      state.targetProjectId = projectId
      state.toolCallIssued = false
      state.toolResultObserved = false
    },
    snapshot() {
      return structuredClone(state)
    },
    close() {
      return new Promise((resolvePromise, reject) => {
        server.close((error) => error ? reject(error) : resolvePromise())
        server.closeAllConnections?.()
      })
    }
  }
}

function openAiToolCallFrames({ toolName, argumentsJson }) {
  const id = 'chatcmpl-kun-video-editor-desktop-e2e'
  return [
    sseFrame({
      id,
      object: 'chat.completion.chunk',
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: 'call_video_project_desktop_e2e',
            type: 'function',
            function: { name: toolName, arguments: argumentsJson }
          }]
        },
        finish_reason: null
      }]
    }),
    sseFrame({
      id,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
    }),
    'data: [DONE]\n\n'
  ]
}

function openAiTextFrames(text) {
  const id = 'chatcmpl-kun-video-editor-desktop-e2e-text'
  return [
    sseFrame({
      id,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }]
    }),
    sseFrame({
      id,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
    }),
    'data: [DONE]\n\n'
  ]
}

function sseFrame(value) {
  return `data: ${JSON.stringify(value)}\n\n`
}

function assertNoGuestErrors(snapshot, operation) {
  const errors = snapshot.notices.filter(({ className }) => /notice-error/u.test(className))
  if (errors.length > 0) {
    throw new Error(
      `Kun Video Editor reported an error while ${operation}: ${JSON.stringify(errors)}. ` +
      `Capability guidance: ${snapshot.capabilityTitle || snapshot.boundaryNotes.join(' | ') || 'none'}. ` +
      'For media failures: Install FFmpeg with libx264 and AAC plus ffprobe, or set absolute ' +
      `KUN_FFMPEG_PATH/KUN_FFPROBE_PATH values. Guest state: ${guestDiagnostic(snapshot)}`
    )
  }
}

function guestDiagnostic(snapshot) {
  if (!snapshot) return 'unavailable'
  return JSON.stringify({
    ready: snapshot.ready,
    busy: snapshot.busy,
    lang: snapshot.lang,
    theme: snapshot.theme,
    projectId: snapshot.projectId,
    projectName: snapshot.projectName,
    revision: snapshot.revision,
    assets: snapshot.assets,
    selectedAssetName: snapshot.selectedAssetName,
    mediaSources: snapshot.mediaSources,
    transcriptCount: snapshot.transcriptCount,
    captionCount: snapshot.captionCount,
    jobStates: snapshot.jobStates,
    syncText: snapshot.syncText,
    capabilityTitle: snapshot.capabilityTitle,
    notices: snapshot.notices,
    text: snapshot.text?.slice(0, 2_000)
  })
}

async function pollUntil(operation, { timeoutMs, description, intervalMs = 100 }) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const result = await operation()
      if (result) return result
    } catch (error) {
      lastError = error
    }
    await delay(intervalMs)
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${description}` +
    `${lastError ? `; last error: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ''}`
  )
}

async function availablePort() {
  const server = createNetServer()
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise())
  })
  if (!port) throw new Error('Could not allocate a desktop E2E runtime port')
  return port
}

function sha256FileBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}


module.exports = {
  assertLocalizedFirstLaunchPermissionPrompt,
  hasVideoEditorGuest,
  evaluateVideoEditorGuest,
  readGuestSnapshot,
  waitForGuestSnapshot,
  setGuestFormValue,
  submitGuestForm,
  clickGuestButton,
  clickGuestSelector,
  applyWorkbenchSettings,
  startAgentToolTurn,
  waitForAgentTurn,
  startOfflineModelFixture,
  openAiToolCallFrames,
  openAiTextFrames,
  sseFrame,
  assertNoGuestErrors,
  guestDiagnostic,
  pollUntil,
  availablePort,
  sha256FileBytes
}
