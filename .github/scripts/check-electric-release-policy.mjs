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

  const requiredText = [
    ['electric/v', 'electric/v tag namespace'],
    ['gitnexus-', '.tgz asset', /gitnexus-[^\s]*\.tgz/],
    ['SHA256SUMS', 'SHA256SUMS asset'],
    ['npm pack --dry-run', 'npm pack dry-run'],
    ['internal-release', 'protected environment'],
    ['refs/heads/main', 'main ref guard'],
    ['TAG_EXISTS', 'exact-head tag resume guard'],
    ['RELEASE_EXISTS', 'draft release resume guard'],
    ['gh release create', 'draft release creation'],
    ['--draft', 'draft release creation'],
    ['gh release upload', 'release asset upload'],
    ['--clobber', 'resumable asset upload'],
    ['-F draft=false', 'publish the verified draft'],
  ];
  for (const [literal, description, pattern] of requiredText) {
    if (pattern ? !pattern.test(candidate.raw) : !candidate.raw.includes(literal)) {
      fail(`electric-release.yml must include ${description}`);
    }
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
