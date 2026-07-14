#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseRepoRoot(argv) {
  if (argv.length === 0) return DEFAULT_REPO_ROOT;
  if (argv.length === 2 && argv[0] === '--repo-root' && argv[1]) {
    return path.resolve(argv[1]);
  }
  throw new Error('usage: check-electric-release-policy.mjs [--repo-root <path>]');
}

function readWorkflows(repoRoot) {
  const workflowRoot = path.join(repoRoot, '.github/workflows');
  const entries = fs
    .readdirSync(workflowRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  return new Map(
    entries.map((entry) => {
      const raw = fs.readFileSync(path.join(workflowRoot, entry.name), 'utf8');
      return [entry.name, { raw, value: parse(raw) }];
    }),
  );
}

function visit(value, visitor, trail = []) {
  visitor(value, trail);
  if (Array.isArray(value)) {
    value.forEach((item, index) => visit(item, visitor, [...trail, String(index)]));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      visit(child, visitor, [...trail, key]);
    }
  }
}

function findNamedStep(job, name) {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  const index = steps.findIndex((step) => step?.name === name);
  return index >= 0 ? { index, step: steps[index] } : undefined;
}

function checkRunRequirements(match, stepDescription, requirements) {
  if (!match || typeof match.step?.run !== 'string') {
    fail(`electric-release.yml must define ${stepDescription}`);
    return;
  }
  for (const [literal, description, pattern] of requirements) {
    if (pattern ? !pattern.test(match.step.run) : !match.step.run.includes(literal)) {
      fail(`electric-release.yml ${stepDescription} must include ${description}`);
    }
  }
}

const failures = [];
const fail = (message) => failures.push(message);

const APPROVED_OIDC_JOBS = new Set([
  'build-tree-sitter-prebuilds.yml:aggregate',
  'claude.yml:claude',
  'scorecard.yml:analysis',
]);

const REGISTRY_CREDENTIAL_PATTERN =
  /(?:NODE_AUTH_TOKEN|NPM_TOKEN|NPM_CONFIG_REGISTRY|DOCKER(?:HUB)?_(?:TOKEN|USERNAME|PASSWORD)|GHCR_TOKEN|REGISTRY_(?:TOKEN|USERNAME|PASSWORD)|PACKAGE_REGISTRY|PUBLISH_(?:TOKEN|COMMAND|SCRIPT))/i;

function checkNoRegistryPublication(workflows) {
  for (const [filename, workflow] of workflows) {
    if (workflow.value?.permissions?.['id-token'] === 'write') {
      fail(`${filename}:permissions grants unapproved id-token: write`);
    }
    visit(workflow.value, (value, trail) => {
      const location = `${filename}:${trail.join('.') || '<root>'}`;
      if (typeof value === 'string') {
        if (/\bnpm\s+publish\b/i.test(value)) fail(`${location} contains npm publish`);
        if (/\bdocker\s+login\b/i.test(value) || /docker\/login-action@/i.test(value)) {
          fail(`${location} contains docker login`);
        }
        if (/\bdocker\s+push\b/i.test(value)) fail(`${location} contains docker push`);
        if (REGISTRY_CREDENTIAL_PATTERN.test(value)) {
          fail(`${location} references a registry credential or registry command variable`);
        }
      }
      const key = trail.at(-1);
      if (typeof key === 'string' && REGISTRY_CREDENTIAL_PATTERN.test(key)) {
        fail(`${location} declares a registry credential or registry command variable`);
      }
      if (key === 'registry-url' || key === 'registry_url') {
        fail(`${location} contains registry configuration`);
      }
      if (key === 'packages' && value === 'write') fail(`${location} grants packages: write`);
      if (key === 'push-to-registry' && value !== false && value !== 'false') {
        fail(`${location} enables registry push`);
      }
    });

    for (const [jobName, job] of Object.entries(workflow.value?.jobs ?? {})) {
      if (
        job?.permissions?.['id-token'] === 'write' &&
        !APPROVED_OIDC_JOBS.has(`${filename}:${jobName}`)
      ) {
        fail(`${filename}:jobs.${jobName} grants unapproved id-token: write`);
      }
      for (const [index, step] of (job?.steps ?? []).entries()) {
        if (!step || typeof step !== 'object' || typeof step.uses !== 'string') continue;
        if (
          /(?:docker\/build-push-action|docker-build-push-retry)/i.test(step.uses) &&
          step.with?.push !== false &&
          step.with?.push !== 'false'
        ) {
          fail(`${filename}:jobs.${jobName}.steps.${index} push must be statically false`);
        }
      }
    }
  }
}

function checkReleaseWorkflow(workflows) {
  if (workflows.has('publish.yml') || workflows.has('publish.yaml')) {
    fail('publish.yml must not exist in the Electric fork');
  }

  const candidate = workflows.get('electric-release.yml');
  if (!candidate) {
    fail('electric-release.yml must exist');
    return;
  }

  const workflow = candidate.value;
  const triggers = workflow?.on;
  if (!triggers || typeof triggers !== 'object' || Array.isArray(triggers)) {
    fail('electric-release.yml must declare structured triggers');
  } else {
    const triggerNames = Object.keys(triggers);
    if (triggerNames.length !== 1 || triggerNames[0] !== 'workflow_dispatch') {
      fail('electric-release.yml must be manual-only through workflow_dispatch');
    }
    const inputs = triggers.workflow_dispatch?.inputs;
    if (
      inputs?.expected_version?.required !== true ||
      inputs?.expected_version?.type !== 'string'
    ) {
      fail('electric-release.yml must require string input expected_version');
    }
    if (inputs?.prerelease?.type !== 'boolean') {
      fail('electric-release.yml must declare boolean input prerelease');
    }
  }

  for (const jobName of ['inspect', 'ci', 'package', 'release']) {
    if (!workflow?.jobs?.[jobName]) fail(`electric-release.yml must define ${jobName} job`);
  }

  const releaseJob = workflow?.jobs?.release;
  for (const jobName of ['inspect', 'ci', 'package']) {
    const permissions = workflow?.jobs?.[jobName]?.permissions;
    const entries =
      permissions && typeof permissions === 'object' ? Object.entries(permissions) : [];
    for (const [scope, level] of entries) {
      if (level !== 'read' && level !== 'none') {
        fail(
          `electric-release.yml:jobs.${jobName}.permissions.${scope} must stay read-only, got ${level}`,
        );
      }
    }
  }
  const environment =
    typeof releaseJob?.environment === 'string'
      ? releaseJob.environment
      : releaseJob?.environment?.name;
  if (environment !== 'internal-release') {
    fail('electric-release.yml release job must require internal-release environment');
  }

  const releasePermissions = releaseJob?.permissions;
  const releasePermissionEntries =
    releasePermissions && typeof releasePermissions === 'object'
      ? Object.entries(releasePermissions)
      : [];
  if (
    releasePermissionEntries.length !== 1 ||
    releasePermissionEntries[0]?.[0] !== 'contents' ||
    releasePermissionEntries[0]?.[1] !== 'write'
  ) {
    fail('electric-release.yml release job may grant only contents: write');
  }

  visit(workflow, (value, trail) => {
    const key = trail.at(-1);
    if (key === 'id-token' && value === 'write') {
      fail(`electric-release.yml:${trail.join('.')} grants id-token: write`);
    }
  });

  const inspectStep = findNamedStep(
    workflow?.jobs?.inspect,
    'Verify release identity and manifest versions',
  );
  checkRunRequirements(inspectStep, 'manifest verification step', [
    ['refs/heads/main', 'main ref guard'],
    ['electric/v', 'electric/v tag namespace'],
    ['gitnexus-claude-plugin/.claude-plugin/plugin.json', 'Claude plugin manifest verification'],
    ['gitnexus-claude-plugin/.codex-plugin/plugin.json', 'Codex plugin manifest verification'],
    ['.claude-plugin/marketplace.json', 'Claude marketplace manifest verification'],
    ['.agents/plugins/marketplace.json', 'Codex marketplace manifest verification'],
    ['manifest version mismatch', 'manifest mismatch failure'],
  ]);

  const packageStep = findNamedStep(workflow?.jobs?.package, 'Pack and install isolated CLI');
  checkRunRequirements(packageStep, 'package proof step', [
    ['npm pack --dry-run', 'npm pack dry-run'],
    [
      'if [ "$VERSION_OUTPUT" != "$EXPECTED_VERSION" ]; then',
      'exact packaged-version equality check',
    ],
    ['SHA256SUMS', 'SHA256SUMS asset'],
  ]);

  const reverifyStep = findNamedStep(releaseJob, 'Reverify resumable release state');
  checkRunRequirements(reverifyStep, 'reverify resumable release state step', [
    ['TAG_EXISTS', 'fresh tag-state output'],
    ['RELEASE_EXISTS', 'fresh release-state output'],
  ]);

  const tagStep = findNamedStep(releaseJob, 'Create annotated Electric tag when absent');
  const upsertStep = findNamedStep(releaseJob, 'Create or resume draft release and upload assets');
  checkRunRequirements(upsertStep, 'draft release step', [
    ['gh release create', 'draft release creation'],
    ['--draft', 'draft release creation'],
    ['gh release upload', 'release asset upload'],
    ['--clobber', 'resumable asset upload'],
    ['gitnexus-', '.tgz asset', /gitnexus-[^\s]*\.tgz/],
    ['SHA256SUMS', 'SHA256SUMS asset'],
  ]);

  const publishStep = findNamedStep(releaseJob, 'Verify assets and publish the draft');
  checkRunRequirements(publishStep, 'publish the verified draft step', [
    ['gh api --method PATCH', 'GitHub Release PATCH'],
    ['-F draft=false', 'publish the verified draft'],
  ]);

  const releaseNeeds = Array.isArray(releaseJob?.needs) ? releaseJob.needs : [releaseJob?.needs];
  if (!releaseNeeds.includes('inspect') || !releaseNeeds.includes('package')) {
    fail('electric-release.yml manifest verification must run before release mutation');
  }
  const orderedReleaseSteps = [reverifyStep, tagStep, upsertStep, publishStep];
  if (
    orderedReleaseSteps.some((match) => !match) ||
    orderedReleaseSteps.some(
      (match, index) => index > 0 && match.index <= orderedReleaseSteps[index - 1].index,
    )
  ) {
    fail(
      'electric-release.yml must reverify state before ordered tag, draft, and publish mutation',
    );
  }
}

function main() {
  const repoRoot = parseRepoRoot(process.argv.slice(2));
  const workflows = readWorkflows(repoRoot);
  checkNoRegistryPublication(workflows);
  checkReleaseWorkflow(workflows);
  if (failures.length > 0) {
    for (const message of failures) {
      process.stderr.write(`electric release policy check failed: ${message}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write('electric release policy check passed\n');
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`electric release policy check failed: ${message}\n`);
  process.exitCode = 1;
}
