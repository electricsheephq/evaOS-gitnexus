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

function checkDraftSafeReleaseLookup(match, stepDescription) {
  checkRunRequirements(match, stepDescription, [
    [
      'gh api --paginate --slurp "repos/$REPO/releases?per_page=100"',
      'draft-safe paginated release list lookup',
    ],
    ['.tag_name == $tag', 'exact release tag filter'],
    ['RELEASE_COUNT', 'bounded release match count'],
    [
      '',
      'exit-bearing duplicate release rejection',
      /case\s+"\$RELEASE_COUNT"\s+in[\s\S]*?\*\)[\s\S]*?Multiple releases exist for \$TAG[\s\S]*?exit 1[\s\S]*?;;[\s\S]*?esac/,
    ],
  ]);
  if (typeof match?.step?.run === 'string' && match.step.run.includes('releases/tags/')) {
    fail(
      `electric-release.yml ${stepDescription} must not use the draft-invisible releases/tags endpoint`,
    );
  }
}

function checkExactPermissions(job, expected, description) {
  const entries = Object.entries(job?.permissions ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const wanted = Object.entries(expected).sort(([left], [right]) => left.localeCompare(right));
  if (JSON.stringify(entries) !== JSON.stringify(wanted)) {
    fail(
      `electric-release-resume.yml ${description} permissions must be ${JSON.stringify(expected)}`,
    );
  }
}

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

  for (const jobName of ['inspect', 'ci', 'package', 'package_proof', 'release']) {
    if (!workflow?.jobs?.[jobName]) fail(`electric-release.yml must define ${jobName} job`);
  }

  const releaseJob = workflow?.jobs?.release;
  for (const jobName of ['inspect', 'ci', 'package', 'package_proof']) {
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
    ['MAX_MANIFEST_BYTES', 'bounded manifest parsing'],
  ]);
  checkDraftSafeReleaseLookup(inspectStep, 'manifest verification step');

  const packageStep = findNamedStep(workflow?.jobs?.package, 'Pack release tarball');
  checkRunRequirements(packageStep, 'package build step', [
    ['npm pack --dry-run', 'npm pack dry-run'],
    ['FILENAME="gitnexus-$EXPECTED_VERSION.tgz"', 'deterministic package asset filename'],
    [
      'if [ ! -f "$ASSET_PATH" ] || [ ! -s "$ASSET_PATH" ]; then',
      'non-empty regular package asset validation',
    ],
    ['SHA256SUMS', 'SHA256SUMS asset'],
  ]);
  if (
    typeof packageStep?.step?.run === 'string' &&
    /\bJSON\.parse\s*\(/.test(packageStep.step.run)
  ) {
    fail('electric-release.yml package build step must not parse npm pack stdout as JSON');
  }
  const packageNeeds = Array.isArray(workflow?.jobs?.package?.needs)
    ? workflow.jobs.package.needs
    : [workflow?.jobs?.package?.needs];
  if (!packageNeeds.includes('ci')) {
    fail('electric-release.yml package job must depend on exact-head ci');
  }

  const proofJob = workflow?.jobs?.package_proof;
  if (proofJob?.name !== 'Prove release tarball (${{ matrix.os }})') {
    fail('electric-release.yml package proof job name must match recovery proof identities');
  }
  const proofOperatingSystems = proofJob?.strategy?.matrix?.os;
  const expectedOperatingSystems = ['macos-latest', 'ubuntu-latest', 'windows-latest'];
  if (
    !Array.isArray(proofOperatingSystems) ||
    JSON.stringify([...proofOperatingSystems].sort()) !== JSON.stringify(expectedOperatingSystems)
  ) {
    fail('electric-release.yml package proof matrix must cover ubuntu, macOS, and Windows');
  }
  const proofNeeds = Array.isArray(proofJob?.needs) ? proofJob.needs : [proofJob?.needs];
  if (!proofNeeds.includes('inspect') || !proofNeeds.includes('package')) {
    fail(
      'electric-release.yml package proof must depend on inspected release identity and tarball',
    );
  }
  const proofStep = findNamedStep(proofJob, 'Install and verify release tarball');
  checkRunRequirements(proofStep, 'cross-platform package proof step', [
    ['npm install --global --prefix', 'clean-prefix package installation'],
    ['verify-electric-package.mjs', 'shared package verifier'],
    ['--asset', 'tarball checksum verification'],
    ['--checksums', 'SHA256SUMS verification'],
    ['--prefix', 'installed-prefix verification'],
    ['--expected-version', 'exact packaged-version equality check'],
  ]);

  const reverifyStep = findNamedStep(releaseJob, 'Reverify resumable release state');
  checkRunRequirements(reverifyStep, 'reverify resumable release state step', [
    ['git/ref/heads/main', 'fresh current-main guard'],
    ['if [ "$CURRENT_MAIN_SHA" != "$HEAD_SHA" ]; then', 'fresh current-main guard'],
    ['ENCODED_TAG', 'URL-encoded tag-state lookup'],
    ['git/ref/tags/$ENCODED_TAG', 'URL-encoded tag-state lookup'],
    ['TAG_EXISTS', 'fresh tag-state output'],
    ['RELEASE_EXISTS', 'fresh release-state output'],
  ]);
  checkDraftSafeReleaseLookup(reverifyStep, 'reverify resumable release state step');

  const tagStep = findNamedStep(releaseJob, 'Create annotated Electric tag when absent');
  if (tagStep?.step?.if !== "steps.resume_state.outputs.tag_exists != 'true'") {
    fail('electric-release.yml tag creation guard must use the reverified tag state');
  }
  checkRunRequirements(tagStep, 'tag creation step', [
    ['--method POST', 'POST-only tag creation'],
    ['git/tags', 'annotated tag object creation'],
    ['git/refs', 'tag ref creation'],
    ['$HEAD_SHA', 'exact-head tag target'],
  ]);
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
    ['gh release download', 'fresh release asset download'],
    ['sha256sum --check', 'fresh release checksum verification'],
    ['gh api --method PATCH', 'GitHub Release PATCH'],
    ['-F draft=false', 'publish the verified draft'],
  ]);
  checkDraftSafeReleaseLookup(publishStep, 'publish the verified draft step');

  const releaseNeeds = Array.isArray(releaseJob?.needs) ? releaseJob.needs : [releaseJob?.needs];
  if (
    !releaseNeeds.includes('inspect') ||
    !releaseNeeds.includes('package') ||
    !releaseNeeds.includes('package_proof')
  ) {
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

function checkRecoveryWorkflow(workflows) {
  const candidate = workflows.get('electric-release-resume.yml');
  if (!candidate) {
    fail('electric-release-resume.yml must exist');
    return;
  }

  const workflow = candidate.value;
  const triggers = workflow?.on;
  if (
    !triggers ||
    typeof triggers !== 'object' ||
    Array.isArray(triggers) ||
    Object.keys(triggers).length !== 1 ||
    !triggers.workflow_dispatch
  ) {
    fail('electric-release-resume.yml must be manual-only through workflow_dispatch');
  }
  const inputs = triggers?.workflow_dispatch?.inputs ?? {};
  for (const inputName of [
    'expected_version',
    'release_id',
    'source_sha',
    'source_run_id',
    'tarball_sha256',
  ]) {
    if (inputs[inputName]?.required !== true || inputs[inputName]?.type !== 'string') {
      fail(`electric-release-resume.yml must require string input ${inputName}`);
    }
  }
  if (inputs.prerelease?.type !== 'boolean') {
    fail('electric-release-resume.yml must declare boolean input prerelease');
  }

  const jobNames = Object.keys(workflow?.jobs ?? {}).sort();
  if (JSON.stringify(jobNames) !== JSON.stringify(['inspect', 'recover'])) {
    fail('electric-release-resume.yml may define only inspect and recover jobs');
  }
  const inspectJob = workflow?.jobs?.inspect;
  const recoverJob = workflow?.jobs?.recover;
  checkExactPermissions(inspectJob, { actions: 'read', contents: 'read' }, 'inspect job');
  checkExactPermissions(recoverJob, { actions: 'read', contents: 'write' }, 'recovery job');

  const environment =
    typeof recoverJob?.environment === 'string'
      ? recoverJob.environment
      : recoverJob?.environment?.name;
  if (environment !== 'internal-release') {
    fail('electric-release-resume.yml recovery job must require internal-release environment');
  }
  const recoveryNeeds = Array.isArray(recoverJob?.needs) ? recoverJob.needs : [recoverJob?.needs];
  if (!recoveryNeeds.includes('inspect')) {
    fail('electric-release-resume.yml recovery job must depend on read-only inspection');
  }

  const inputStep = findNamedStep(inspectJob, 'Validate recovery inputs');
  checkRunRequirements(inputStep, 'recovery input validation step', [
    ['refs/heads/main', 'main ref guard'],
    ['^[0-9a-f]{40}$', 'full source SHA validation'],
    ['^[0-9a-f]{64}$', 'full tarball SHA-256 validation'],
  ]);

  const inspectStep = findNamedStep(inspectJob, 'Verify proven Electric draft recovery');
  checkRunRequirements(inspectStep, 'read-only recovery inspection step', [
    ['git/ref/heads/main', 'current-main policy guard'],
    ['if [ "$CURRENT_MAIN_SHA" != "$POLICY_SHA" ]; then', 'current-main policy guard'],
    ['git merge-base --is-ancestor', 'release source ancestry guard'],
    ['gitnexus-claude-plugin/.claude-plugin/plugin.json', 'source Claude manifest proof'],
    ['gitnexus-claude-plugin/.codex-plugin/plugin.json', 'source Codex manifest proof'],
    ['.claude-plugin/marketplace.json', 'source Claude marketplace proof'],
    ['.agents/plugins/marketplace.json', 'source Codex marketplace proof'],
    ['manifest version mismatch', 'source manifest version proof'],
    ['MAX_MANIFEST_BYTES', 'bounded source manifest parsing'],
    ['repos/$REPO/actions/runs/$SOURCE_RUN_ID', 'original Electric Release run proof'],
    ['.github/workflows/electric-release.yml', 'original Electric Release workflow identity'],
    ['Exact-head CI / CI Gate', 'successful exact-head CI proof'],
    ['Build and prove release tarball', 'successful package proof'],
    ['Prove release tarball (ubuntu-latest)', 'successful Linux package proof'],
    ['Prove release tarball (macos-latest)', 'successful macOS package proof'],
    ['Prove release tarball (windows-latest)', 'successful Windows package proof'],
    ['Create protected Electric GitHub Release', 'failed protected release proof'],
    ['repos/$REPO/actions/runs/$SOURCE_RUN_ID/approvals', 'original environment approval proof'],
    ['internal-release', 'internal-release approval proof'],
    ['$RELEASE_ID', 'immutable release ID binding'],
    ['$SOURCE_SHA', 'immutable source SHA binding'],
    ['sha256:$TARBALL_SHA256', 'exact tarball digest binding'],
  ]);
  checkDraftSafeReleaseLookup(inspectStep, 'read-only recovery inspection step');

  const reverifyStep = findNamedStep(recoverJob, 'Reverify proven Electric draft recovery');
  checkRunRequirements(reverifyStep, 'protected recovery reverify step', [
    ['git/ref/heads/main', 'current-main policy guard'],
    ['if [ "$CURRENT_MAIN_SHA" != "$POLICY_SHA" ]; then', 'current-main policy guard'],
    ['repos/$REPO/actions/runs/$SOURCE_RUN_ID', 'original Electric Release run proof'],
    ['Exact-head CI / CI Gate', 'successful exact-head CI proof'],
    ['Build and prove release tarball', 'successful package proof'],
    ['Prove release tarball (ubuntu-latest)', 'successful Linux package proof'],
    ['Prove release tarball (macos-latest)', 'successful macOS package proof'],
    ['Prove release tarball (windows-latest)', 'successful Windows package proof'],
    ['repos/$REPO/actions/runs/$SOURCE_RUN_ID/approvals', 'original environment approval proof'],
    ['$RELEASE_ID', 'immutable release ID binding'],
    ['$SOURCE_SHA', 'immutable source SHA binding'],
    ['sha256:$TARBALL_SHA256', 'exact tarball digest binding'],
  ]);
  checkDraftSafeReleaseLookup(reverifyStep, 'protected recovery reverify step');

  const publishStep = findNamedStep(
    recoverJob,
    'Verify retained assets and publish by immutable ID',
  );
  checkRunRequirements(publishStep, 'retained recovery asset proof step', [
    ['releases/assets/$TARBALL_ASSET_ID', 'immutable tarball asset download'],
    ['releases/assets/$CHECKSUM_ASSET_ID', 'immutable checksum asset download'],
    ['sha256sum --check --strict SHA256SUMS', 'strict checksum verification'],
    ['npm install --global', 'retained tarball install'],
    ['if [ "$VERSION_OUTPUT" != "$VERSION" ]; then', 'exact retained version smoke'],
    ['$PREFIX/bin/gitnexus" --help', 'retained CLI help smoke'],
    ['$PREFIX/bin/gitnexus" mcp --help', 'retained MCP CLI smoke'],
    ['git/ref/heads/main', 'final current-main guard'],
    ['if [ "$FINAL_MAIN_SHA" != "$POLICY_SHA" ]; then', 'final current-main guard'],
    ['git/ref/tags/$ENCODED_TAG', 'final immutable tag guard'],
    ['if [ "$OBJECT_SHA" != "$SOURCE_SHA" ]; then', 'final immutable tag guard'],
    ['gh api --method PATCH "repos/$REPO/releases/$RELEASE_ID"', 'immutable release ID PATCH'],
    ['-F draft=false', 'draft publication PATCH'],
  ]);

  const orderedSteps = [reverifyStep, publishStep];
  if (
    orderedSteps.some((match) => !match) ||
    orderedSteps.some((match, index) => index > 0 && match.index <= orderedSteps[index - 1].index)
  ) {
    fail('electric-release-resume.yml must reverify all mutable state before publication');
  }

  const forbiddenRecoveryMutation =
    /\bgh\s+release\s+(?:create|upload)\b|\bnpm\s+pack\b|git\/(?:tags|refs)[\s\S]{0,120}--method\s+POST|--method\s+POST[\s\S]{0,120}git\/(?:tags|refs)/i;
  if (forbiddenRecoveryMutation.test(candidate.raw)) {
    fail('electric-release-resume.yml recovery may only PATCH the immutable release ID');
  }
  const patchCalls = candidate.raw.match(/gh api --method PATCH/g) ?? [];
  if (patchCalls.length !== 1) {
    fail('electric-release-resume.yml recovery may contain exactly one GitHub PATCH');
  }
  if (candidate.raw.includes('releases/tags/')) {
    fail('electric-release-resume.yml must not use the draft-invisible releases/tags endpoint');
  }
}

function main() {
  const repoRoot = parseRepoRoot(process.argv.slice(2));
  const workflows = readWorkflows(repoRoot);
  checkNoRegistryPublication(workflows);
  checkReleaseWorkflow(workflows);
  checkRecoveryWorkflow(workflows);
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
