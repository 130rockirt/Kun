import type {
  BrowserUseActionConsentRequest
} from '../../shared/browser-use'
import type {
  BrowserUseActionInput as BrowserUseAction,
  BrowserUseKunApprovalGrant,
  BrowserUseKunApprovalMode,
  BrowserUseToolResult as BrowserUseResult
} from '../../../kun/src/contracts/browser-use.js'
import { sanitizeBrowserUseUrl } from './network-policy'
import { BrowserUseManagerNavigation } from './browser-use-manager-navigation'
import {
  PREPARED_ACTION_TTL_MS,
  BrowserUseOperationAbortedError,
  auditDecision,
  dispatchClick,
  dispatchKey,
  errorMessage,
  isForbiddenCommitTarget,
  isLowRiskAutomaticAction,
  isSensitiveTarget,
  randomToken,
  resultError,
  resultOk,
  safeOrigin,
  sanitizePageTitle,
  type BrowserSessionEntry,
  type BrowserTab,
  type PreparedAction
} from './browser-use-manager-support'

export abstract class BrowserUseManagerInteractions extends BrowserUseManagerNavigation {
  protected async interact(
    entry: BrowserSessionEntry,
    action: Extract<BrowserUseAction, { action: 'click' | 'type' | 'select' | 'press' }>,
    reviewerSource: BrowserUseKunApprovalMode | undefined,
    signal: AbortSignal
  ): Promise<BrowserUseResult> {
    const tab = this.requireActiveTab(entry)
    const documentGeneration = entry.documentGeneration
    this.assertOperationActive(entry, signal, tab, documentGeneration)
    const target = entry.refs.get(action.ref)
    if (!target || target.tabId !== tab.id || target.documentGeneration !== entry.documentGeneration) {
      return resultError(
        'stale_reference',
        'The element reference is stale or belongs to another browser document. Take a new snapshot.',
        entry,
        tab.id
      )
    }
    const snapshotUrl = tab.view.webContents.getURL()
    const liveOrigin = safeOrigin(snapshotUrl) ?? ''
    const liveSanitizedUrl = sanitizeBrowserUseUrl(snapshotUrl)
    if (
      action.expectedTarget.sessionId !== entry.id ||
      action.expectedTarget.tabId !== tab.id ||
      action.expectedTarget.documentGeneration !== entry.documentGeneration ||
      action.expectedTarget.origin !== liveOrigin ||
      action.expectedTarget.sanitizedUrl !== liveSanitizedUrl ||
      action.expectedTarget.role !== target.role ||
      action.expectedTarget.name !== target.name
    ) {
      return resultError(
        'target_binding_mismatch',
        'The expected Browser Use target does not match the referenced snapshot target.',
        entry,
        tab.id
      )
    }
    const current = await this.liveTarget(entry, tab, target, signal)
    this.assertOperationActive(entry, signal, tab, documentGeneration)
    if (!current || current.fingerprint !== target.fingerprint) {
      this.invalidateTarget(entry, action.ref)
      return resultError(
        'stale_reference',
        'The live target changed. Take a new snapshot before trying again.',
        entry,
        tab.id
      )
    }
    const currentUrl = tab.view.webContents.getURL()
    if (
      action.expectedTarget.sessionId !== entry.id ||
      action.expectedTarget.tabId !== tab.id ||
      action.expectedTarget.documentGeneration !== entry.documentGeneration ||
      action.expectedTarget.origin !== (safeOrigin(currentUrl) ?? '') ||
      action.expectedTarget.sanitizedUrl !== sanitizeBrowserUseUrl(currentUrl) ||
      action.expectedTarget.role !== current.role ||
      action.expectedTarget.name !== current.name
    ) {
      this.invalidateTarget(entry, action.ref)
      return resultError(
        'target_binding_mismatch',
        'The live Browser Use target changed from the reviewer-visible binding.',
        entry,
        tab.id
      )
    }
    if (current.disabled) {
      this.invalidateTarget(entry, action.ref)
      return resultError(
        'target_disabled',
        'The referenced Browser Use target is disabled.',
        entry,
        tab.id
      )
    }
    if (current.sensitive || isForbiddenCommitTarget(current.name, current.role)) {
      return resultError(
        'manual_interaction_required',
        'Authentication, credentials, transactions, publishing, destructive, permission, and other committing targets require manual control.',
        entry,
        tab.id
      )
    }
    const prepared: PreparedAction = {
      id: randomToken(),
      action,
      target: current,
      origin: safeOrigin(tab.view.webContents.getURL()) ?? '',
      createdAt: this.now().getTime(),
      expiresAt: this.now().getTime() + PREPARED_ACTION_TTL_MS,
      used: false
    }
    this.assertOperationActive(entry, signal, tab, documentGeneration)
    entry.prepared.set(prepared.id, prepared)
    const risk = action.action === 'type' ? 'text-entry' : 'interaction'
    const settings = this.options.settings()
    const requiresConsent = settings.approvalMode === 'always-ask' ||
      entry.mode === 'local-development' ||
      !isLowRiskAutomaticAction(action, current)
    if (requiresConsent) {
      if (!(await this.ensureSupervised(entry, signal))) {
        entry.prepared.delete(prepared.id)
        return resultError(
          'interaction_required',
          'Browser Use requires its authenticated floating preview for this approval.',
          entry,
          tab.id
        )
      }
      if (signal.aborted || entry.stopping) {
        entry.prepared.delete(prepared.id)
        return resultError('aborted', 'Browser Use action was cancelled.', entry, tab.id)
      }
      const previewDataUrl = await this.highlightedPreview(
        entry,
        tab,
        current.backendNodeId,
        signal,
        documentGeneration
      )
      if (signal.aborted || entry.stopping) {
        entry.prepared.delete(prepared.id)
        return resultError('aborted', 'Browser Use action was cancelled.', entry, tab.id)
      }
      const request: BrowserUseActionConsentRequest = {
        id: prepared.id,
        sessionId: entry.id,
        threadId: entry.threadId,
        tabId: tab.id,
        origin: prepared.origin,
        pageTitle: sanitizePageTitle(tab.view.webContents.getTitle()),
        action: action.action,
        risk,
        targetRole: current.role,
        targetName: current.name,
        ...('text' in action ? { textPreview: action.text.slice(0, 512) } : {}),
        ...('value' in action ? { textPreview: action.value.slice(0, 512) } : {}),
        targetRect: current.rect,
        ...(previewDataUrl ? { previewDataUrl } : {}),
        expiresAt: new Date(prepared.expiresAt).toISOString()
      }
      this.assertOperationActive(entry, signal, tab, documentGeneration)
      const decisionPromise = this.awaitActionDecision(entry, request)
      entry.pendingAction = request
      entry.lifecycle = 'waiting-action-consent'
      this.publish(entry)
      const decision = await decisionPromise
      this.assertOperationActive(entry, signal, tab, documentGeneration)
      entry.pendingAction = undefined
      entry.lifecycle = 'ready'
      this.publish(entry)
      this.audit(entry, {
        category: 'action-consent',
        action: action.action,
        origin: prepared.origin,
        risk,
        ...(reviewerSource ? { reviewerSource } : {}),
        decision: auditDecision(decision),
        outcome: decision === 'allow-once' ? 'success' : 'blocked',
        targetLabel: current.role.slice(0, 128)
      }, tab.id)
      if (decision !== 'allow-once') {
        entry.prepared.delete(prepared.id)
        return resultError(
          decision === 'expired'
            ? 'consent_expired'
            : decision === 'cancelled'
              ? 'consent_cancelled'
              : 'consent_denied',
          'The Browser Use action was not allowed.',
          entry,
          tab.id
        )
      }
    } else {
      this.audit(entry, {
        category: 'action-consent',
        action: `auto-${action.action}`,
        origin: prepared.origin,
        risk,
        ...(reviewerSource ? { reviewerSource } : {}),
        decision: 'allowed',
        outcome: 'success',
        targetLabel: current.role.slice(0, 128)
      }, tab.id)
    }
    const validation = await this.validatePreparedAction(entry, tab, prepared, signal)
    if (!validation.ok) {
      entry.prepared.delete(prepared.id)
      return resultError(validation.code, validation.message, entry, tab.id)
    }
    this.assertOperationActive(entry, signal, tab, documentGeneration)
    prepared.used = true
    entry.prepared.delete(prepared.id)
    if (signal.aborted || entry.stopping) {
      return resultError('aborted', 'Browser Use action was cancelled.', entry, tab.id)
    }
    try {
      await this.withAgentInputDispatch(entry, () =>
        this.executePrepared(entry, tab, prepared, signal))
      if (signal.aborted || entry.stopping) {
        return resultError('aborted', 'Browser Use action was cancelled.', entry, tab.id)
      }
      this.audit(entry, {
        category: 'execution',
        action: action.action,
        origin: prepared.origin,
        risk,
        ...(reviewerSource ? { reviewerSource } : {}),
        decision: 'allowed',
        outcome: 'success',
        targetLabel: current.role.slice(0, 128)
      }, tab.id)
      return resultOk(
        'action_executed',
        `Executed validated ${action.action} once. Take a new snapshot to verify the page state.`,
        entry,
        tab.id
      )
    } catch (error) {
      if (
        error instanceof BrowserUseOperationAbortedError ||
        signal.aborted ||
        entry.stopping
      ) {
        return resultError('aborted', 'Browser Use action was cancelled.', entry, tab.id)
      }
      this.audit(entry, {
        category: 'execution',
        action: action.action,
        origin: prepared.origin,
        risk,
        ...(reviewerSource ? { reviewerSource } : {}),
        outcome: 'error',
        errorCode: 'action_failed',
        targetLabel: current.role.slice(0, 128)
      }, tab.id)
      return resultError('action_failed', errorMessage(error), entry, tab.id)
    }
  }

  protected async validatePreparedAction(
    entry: BrowserSessionEntry,
    tab: BrowserTab,
    prepared: PreparedAction,
    signal: AbortSignal
  ): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
    this.assertOperationActive(
      entry,
      signal,
      tab,
      prepared.target.documentGeneration
    )
    const now = this.now().getTime()
    if (prepared.used || now > prepared.expiresAt || entry.prepared.get(prepared.id) !== prepared) {
      return { ok: false, code: 'prepared_action_expired', message: 'Prepared action expired or was already used.' }
    }
    const expectedTarget = prepared.action.expectedTarget
    const currentUrl = tab.view.webContents.getURL()
    if (
      expectedTarget.sessionId !== entry.id ||
      expectedTarget.tabId !== tab.id ||
      expectedTarget.documentGeneration !== entry.documentGeneration ||
      expectedTarget.origin !== (safeOrigin(currentUrl) ?? '') ||
      expectedTarget.sanitizedUrl !== sanitizeBrowserUseUrl(currentUrl) ||
      expectedTarget.role !== prepared.target.role ||
      expectedTarget.name !== prepared.target.name ||
      prepared.target.tabId !== tab.id ||
      prepared.target.documentGeneration !== entry.documentGeneration ||
      prepared.origin !== (safeOrigin(currentUrl) ?? '')
    ) {
      return {
        ok: false,
        code: 'target_binding_mismatch',
        message: 'The reviewer-visible Browser Use target changed while consent was pending.'
      }
    }
    const current = await this.liveTarget(entry, tab, prepared.target, signal)
    this.assertOperationActive(
      entry,
      signal,
      tab,
      prepared.target.documentGeneration
    )
    if (!current) {
      return { ok: false, code: 'target_changed', message: 'The target changed while consent was pending.' }
    }
    if (current.disabled) {
      return { ok: false, code: 'target_disabled', message: 'The target became disabled while consent was pending.' }
    }
    const verifiedUrl = tab.view.webContents.getURL()
    if (
      expectedTarget.sessionId !== entry.id ||
      expectedTarget.tabId !== tab.id ||
      expectedTarget.documentGeneration !== entry.documentGeneration ||
      expectedTarget.origin !== (safeOrigin(verifiedUrl) ?? '') ||
      expectedTarget.sanitizedUrl !== sanitizeBrowserUseUrl(verifiedUrl) ||
      expectedTarget.role !== current.role ||
      expectedTarget.name !== current.name
    ) {
      return {
        ok: false,
        code: 'target_binding_mismatch',
        message: 'The live Browser Use target no longer matches the reviewer-visible binding.'
      }
    }
    if (current.fingerprint !== prepared.target.fingerprint) {
      return { ok: false, code: 'target_changed', message: 'The target changed while consent was pending.' }
    }
    const centerX = Math.round(current.rect.x + current.rect.width / 2)
    const centerY = Math.round(current.rect.y + current.rect.height / 2)
    const resolved = await tab.view.webContents.debugger.sendCommand('DOM.resolveNode', {
      backendNodeId: current.backendNodeId
    }) as { object?: { objectId?: string } }
    this.assertOperationActive(
      entry,
      signal,
      tab,
      prepared.target.documentGeneration
    )
    const objectId = resolved.object?.objectId
    if (!objectId) {
      return { ok: false, code: 'target_changed', message: 'The target is no longer resolvable.' }
    }
    const hit = await tab.view.webContents.debugger.sendCommand('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration:
        'function(x,y){const e=document.elementFromPoint(x,y);return !!e&&(e===this||this.contains(e));}',
      arguments: [{ value: centerX }, { value: centerY }],
      returnByValue: true,
      silent: true
    }) as { result?: { value?: unknown } }
    this.assertOperationActive(
      entry,
      signal,
      tab,
      prepared.target.documentGeneration
    )
    if (hit.result?.value !== true) {
      return { ok: false, code: 'target_changed', message: 'The target is no longer the live hit target.' }
    }
    return { ok: true }
  }

  protected async executePrepared(
    entry: BrowserSessionEntry,
    tab: BrowserTab,
    prepared: PreparedAction,
    signal: AbortSignal
  ): Promise<void> {
    const target = prepared.target
    const x = Math.round(target.rect.x + target.rect.width / 2)
    const y = Math.round(target.rect.y + target.rect.height / 2)
    const assertActive = () => this.assertOperationActive(
      entry,
      signal,
      tab,
      target.documentGeneration
    )
    assertActive()
    if (prepared.action.action === 'click') {
      await dispatchClick(tab, x, y, assertActive)
      return
    }
    if (prepared.action.action === 'type') {
      await this.focusPreparedTarget(tab, target.backendNodeId, assertActive, true)
      await tab.view.webContents.debugger.sendCommand('Input.insertText', {
        text: prepared.action.text
      })
      assertActive()
      return
    }
    if (prepared.action.action === 'press') {
      await this.focusPreparedTarget(tab, target.backendNodeId, assertActive, false)
      await dispatchKey(tab, prepared.action.key, assertActive)
      return
    }
    const resolved = await tab.view.webContents.debugger.sendCommand('DOM.resolveNode', {
      backendNodeId: target.backendNodeId
    }) as { object?: { objectId?: string } }
    assertActive()
    const objectId = resolved.object?.objectId
    if (!objectId) throw new Error('Select target is no longer resolvable.')
    const selected = await tab.view.webContents.debugger.sendCommand('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration:
        'function(value){if(!(this instanceof HTMLSelectElement)||this.disabled)return false;const option=Array.from(this.options).find((item)=>item.value===value&&!item.disabled);if(!option)return false;this.value=value;if(this.value!==value)return false;this.dispatchEvent(new Event("input",{bubbles:true}));this.dispatchEvent(new Event("change",{bubbles:true}));return this.value===value;}',
      arguments: [{ value: prepared.action.value }],
      returnByValue: true,
      silent: true
    }) as { result?: { value?: unknown } }
    assertActive()
    if (selected.result?.value !== true) {
      throw new Error('Select option is unavailable or the page rejected the value.')
    }
  }

  private async focusPreparedTarget(
    tab: BrowserTab,
    backendNodeId: number,
    assertActive: () => void,
    requireEditable: boolean
  ): Promise<void> {
    assertActive()
    const resolved = await tab.view.webContents.debugger.sendCommand('DOM.resolveNode', {
      backendNodeId
    }) as { object?: { objectId?: string } }
    assertActive()
    const objectId = resolved.object?.objectId
    if (!objectId) throw new Error('Target is no longer resolvable for focus.')
    const focused = await tab.view.webContents.debugger.sendCommand('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: requireEditable
        ? 'function(){const textTypes=new Set(["","text","search","url","tel","email","number"]);const editable=(this instanceof HTMLInputElement&&textTypes.has(this.type))||this instanceof HTMLTextAreaElement||this.isContentEditable;if(!editable||this.disabled||this.readOnly)return false;this.focus({preventScroll:true});return document.activeElement===this;}'
        : 'function(){if(!(this instanceof HTMLElement)||this.matches(":disabled")||this.getAttribute("aria-disabled")==="true")return false;this.focus({preventScroll:true});return document.activeElement===this;}',
      returnByValue: true,
      silent: true
    }) as { result?: { value?: unknown } }
    assertActive()
    if (focused.result?.value !== true) {
      throw new Error(requireEditable
        ? 'Type target is not an enabled editable text control.'
        : 'Press target could not receive focus safely.')
    }
  }

  protected async scroll(
    entry: BrowserSessionEntry,
    direction: 'up' | 'down' | 'left' | 'right',
    amount: number,
    signal: AbortSignal
  ): Promise<BrowserUseResult> {
    const tab = this.requireActiveTab(entry)
    const documentGeneration = entry.documentGeneration
    this.assertOperationActive(entry, signal, tab, documentGeneration)
    const horizontal = direction === 'left' || direction === 'right'
    await this.withAgentInputDispatch(entry, () =>
      tab.view.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: Math.max(1, Math.round((entry.mount?.bounds.width ?? 800) / 2)),
        y: Math.max(1, Math.round((entry.mount?.bounds.height ?? 600) / 2)),
        deltaX: horizontal ? (direction === 'left' ? -amount : amount) : 0,
        deltaY: horizontal ? 0 : (direction === 'up' ? -amount : amount)
      }))
    this.assertOperationActive(entry, signal, tab, documentGeneration)
    return resultOk('scrolled', `Scrolled ${direction} by ${amount}px.`, entry, tab.id)
  }

}
