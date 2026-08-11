import {
  CODE_AGENT_PERSONA_MAX_CHARS,
  CODE_AGENT_PRESET_ICON_MAX_CHARS,
  CODE_AGENT_PRESET_MAX_COUNT,
  CODE_AGENT_PRESET_NAME_MAX_CHARS,
  type CodeAgentPresetV1
} from './app-settings-types'

/**
 * Built-in Code personas. Unlike Write agents (which ship none), Code ships a
 * small opinionated set so the picker is useful on first run. Every built-in is
 * fully editable and deletable — a user who clears one keeps it cleared, and a
 * user who edits one keeps their text (localized defaults only fill blanks).
 */
export const CODE_AGENT_PRESET_BUILTIN_IDS = ['doubter', 'explorer', 'minimalist'] as const

/** Default lucide icon per built-in id. */
const CODE_AGENT_PRESET_BUILTIN_ICON: Record<string, string> = {
  doubter: 'SearchCheck',
  explorer: 'Compass',
  minimalist: 'Feather'
}

/** Fallback lucide icon for presets without a valid icon of their own. */
export const CODE_AGENT_PRESET_FALLBACK_ICON = 'Bot'

/** Default icon for a preset id: the built-in's own icon, or the generic fallback. */
export function defaultCodeAgentPresetIcon(id: string): string {
  return CODE_AGENT_PRESET_BUILTIN_ICON[id] ?? CODE_AGENT_PRESET_FALLBACK_ICON
}

export function isBuiltinCodeAgentPresetId(id: string): boolean {
  return (CODE_AGENT_PRESET_BUILTIN_IDS as readonly string[]).includes(id)
}

/**
 * Built-in rows persist with empty name/persona so they always render the
 * current localized text: switching app language must re-translate them rather
 * than freeze whatever locale was active at first launch.
 */
export function defaultCodeAgentPresets(): CodeAgentPresetV1[] {
  return CODE_AGENT_PRESET_BUILTIN_IDS.map((id) => ({
    id,
    name: '',
    icon: CODE_AGENT_PRESET_BUILTIN_ICON[id] ?? CODE_AGENT_PRESET_FALLBACK_ICON,
    persona: ''
  }))
}

export function normalizeCodeAgentPresets(
  input: Array<Partial<CodeAgentPresetV1>> | undefined
): CodeAgentPresetV1[] {
  // Absent (first run / pre-feature settings) seeds the built-ins; an explicit
  // empty array is a user who deleted every preset and must stay empty.
  if (!Array.isArray(input)) return defaultCodeAgentPresets()
  const seen = new Set<string>()
  const presets: CodeAgentPresetV1[] = []
  for (const raw of input) {
    const id = typeof raw?.id === 'string' ? raw.id.trim().slice(0, 64) : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    presets.push({
      id,
      name: typeof raw?.name === 'string' ? raw.name.slice(0, CODE_AGENT_PRESET_NAME_MAX_CHARS) : '',
      // Rows persisted by the short-lived emoji build carry `emoji` instead of
      // `icon`; those fall through to the built-in/fallback icon here.
      icon:
        typeof raw?.icon === 'string' && raw.icon.trim()
          ? raw.icon.trim().slice(0, CODE_AGENT_PRESET_ICON_MAX_CHARS)
          : (CODE_AGENT_PRESET_BUILTIN_ICON[id] ?? CODE_AGENT_PRESET_FALLBACK_ICON),
      persona:
        typeof raw?.persona === 'string' ? raw.persona.slice(0, CODE_AGENT_PERSONA_MAX_CHARS) : ''
    })
    if (presets.length >= CODE_AGENT_PRESET_MAX_COUNT) break
  }
  return presets
}
