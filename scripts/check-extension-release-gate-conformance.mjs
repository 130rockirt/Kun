import {
  access,
  apiContract,
  assertExecutableApiConformance,
  dirname,
  expectedApiMajors,
  join,
  root,
  runRequiredCommand,
  runRequiredCompositeCommand
} from './check-extension-release-gate-context.mjs'

const {
  currentApiVersion,
  currentApiMajor,
  canonicalSupportedApiVersions
} = apiContract

if (currentApiVersion === undefined || currentApiMajor === undefined || canonicalSupportedApiVersions.length === 0) {
  throw new Error('Extension public release gate could not resolve the canonical API version')
}

const expectedConformanceMajors = expectedApiMajors(currentApiVersion)
const executedConformanceMajors = []

// API v1 is both the current major and the documented no-previous-major
// exception. Once v2 ships, this gate fails closed until a retained v1 SDK and
// executable Host-adapter conformance runner are checked in at these paths.
// A successful manifest negotiation never counts as adaptation evidence.
if (expectedConformanceMajors.length > 1) {
  const previousMajor = expectedConformanceMajors[1]
  const previousSdk = `packages/extension-api-compat/v${previousMajor}/package.json`
  const previousConformance = `scripts/fixtures/extension-api-conformance/v${previousMajor}.mjs`
  try {
    await Promise.all([access(join(root, previousSdk)), access(join(root, previousConformance))])
  } catch {
    throw new Error(
      `Extension API v${currentApiMajor} requires executable v${previousMajor} Host adaptation. ` +
        `Add the retained SDK at ${previousSdk} and conformance runner at ${previousConformance}.`
    )
  }
  runRequiredCommand({
    label: `Extension API v${previousMajor} previous-major Host adapter conformance`,
    command: process.execPath,
    args: [join(root, previousConformance), '--sdk-package', join(root, dirname(previousSdk))],
    cwd: root
  })
  executedConformanceMajors.push(previousMajor)
}

runRequiredCompositeCommand({
  label: `Extension API v${currentApiMajor} external packaged-artifact conformance`,
  command: process.execPath,
  args: [join(root, 'scripts/check-extension-external-project.mjs'), '--expected-api-major', String(currentApiMajor)],
  cwd: root
})
executedConformanceMajors.push(currentApiMajor)

assertExecutableApiConformance({
  currentVersion: currentApiVersion,
  supportedVersions: canonicalSupportedApiVersions,
  executedMajors: executedConformanceMajors
})

const vitestEntry = join(root, 'node_modules/vitest/vitest.mjs')
runRequiredCommand({
  label: 'Extension media protocol isolation release suite',
  command: process.execPath,
  args: [
    vitestEntry,
    'run',
    'src/main/extensions/extension-media-protocol.test.ts',
    'src/main/extensions/extension-view-methods.test.ts',
    'src/main/ipc/register-extension-ipc-handlers.test.ts'
  ],
  cwd: root
})
runRequiredCommand({
  label: 'Extension native media supervision and cancellation release suite',
  command: process.execPath,
  args: [
    vitestEntry,
    'run',
    '--pool=threads',
    '--maxWorkers=1',
    'src/services/extension-media-handle-service.test.ts',
    'src/services/extension-media-process-service.test.ts',
    'src/services/extension-media-ffmpeg-service.test.ts',
    'src/services/extension-media-job-service.test.ts',
    'src/services/extension-media-native-smoke.test.ts'
  ],
  cwd: join(root, 'kun')
})
runRequiredCommand({
  label: 'legacy desktop Plugin, Skill, and provider behavior regression suite',
  command: process.execPath,
  args: [
    vitestEntry,
    'run',
    'src/main/services/ui-plugin-service.test.ts',
    'src/renderer/src/components/PluginMarketplaceView.test.ts',
    'src/main/services/skill-service.test.ts',
    'src/main/legacy-provider-settings-migration.test.ts',
    'src/main/provider-connection.test.ts'
  ],
  cwd: root
})
runRequiredCommand({
  label: 'legacy single-runtime, MCP, Skill, provider, and Extension Host regression suite',
  command: process.execPath,
  args: [
    vitestEntry,
    'run',
    'tests/runtime-factory.test.ts',
    'tests/extension-compatibility.test.ts',
    'tests/extension-host.test.ts',
    'tests/skill-runtime.test.ts',
    'src/adapters/tool/mcp-tool-provider.test.ts',
    'src/adapters/model/multi-provider-model-client.test.ts',
    'src/services/legacy-provider-credential-migration.test.ts'
  ],
  cwd: join(root, 'kun')
})

process.stdout.write(
  'Extension public release gate OK: platform exposed, API v1.2/v1.1/v1.0 compatibility, media protocol isolation, native process cleanup, external tarball acceptance, legacy behaviors, packaged resources, and bundled defaults passed.\n'
)
