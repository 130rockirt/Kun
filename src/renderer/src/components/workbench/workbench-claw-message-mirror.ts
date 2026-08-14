export async function mirrorWorkbenchClawCommand(
  activeThreadId: string | null,
  userText: string,
  replyText: string
): Promise<void> {
  if (!activeThreadId || typeof window.kunGui?.mirrorClawChannelMessage !== 'function') return
  const userResult = await window.kunGui.mirrorClawChannelMessage(activeThreadId, userText, 'user')
  if (!userResult.ok) return
  await window.kunGui.mirrorClawChannelMessage(activeThreadId, replyText, 'assistant')
}
