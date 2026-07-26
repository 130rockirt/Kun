import type { CapabilityToolProvider } from './capability-registry.js'
import { LocalToolHost } from './local-tool-host.js'
import type { SkillRuntime } from '../../skills/skill-runtime.js'

/**
 * Exposes a `load_skill` tool so the model can autonomously pull the full
 * instructions of a skill it discovered in the always-on catalog, even when no
 * trigger fired on the user prompt. The returned content rides back as a normal
 * tool result, mirroring codex's autonomous-invocation path. Trigger-based
 * activation (see {@link SkillRuntime.resolveTurn}) still works in parallel.
 *
 * Returns no provider when skills are disabled or none are loaded, keeping the
 * advertised tool catalog (and its prefix fingerprint) identical to before.
 */
export function buildSkillToolProviders(
  skillRuntime: SkillRuntime | undefined
): CapabilityToolProvider[] {
  if (!skillRuntime || !skillRuntime.enabled()) return []
  return [{
    id: 'skill',
    kind: 'skill',
    enabled: true,
    available: true,
    tools: [
      LocalToolHost.defineTool({
        name: 'load_skill',
        description: [
          'Load the full instructions of an available skill by its id (see the',
          '"Available skills" catalog in your system context). Call this when a',
          'request matches a skill but the skill did not auto-activate, then',
          'follow the returned instructions. Returns the skill\'s SKILL.md body',
          'plus its metadata and any tool constraints.'
        ].join(' '),
        inputSchema: {
          type: 'object',
          properties: {
            skill_id: {
              type: 'string',
              description: 'The skill id from the catalog (e.g. "code-review"). The leading $/@ or "skill:" prefix is optional.'
            }
          },
          required: ['skill_id'],
          additionalProperties: false
        },
        policy: 'auto',
        execute: async (args, context) => {
          const skillId = typeof args.skill_id === 'string' ? args.skill_id : ''
          if (!skillId.trim()) return { output: { error: 'skill_id is required' }, isError: true }
          const turn = typeof context.threadId === 'string' && context.threadId.trim() &&
            typeof context.turnId === 'string' && context.turnId.trim()
            ? { threadId: context.threadId, turnId: context.turnId }
            : undefined
          const result = await skillRuntime.loadSkillById(
            skillId,
            context.workspace,
            context.blockedSkillIds,
            turn,
            context.allowedSkillIds
          )
          if ('error' in result) return { output: result, isError: true }
          return { output: result }
        }
      })
    ]
  }]
}
