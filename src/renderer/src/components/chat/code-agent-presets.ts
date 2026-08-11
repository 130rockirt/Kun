import i18n from '../../i18n'
import {
  defaultCodeAgentPresetIcon,
  isBuiltinCodeAgentPresetId,
  type CodeAgentPresetV1
} from '@shared/app-settings'

export type ResolvedCodeAgentPreset = {
  id: string
  name: string
  /** Lucide icon name; render via `CodeAgentPresetIcon`, which falls back for unknown names. */
  icon: string
  persona: string
  builtin: boolean
}

/**
 * Fills localized defaults for built-in presets the user has not customized
 * (empty name/persona), mirroring `resolveWriteAgentPreset`. Reads the global
 * i18n instance so it works from any component regardless of bound namespace.
 */
export function resolveCodeAgentPreset(
  preset: Partial<CodeAgentPresetV1> & Pick<CodeAgentPresetV1, 'id'>
): ResolvedCodeAgentPreset {
  const builtin = isBuiltinCodeAgentPresetId(preset.id)
  const name =
    (preset.name ?? '').trim() ||
    (builtin ? i18n.t(`codeAgentPreset_${preset.id}_name`, { ns: 'common' }) : preset.id)
  const persona =
    (preset.persona ?? '').trim() ||
    (builtin ? i18n.t(`codeAgentPreset_${preset.id}_persona`, { ns: 'common' }) : '')
  return {
    id: preset.id,
    name,
    // `?? ''` guards rows persisted by older builds (e.g. the emoji-era shape,
    // which has no `icon` field) reaching us before renormalization.
    icon: (preset.icon ?? '').trim() || defaultCodeAgentPresetIcon(preset.id),
    persona,
    builtin
  }
}

/**
 * Persona text to send for a selected preset id. Returns '' when nothing is
 * selected or the id no longer exists (e.g. deleted in Settings while active),
 * so a stale selection degrades to "no persona" instead of failing the turn.
 */
export function resolveCodeAgentPersona(
  presets: readonly CodeAgentPresetV1[],
  activeId: string
): string {
  if (!activeId.trim()) return ''
  const match = presets.find((preset) => preset.id === activeId)
  return match ? resolveCodeAgentPreset(match).persona.trim() : ''
}
