import { describe, expect, it } from 'vitest'
import en from '../../locales/en/connectors.json'
import zh from '../../locales/zh/connectors.json'
import ru from '../../locales/ru/connectors.json'
import hi from '../../locales/hi/connectors.json'
import th from '../../locales/th/connectors.json'
import ja from '../../locales/ja/connectors.json'
import ko from '../../locales/ko/connectors.json'

function leafKeys(value: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return child && typeof child === 'object' && !Array.isArray(child)
      ? leafKeys(child as Record<string, unknown>, path)
      : [path]
  })
}

describe('ConnectorCenter translations', () => {
  it('ships a complete connectors namespace for every Kun locale', () => {
    const englishKeys = leafKeys(en).sort()
    expect(englishKeys.length).toBeGreaterThan(150)
    for (const resource of [zh, ru, hi, th, ja, ko]) {
      expect(leafKeys(resource).sort()).toEqual(englishKeys)
    }
  })

  it('uses native Chinese product and setup copy instead of server descriptions', () => {
    expect(zh.products.feishu.name).toBe('飞书')
    expect(zh.products['qq-mail'].name).toBe('QQ 邮箱')
    expect(zh.setup.scanTitle).toBe('扫码连接')
    expect(zh.setup.feishuReturnHint).toContain('无需点击“打开应用”')
    expect(zh.setup.retry).toBe('重新扫码')
    expect(zh.setup.mailIntro).toContain('绝不会要求邮箱登录密码')
    expect(zh.errors.device_registration_not_found).toContain('扫码会话已失效')
    expect(zh.errors.feishu_redirect_permission_missing).toContain('缺少登记回调地址所需的权限')
    expect(zh.errors.feishu_redirect_config_failed).toContain('本地回调地址')
  })
})
