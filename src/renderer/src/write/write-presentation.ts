function basename(value: string): string {
  const normalized = value.replaceAll('\\', '/')
  return normalized.split('/').filter(Boolean).at(-1) ?? 'presentation.md'
}

function deckNameFromPath(value: string): string {
  const name = basename(value).replace(/\.(?:md|markdown)$/i, '')
  const safe = name.replace(/[^\p{L}\p{N}_.-]+/gu, '-').replace(/^-+|-+$/g, '')
  return safe || 'presentation'
}

/** The native PPT workflow intentionally accepts only plain Markdown, not MDX. */
export function isPresentationMarkdownPath(path: string | null | undefined): boolean {
  return Boolean(path && /\.(?:md|markdown)$/i.test(path.trim()))
}

/**
 * Routes a new Write request to the dedicated native PPTX child while keeping
 * the source-file contract visible in the exact user turn.
 */
export function buildWritePresentationPrompt(input: {
  workspaceRoot: string
  sourcePath: string
}): string {
  const deckName = deckNameFromPath(input.sourcePath)
  return [
    '请调用专用的 `ppt_agent`（start）把当前 Markdown 制作为原生可编辑的 PPTX。',
    '',
    `唯一内容来源 Markdown：${input.sourcePath}`,
    `工作区：${input.workspaceRoot}`,
    `最终文件：presentations/${deckName}.pptx`,
    '',
    '这是 Work 一键生成：请跳过视觉方向选择，根据内容和演示设计规范自动确定结构与视觉方案，先生成完整预览供评审，获得批准后再导出 PPTX。',
    '若当前回合没有提供 `ppt_agent`，请明确告知该功能未启用；不要改用旧版 PPT 技能、通用子代理或其他生成路径。',
    '不要修改、重命名或移动来源 Markdown。'
  ].join('\n')
}
