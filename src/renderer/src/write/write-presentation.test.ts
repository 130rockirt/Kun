import { describe, expect, it } from 'vitest'
import { buildWritePresentationPrompt, isPresentationMarkdownPath } from './write-presentation'

describe('write presentation helpers', () => {
  it('accepts Markdown but not MDX or arbitrary text files', () => {
    expect(isPresentationMarkdownPath('/workspace/brief.md')).toBe(true)
    expect(isPresentationMarkdownPath('/workspace/brief.markdown')).toBe(true)
    expect(isPresentationMarkdownPath('/workspace/brief.mdx')).toBe(false)
    expect(isPresentationMarkdownPath('/workspace/brief.txt')).toBe(false)
  })

  it('builds an explicit, source-preserving native ppt_agent prompt', () => {
    const prompt = buildWritePresentationPrompt({
      workspaceRoot: '/workspace',
      sourcePath: '/workspace/季度复盘.md'
    })

    expect(prompt).toContain('`ppt_agent`（start）')
    expect(prompt).toContain('唯一内容来源 Markdown：/workspace/季度复盘.md')
    expect(prompt).toContain('最终文件：presentations/季度复盘.pptx')
    expect(prompt).toContain('先生成完整预览供评审')
    expect(prompt).toContain('跳过视觉方向选择')
    expect(prompt).toContain('若当前回合没有提供 `ppt_agent`')
    expect(prompt).toContain('不要改用旧版 PPT 技能、通用子代理')
    expect(prompt).toContain('不要修改、重命名或移动来源 Markdown')
    expect(prompt).not.toContain('$ppt-master')
    expect(prompt).not.toContain('ppt_master_')
  })
})
