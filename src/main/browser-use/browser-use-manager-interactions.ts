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
  auditDecision,
  dispatchClick,
  dispatchKey,
  errorMessage,
  isForbiddenCommitTarget,
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
    kunApprovalSource?: Exclude<BrowserUseKunApprovalMode, 'full-access'>
  ): Promise<BrowserUseResult> {
    const tab = this.requireActiveTab(entry)
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
    const current = await this.liveTarget(entry, tab, target)
    if (!current || current.fingerprint !== target.fingerprint) {
      this.invalidateDocument(entry, 'target-changed')
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
      this.invalidateDocument(entry, 'target-binding-changed')
      return resultError(
        'target_binding_mismatch',
        'The live Browser Use target changed from the reviewer-visible binding.',
        entry,
        tab.id
      )
    }
    if (current.sensitive || isForbiddenCommitTarget(current.name)) {
      return resultError(
        'manual_interaction_required',
        'Credentials, payment, MFA, file upload, and destructive transaction targets require manual control.',
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
    entry.prepared.set(prepared.id, prepared)
    const risk = action.action === 'type' ? 'text-entry' : 'interaction'
    const settings = this.options.settings()
    const requiresConsent = !kunApprovalSource && (
      settings.approvalMode === 'always-ask' ||
      entry.mode === 'local-development'
    )
    if (requiresConsent) {
      if (!(await this.ensureSupervised(entry))) {
        entry.prepared.delete(prepared.id)
        return resultError(
          'interaction_required',
          'Browser Use requires its authenticated floating preview for this approval.',
          entry,
          tab.id
        )
      }
      const previewDataUrl = await this.highlightedPreview(tab, current.backendNodeId)
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
      entry.pendingAction = request
      entry.lifecycle = 'waiting-action-consent'
      this.publish(entry)
      const decision = await this.awaitActionDecision(entry, request)
      entry.pendingAction = undefined
      entry.lifecycle = 'ready'
      this.publish(entry)
      this.audit(entry, {
        category: 'action-consent',
        action: action.action,
        origin: prepared.origin,
        risk,
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
        action: kunApprovalSource
          ? `kun-${kunApprovalSource}-${action.action}`
          : `auto-${action.action}`,
        origin: prepared.origin,
        risk,
        decision: 'allowed',
        outcome: 'success',
        targetLabel: current.role.slice(0, 128)
      }, tab.id)
    }
    const validation = await this.validatePreparedAction(entry, tab, prepared)
    if (!validation.ok) {
      entry.prepared.delete(prepared.id)
      return resultError(validation.code, validation.message, entry, tab.id)
    }
    prepared.used = true
    entry.prepared.delete(prepared.id)
    try {
      await this.withAgentInputDispatch(entry, () => this.executePrepared(tab, prepared))
      this.audit(entry, {
        category: 'execution',
        action: action.action,
        origin: prepared.origin,
        risk,
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
      return resultError('action_failed', errorMessage(error), entry, tab.id)
    }
  }

  protected async validatePreparedAction(
    entry: BrowserSessionEntry,
    tab: BrowserTab,
    prepared: PreparedAction
  ): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
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
    const current = await this.liveTarget(entry, tab, prepared.target)
    if (!current) {
      return { ok: false, code: 'target_changed', message: 'The target changed while consent was pending.' }
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
    if (hit.result?.value !== true) {
      return { ok: false, code: 'target_changed', message: 'The target is no longer the live hit target.' }
    }
    return { ok: true }
  }

  protected async executePrepared(tab: BrowserTab, prepared: PreparedAction): Promise<void> {
    const target = prepared.target
    const x = Math.round(target.rect.x + target.rect.width / 2)
    const y = Math.round(target.rect.y + target.rect.height / 2)
    if (prepared.action.action === 'click') {
      await dispatchClick(tab, x, y)
      return
    }
    if (prepared.action.action === 'type') {
      await dispatchClick(tab, x, y)
      await tab.view.webContents.debugger.sendCommand('Input.insertText', {
        text: prepared.action.text
      })
      return
    }
    if (prepared.action.action === 'press') {
      await dispatchClick(tab, x, y)
      await dispatchKey(tab, prepared.action.key)
      return
    }
    const resolved = await tab.view.webContents.debugger.sendCommand('DOM.resolveNode', {
      backendNodeId: target.backendNodeId
    }) as { object?: { objectId?: string } }
    const objectId = resolved.object?.objectId
    if (!objectId) throw new Error('Select target is no longer resolvable.')
    await tab.view.webContents.debugger.sendCommand('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration:
        'function(value){if(!(this instanceof HTMLSelectElement))return false;this.value=value;this.dispatchEvent(new Event("input",{bubbles:true}));this.dispatchEvent(new Event("change",{bubbles:true}));return true;}',
      arguments: [{ value: prepared.action.value }],
      returnByValue: true,
      silent: true
    })
  }

  protected async scroll(
    entry: BrowserSessionEntry,
    direction: 'up' | 'down' | 'left' | 'right',
    amount: number
  ): Promise<BrowserUseResult> {
    const tab = this.requireActiveTab(entry)
    const horizontal = direction === 'left' || direction === 'right'
    await this.withAgentInputDispatch(entry, () =>
      tab.view.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: Math.max(1, Math.round((entry.mount?.bounds.width ?? 800) / 2)),
        y: Math.max(1, Math.round((entry.mount?.bounds.height ?? 600) / 2)),
        deltaX: horizontal ? (direction === 'left' ? -amount : amount) : 0,
        deltaY: horizontal ? 0 : (direction === 'up' ? -amount : amount)
      }))
    return resultOk('scrolled', `Scrolled ${direction} by ${amount}px.`, entry, tab.id)
  }

}
