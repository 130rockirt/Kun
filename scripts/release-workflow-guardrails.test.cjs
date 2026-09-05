'use strict'

const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { isAbsolute, join } = require('node:path')
const test = require('node:test')
const { parse } = require('yaml')
const {
  installerHelperPaths,
  installerSmokePath
} = require('./check-windows-installer-syntax.cjs')

const workflowDirectory = join(__dirname, '..', '.github', 'workflows')

function readWorkflow(file) {
  return parse(readFileSync(join(workflowDirectory, file), 'utf8'))
}

function stepByName(job, name) {
  return job.steps.find((step) => step.name === name)
}

function normalizedExpression(value) {
  return value.replace(/\s+/gu, ' ').trim()
}

test('Windows release jobs outlive their installer smoke timeout', () => {
  for (const file of ['pr-checks.yml', 'release.yml', 'daily-dev-prerelease.yml']) {
    const workflow = readWorkflow(file)
    const jobName = file === 'pr-checks.yml' ? 'package-windows' : 'build-windows'
    const job = workflow.jobs[jobName]
    const smoke = stepByName(job, 'Smoke Windows installer')

    assert.equal(job['timeout-minutes'], 240, `${file} ${jobName}`)
    assert.equal(smoke['timeout-minutes'], 180, `${file} installer smoke`)
    assert.ok(job['timeout-minutes'] > smoke['timeout-minutes'], `${file} timeout headroom`)
  }
})

test('stable release reruns quality gates on the merge commit before preparation', () => {
  const workflow = readWorkflow('release.yml')
  const quality = workflow.jobs.quality
  const prepare = workflow.jobs.prepare

  assert.equal(quality.name, 'Release quality gates')
  assert.equal(quality['timeout-minutes'], 45)
  assert.equal(normalizedExpression(quality.if), normalizedExpression(prepare.if))
  assert.deepEqual(prepare.needs, ['quality'])

  const checkout = stepByName(quality, 'Check out merge commit')
  assert.equal(checkout.uses, 'actions/checkout@v4')
  assert.equal(checkout.with.ref, '${{ github.event.pull_request.merge_commit_sha }}')
  assert.equal(checkout.with['fetch-depth'], 0)

  const commands = quality.steps.filter((step) => step.run).map((step) => step.run)
  assert.deepEqual(commands, [
    'npm ci',
    'npm run typecheck',
    'npm run lint',
    'npm test',
    'npm run audit:production'
  ])
})

test('PR quality catches production advisories before the stable release merge', () => {
  const workflow = readWorkflow('pr-checks.yml')
  const audit = stepByName(workflow.jobs.quality, 'Production dependency audit')

  assert.equal(audit.run, 'npm run audit:production')
})

test('stable Linux ARM64 packaging retains the proven PR timeout budget', () => {
  const workflow = readWorkflow('release.yml')

  assert.equal(workflow.jobs['build-linux-arm64']['timeout-minutes'], 180)
})

test('stable release compares the candidate TUI build with the previous release', () => {
  const workflow = readWorkflow('release.yml')
  const publish = workflow.jobs.publish
  const download = stepByName(publish, 'Download previous TUI release contract')
  const assemble = stepByName(publish, 'Assemble standalone TUI release contract')

  assert.equal(download.if, "needs.prepare.outputs.previous_tag != ''")
  assert.match(download.run, /gh release download "\$\{PREVIOUS_TAG\}" --pattern release-tui\.json/u)
  assert.match(download.run, /PREVIOUS_TUI_RELEASE=/u)
  assert.equal(assemble.run.includes('assemble:tui-release'), true)
})

test('Windows installer syntax checks include the smoke script by absolute path', () => {
  assert.ok(installerHelperPaths.includes(installerSmokePath))
  assert.ok(installerHelperPaths.every(isAbsolute))
})

test('TUI packaging jobs smoke the real artifact before uploading it', () => {
  const expectations = [
    ['release.yml', 'build-tui', 'Upload standalone TUI artifact'],
    ['daily-dev-prerelease.yml', 'build-tui', 'Upload standalone TUI prerelease artifact']
  ]
  for (const [file, jobName, uploadStepName] of expectations) {
    const job = readWorkflow(file).jobs[jobName]
    const smoke = job.steps.find(
      (step) => typeof step.run === 'string' && step.run.includes('smoke:standalone-tui')
    )
    assert.ok(smoke, `${file} ${jobName} runs the standalone TUI smoke`)
    const uploadIndex = job.steps.findIndex((step) => step.name === uploadStepName)
    const smokeIndex = job.steps.indexOf(smoke)
    assert.ok(
      smokeIndex >= 0 && uploadIndex > smokeIndex,
      `${file} ${jobName} smokes the artifact before uploading`
    )
  }
})

test('PR jobs smoke and probe the assemble layout of real TUI artifacts', () => {
  const workflow = readWorkflow('pr-checks.yml')
  const smokeSteps = [
    ['package-linux-arm64', 'Smoke standalone TUI and verify assemble layout (Linux ARM64)'],
    ['package-windows', 'Smoke standalone TUI and verify assemble layout (Windows)']
  ]
  for (const [jobName, stepName] of smokeSteps) {
    const step = stepByName(workflow.jobs[jobName], stepName)
    assert.match(step.run, /smoke:standalone-tui/u, `${jobName} smoke invocation`)
    assert.match(
      step.run,
      /readEmbeddedRelease/u,
      `${jobName} probes the archive with the assemble layout reader`
    )
    const packageStep = workflow.jobs[jobName].steps.find(
      (candidate) => typeof candidate.run === 'string' && candidate.run.includes('package:tui')
    )
    assert.ok(
      workflow.jobs[jobName].steps.indexOf(step) > workflow.jobs[jobName].steps.indexOf(packageStep),
      `${jobName} smoke runs after TUI packaging`
    )
  }
})
