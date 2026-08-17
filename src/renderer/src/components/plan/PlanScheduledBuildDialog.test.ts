import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { normalizeAppSettings, type AppSettingsV1 } from '@shared/app-settings'
import { useChatStore } from '../../store/chat-store'
import { PlanScheduledBuildDialog } from './PlanScheduledBuildDialog'

const FIXED_NOW = new Date('2030-06-15T08:00:00Z').getTime()

function buildSettings(): AppSettingsV1 {
  return normalizeAppSettings({} as never)
}

async function renderDialog(
  overrides: Partial<Parameters<typeof PlanScheduledBuildDialog>[0]> = {}
): Promise<{ renderer: ReactTestRenderer; onSubmit: ReturnType<typeof vi.fn> }> {
  const settings = buildSettings()
  const onSubmit = vi.fn(async () => undefined)
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(
      createElement(PlanScheduledBuildDialog, {
        settings,
        orchestration: 'direct',
        submitting: false,
        error: '',
        onClose: vi.fn(),
        onSubmit,
        ...overrides
      })
    )
  })
  return { renderer, onSubmit }
}

function collectText(node: ReactTestInstance, into: string[]): void {
  for (const child of node.children) {
    if (typeof child === 'string') {
      into.push(child)
    } else if (Array.isArray(child)) {
      for (const item of child) {
        if (typeof item === 'string') into.push(item)
      }
    } else if (child && typeof child === 'object' && 'children' in (child as object)) {
      collectText(child as ReactTestInstance, into)
    }
  }
}

function dialogText(renderer: ReactTestRenderer): string {
  const lines: string[] = []
  collectText(renderer.root, lines)
  return lines.join('|')
}

function findInput(renderer: ReactTestRenderer, type: string): ReactTestInstance {
  const input = renderer.root.findAllByType('input').find((item) => item.props.type === type)
  if (!input) throw new Error(`missing ${type} input`)
  return input
}

function setDateTime(renderer: ReactTestRenderer, date: string, time: string): void {
  act(() => {
    findInput(renderer, 'date').props.onChange({ target: { value: date } })
    findInput(renderer, 'time').props.onChange({ target: { value: time } })
  })
}

function selectTimeZone(renderer: ReactTestRenderer, zone: string): void {
  const timeZoneSelect = renderer.root.findAllByType('select').find((select) =>
    select.children.some(
      (child) => typeof child !== 'string' && dialogTextChildren(child as ReactTestInstance) === zone
    )
  )
  if (!timeZoneSelect) throw new Error(`missing time zone select for ${zone}`)
  act(() => {
    timeZoneSelect.props.onChange({ target: { value: zone } })
  })
}

function clickConfirm(renderer: ReactTestRenderer): void {
  const confirm = renderer.root
    .findAllByType('button')
    .find((button) => String(button.props.className).includes('bg-accent'))
  if (!confirm) throw new Error('missing confirm button')
  act(() => {
    confirm.props.onClick()
  })
}

describe('PlanScheduledBuildDialog i18n', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(FIXED_NOW)
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(async () => {
    vi.useRealTimers()
    await i18n.changeLanguage('en')
    useChatStore.setState({
      composerModel: '',
      composerProviderId: '',
      composerReasoningEffort: 'max'
    })
  })

  it('renders English copy by default', async () => {
    await i18n.changeLanguage('en')
    const { renderer } = await renderDialog()
    const text = dialogText(renderer)
    expect(text).toContain('Schedule plan build')
    expect(text).toContain('Date')
    expect(text).toContain('Time zone')
    expect(text).toContain('Provider')
    expect(text).toContain('Model')
    expect(text).toContain('Reasoning effort')
    expect(text).toContain('Confirm schedule')
    expect(text).toContain('Cancel')
    expect(text).toContain('Kun must remain running.')
    await act(async () => {
      renderer.unmount()
    })
  })

  it('renders localized copy, reasoning labels, and relative time in Chinese', async () => {
    await i18n.changeLanguage('zh')
    const { renderer } = await renderDialog()
    selectTimeZone(renderer, 'Africa/Abidjan')
    setDateTime(renderer, '2030-06-16', '10:00')
    const text = dialogText(renderer)
    expect(text).toContain('设置定时构建')
    expect(text).toContain('日期')
    expect(text).toContain('时区')
    expect(text).toContain('供应商')
    expect(text).toContain('模型')
    expect(text).toContain('推理强度')
    expect(text).toContain('确认定时')
    expect(text).toContain('取消')
    expect(text).toContain('需要保持 Kun 运行。')
    expect(text).toContain('26小时后')
    const reasoningText = renderer.root
      .findAllByType('select')
      .map((select) => dialogTextChildren(select))
      .join('|')
    expect(reasoningText).toContain('超高')
    expect(reasoningText).not.toContain('|max|')
    await act(async () => {
      renderer.unmount()
    })
  })

  it('maps validation error codes to localized messages', async () => {
    await i18n.changeLanguage('zh')
    const { renderer } = await renderDialog()
    setDateTime(renderer, '2030-06-15', '07:00')
    expect(dialogText(renderer)).toContain('执行时间必须晚于当前时间。')
    setDateTime(renderer, 'bogus', '07:00')
    expect(dialogText(renderer)).toContain('请输入有效的日期和时间。')
    await act(async () => {
      renderer.unmount()
    })
  })

  it('submits untranslated technical values regardless of language', async () => {
    await i18n.changeLanguage('zh')
    const { renderer, onSubmit } = await renderDialog()
    selectTimeZone(renderer, 'Africa/Abidjan')
    setDateTime(renderer, '2030-06-16', '10:00')
    clickConfirm(renderer)
    expect(onSubmit).toHaveBeenCalledTimes(1)
    const draft = onSubmit.mock.calls[0][0] as {
      providerId: string
      model: string
      reasoningEffort: string
      schedule: { kind: string; atTime: string; timeZone: string }
    }
    expect(draft.providerId).toBe('deepseek')
    expect(draft.model).toMatch(/^deepseek-v4-(flash|pro)$/)
    expect(['off', 'low', 'medium', 'high', 'max', 'auto']).toContain(draft.reasoningEffort)
    expect(draft.schedule.kind).toBe('at')
    expect(draft.schedule.atTime).toBe('2030-06-16T10:00:00.000Z')
    expect(draft.schedule.timeZone).toBe('Africa/Abidjan')
    await act(async () => {
      renderer.unmount()
    })
  })
})

function dialogTextChildren(select: ReactTestInstance): string {
  const parts: string[] = []
  collectText(select, parts)
  return parts.join('|')
}
