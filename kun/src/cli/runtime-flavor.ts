import { createHash } from 'node:crypto'
import { RuntimeFlavorSchema, type RuntimeFlavor } from '../contracts/runtime-flavor.js'

export const KUN_ALLOW_DEVELOPMENT_MANAGER_BOOTSTRAP_ENV =
  'KUN_ALLOW_DEVELOPMENT_MANAGER_BOOTSTRAP' as const

export function resolveCliRuntimeFlavor(input: {
  env?: Record<string, string | undefined>
  executablePath?: string
} = {}): RuntimeFlavor {
  const configured = input.env?.KUN_RUNTIME_FLAVOR?.trim() || input.env?.KUN_APP_FLAVOR?.trim()
  if (configured) return RuntimeFlavorSchema.parse(configured)
  const executable = (input.executablePath ?? '').split(/[\\/]/u).pop()?.toLowerCase() ?? ''
  return executable === 'kun-dv' || executable === 'kun-dv.exe'
    ? 'development'
    : 'production'
}

export function runtimeDisplayName(flavor: RuntimeFlavor): string {
  return flavor === 'development' ? 'kun-dv runtime' : 'Kun runtime'
}

/** Explicit source-workflow escape hatch used before a stable Manager release is installed. */
export function allowsDevelopmentManagerBootstrap(input: {
  flavor: RuntimeFlavor
  env?: Record<string, string | undefined>
  isPackaged?: boolean
}): boolean {
  return input.isPackaged !== true &&
    input.flavor === 'development' &&
    input.env?.[KUN_ALLOW_DEVELOPMENT_MANAGER_BOOTSTRAP_ENV]?.trim() === '1'
}

/** Preserve production compatibility while giving DV an unambiguous build namespace. */
export function runtimeBuildIdForFlavor(
  buildId: string | undefined,
  flavor: RuntimeFlavor
): string | undefined {
  if (!buildId || flavor === 'production') return buildId
  return createHash('sha256').update(`kun-dv-runtime\0${buildId}`, 'utf8').digest('hex')
}
