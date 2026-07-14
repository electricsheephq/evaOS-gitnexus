import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHECKER = path.join(REPO_ROOT, '.github/scripts/check-electric-release-policy.mjs');
const temporaryRoots = [];

const validWorkflow = `name: Electric Release

on:
  workflow_dispatch:
    inputs:
      expected_version:
        required: true
        type: string
      prerelease:
        required: false
        default: false
        type: boolean

permissions: {}

jobs:
  inspect:
    permissions:
      contents: read
    steps:
      - name: Verify release identity and manifest versions
        run: |
          test "$GITHUB_REF" = refs/heads/main
          TAG="electric/v1.6.10-electric.1"
          echo "$TAG"
          echo gitnexus-claude-plugin/.claude-plugin/plugin.json
          echo gitnexus-claude-plugin/.codex-plugin/plugin.json
          echo .claude-plugin/marketplace.json
          echo .agents/plugins/marketplace.json
          echo "manifest version mismatch"
          echo MAX_MANIFEST_BYTES
          gh api --paginate --slurp "repos/$REPO/releases?per_page=100" > /tmp/release-pages.json
          RELEASE_MATCHES="$(jq --arg tag "$TAG" '[.[][] | select(.tag_name == $tag)]' /tmp/release-pages.json)"
          RELEASE_COUNT="$(jq 'length' <<< "$RELEASE_MATCHES")"
          echo "Multiple releases exist for $TAG"
  ci:
    needs: inspect
    uses: ./.github/workflows/ci.yml
    permissions:
      contents: read
      actions: read
  package:
    needs: [inspect, ci]
    permissions:
      contents: read
    steps:
      - name: Pack and install isolated CLI
        run: |
          npm pack --dry-run
          npm pack
          FILENAME="gitnexus-$EXPECTED_VERSION.tgz"
          ASSET_PATH="$FILENAME"
          if [ ! -f "$ASSET_PATH" ] || [ ! -s "$ASSET_PATH" ]; then exit 1; fi
          VERSION_OUTPUT="$EXPECTED_VERSION"
          if [ "$VERSION_OUTPUT" != "$EXPECTED_VERSION" ]; then exit 1; fi
          shasum -a 256 gitnexus-*.tgz > SHA256SUMS
      - uses: actions/upload-artifact@v4
        with:
          name: electric-release-assets
          path: |
            gitnexus-*.tgz
            SHA256SUMS
  release:
    needs: [inspect, package]
    environment:
      name: internal-release
    permissions:
      contents: write
    steps:
      - name: Reverify resumable release state
        run: |
          CURRENT_MAIN_SHA="$(gh api "repos/$REPO/git/ref/heads/main" --jq .object.sha)"
          if [ "$CURRENT_MAIN_SHA" != "$HEAD_SHA" ]; then exit 1; fi
          ENCODED_TAG="$(jq -rn --arg value "$TAG" '$value | @uri')"
          curl "https://api.github.com/repos/$REPO/git/ref/tags/$ENCODED_TAG"
          gh api --paginate --slurp "repos/$REPO/releases?per_page=100" > /tmp/release-pages.json
          RELEASE_MATCHES="$(jq --arg tag "$TAG" '[.[][] | select(.tag_name == $tag)]' /tmp/release-pages.json)"
          RELEASE_COUNT="$(jq 'length' <<< "$RELEASE_MATCHES")"
          echo "Multiple releases exist for $TAG"
          echo "tag_exists=$TAG_EXISTS"
          echo "release_exists=$RELEASE_EXISTS"
      - name: Create annotated Electric tag when absent
        if: steps.resume_state.outputs.tag_exists != 'true'
        run: |
          gh api --method POST "repos/$REPO/git/tags" -f object="$HEAD_SHA"
          gh api --method POST "repos/$REPO/git/refs"
      - name: Create or resume draft release and upload assets
        run: |
          if [ "$RELEASE_EXISTS" != "true" ]; then
            gh release create "$TAG" --draft --notes-file notes.md
          fi
          gh release upload "$TAG" --clobber gitnexus-*.tgz SHA256SUMS
      - name: Verify assets and publish the draft
        run: |
          ENCODED_TAG="$(jq -rn --arg value "$TAG" '$value | @uri')"
          gh release download "$TAG" --pattern "gitnexus-$VERSION.tgz" --pattern SHA256SUMS
          sha256sum --check SHA256SUMS
          gh api --paginate --slurp "repos/$REPO/releases?per_page=100" > /tmp/release-pages.json
          RELEASE_MATCHES="$(jq --arg tag "$TAG" '[.[][] | select(.tag_name == $tag)]' /tmp/release-pages.json)"
          RELEASE_COUNT="$(jq 'length' <<< "$RELEASE_MATCHES")"
          echo "Multiple releases exist for $TAG"
          gh api --method PATCH releases/1 -F draft=false
`;

function createFixture(workflow = validWorkflow) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-electric-release-policy-'));
  temporaryRoots.push(root);
  fs.mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github/workflows/electric-release.yml'), workflow);
  fs.writeFileSync(
    path.join(root, '.github/workflows/ci.yml'),
    'name: CI\non:\n  workflow_call:\npermissions: {}\njobs: {}\n',
  );
  return root;
}

function runChecker(root) {
  return spawnSync(process.execPath, [CHECKER, '--repo-root', root], { encoding: 'utf8' });
}

function replaceOnce(value, search, replacement) {
  assert.ok(value.includes(search), `fixture is missing ${JSON.stringify(search)}`);
  return value.replace(search, replacement);
}

test.after(() => {
  for (const root of temporaryRoots) fs.rmSync(root, { force: true, recursive: true });
});

test('accepts the protected GitHub-only electric release workflow', () => {
  const result = runChecker(createFixture());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /electric release policy check passed/);
});

test('accepts the committed repository workflow set', () => {
  const result = runChecker(REPO_ROOT);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /electric release policy check passed/);
});

test('rejects a legacy publish workflow even when the electric workflow exists', () => {
  const root = createFixture();
  fs.writeFileSync(
    path.join(root, '.github/workflows/publish.yml'),
    'name: Publish\non:\n  workflow_dispatch:\njobs: {}\n',
  );
  const result = runChecker(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /publish\.yml must not exist/);
});

test('rejects npm and Docker publication commands in any workflow', () => {
  const root = createFixture();
  fs.writeFileSync(
    path.join(root, '.github/workflows/unsafe.yml'),
    `name: Unsafe\non:\n  workflow_dispatch:\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm publish --access public\n      - run: docker login ghcr.io\n      - run: docker push ghcr.io/example/image\n`,
  );
  const result = runChecker(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /npm publish/);
  assert.match(result.stderr, /docker login/);
  assert.match(result.stderr, /docker push/);
});

test('rejects a build action whose push input is not statically false', () => {
  const root = createFixture();
  fs.writeFileSync(
    path.join(root, '.github/workflows/docker.yml'),
    `name: Docker\non:\n  pull_request:\njobs:\n  build:\n    permissions:\n      contents: read\n    steps:\n      - uses: docker/build-push-action@deadbeef\n        with:\n          push: \${{ github.event_name != 'pull_request' }}\n`,
  );
  const result = runChecker(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /push must be statically false/);
});

test('rejects docker login actions and non-static push-to-registry inputs', () => {
  const root = createFixture();
  fs.writeFileSync(
    path.join(root, '.github/workflows/unsafe-registry.yml'),
    `name: Unsafe registry\non:\n  workflow_dispatch:\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: docker/login-action@deadbeef\n      - uses: example/publisher@deadbeef\n        with:\n          push-to-registry: \${{ github.ref == 'refs/heads/main' }}\n`,
  );
  const result = runChecker(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /docker login/);
  assert.match(result.stderr, /enables registry push/);
});

test('rejects release triggers other than workflow_dispatch', () => {
  const workflow = replaceOnce(
    validWorkflow,
    'on:\n  workflow_dispatch:',
    'on:\n  push:\n    tags: ["electric/v*"]\n  workflow_dispatch:',
  );
  const result = runChecker(createFixture(workflow));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /manual-only/);
});

test('rejects a release job without the protected environment', () => {
  const workflow = replaceOnce(
    validWorkflow,
    '    environment:\n      name: internal-release\n',
    '',
  );
  const result = runChecker(createFixture(workflow));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /internal-release/);
});

test('rejects write permissions on non-release jobs', () => {
  const workflow = replaceOnce(
    validWorkflow,
    '  package:\n    needs: [inspect, ci]\n    permissions:\n      contents: read',
    '  package:\n    needs: [inspect, ci]\n    permissions:\n      contents: write',
  );
  const result = runChecker(createFixture(workflow));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must stay read-only/);
});

test('rejects registry-capable permissions and non-minimal release permissions', () => {
  const workflow = replaceOnce(
    validWorkflow,
    '    permissions:\n      contents: write\n    steps:',
    '    permissions:\n      contents: write\n      packages: write\n      id-token: write\n    steps:',
  );
  const result = runChecker(createFixture(workflow));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /packages: write/);
  assert.match(result.stderr, /id-token: write/);
  assert.match(result.stderr, /only contents: write/);
});

test('rejects registry credentials, registry configuration, and unapproved OIDC jobs', () => {
  const root = createFixture();
  fs.writeFileSync(
    path.join(root, '.github/workflows/unsafe.yml'),
    `name: Unsafe\non:\n  workflow_dispatch:\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    permissions:\n      id-token: write\n    steps:\n      - uses: actions/setup-node@deadbeef\n        with:\n          registry-url: https://registry.npmjs.org\n      - run: npm run release\n        env:\n          NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}\n`,
  );
  const result = runChecker(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /registry configuration/);
  assert.match(result.stderr, /registry credential/);
  assert.match(result.stderr, /unapproved id-token: write/);
});

test('rejects workflow-level OIDC permission outside the explicit allowlist', () => {
  const root = createFixture();
  fs.writeFileSync(
    path.join(root, '.github/workflows/unsafe.yml'),
    `name: Unsafe\non:\n  workflow_dispatch:\npermissions:\n  id-token: write\njobs:\n  run:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run release\n`,
  );
  const result = runChecker(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unapproved id-token: write/);
});

test('rejects a release flow without resumable draft and asset upload semantics', () => {
  let workflow = replaceOnce(validWorkflow, ' --draft', '');
  workflow = replaceOnce(workflow, ' --clobber', '');
  workflow = replaceOnce(workflow, ' -F draft=false', '');
  const result = runChecker(createFixture(workflow));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /draft release/);
  assert.match(result.stderr, /resumable asset upload/);
  assert.match(result.stderr, /publish the verified draft/);
});

test('rejects a release flow without protected-job state re-verification', () => {
  const workflow = replaceOnce(
    validWorkflow,
    '      - name: Reverify resumable release state\n',
    '      - name: Missing protected state verification\n',
  );
  const result = runChecker(createFixture(workflow));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /reverify resumable release state/);
});

test('rejects missing manifest verification or release ordering', () => {
  const workflow = replaceOnce(
    validWorkflow,
    'gitnexus-claude-plugin/.codex-plugin/plugin.json',
    'missing-codex-plugin.json',
  );
  const result = runChecker(createFixture(workflow));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Codex plugin manifest verification/);
});

test('rejects release mutation that does not depend on manifest verification', () => {
  const workflow = replaceOnce(
    validWorkflow,
    '  release:\n    needs: [inspect, package]',
    '  release:\n    needs: [package]',
  );
  const result = runChecker(createFixture(workflow));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /manifest verification must run before release mutation/);
});

test('rejects packaging that does not depend on exact-head CI', () => {
  const workflow = replaceOnce(
    validWorkflow,
    '  package:\n    needs: [inspect, ci]',
    '  package:\n    needs: [inspect]',
  );
  const result = runChecker(createFixture(workflow));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /package job must depend on exact-head ci/);
});

test('rejects packaging without the deterministic asset name', () => {
  const workflow = replaceOnce(
    validWorkflow,
    '          FILENAME="gitnexus-$EXPECTED_VERSION.tgz"\n',
    '          FILENAME="$(node -e \'JSON.parse(process.env.PACK_OUTPUT)\')"\n',
  );
  const result = runChecker(createFixture(workflow));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /deterministic package asset filename/);
});

test('rejects npm pack stdout parsing even when deterministic naming remains', () => {
  const workflow = replaceOnce(
    validWorkflow,
    '          FILENAME="gitnexus-$EXPECTED_VERSION.tgz"\n',
    '          FILENAME="gitnexus-$EXPECTED_VERSION.tgz"\n' +
      "          node -e 'JSON.parse(process.env.PACK_OUTPUT)'\n",
  );
  const result = runChecker(createFixture(workflow));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must not parse npm pack stdout as JSON/);
});

test('rejects package proof without regular-file and non-empty validation', () => {
  const workflow = replaceOnce(
    validWorkflow,
    '          if [ ! -f "$ASSET_PATH" ] || [ ! -s "$ASSET_PATH" ]; then exit 1; fi\n',
    '          if [ ! -s "$ASSET_PATH" ]; then exit 1; fi\n',
  );
  const result = runChecker(createFixture(workflow));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /non-empty regular package asset validation/);
});

test('rejects an unencoded slash-bearing tag-state lookup', () => {
  const workflow = replaceOnce(validWorkflow, 'git/ref/tags/$ENCODED_TAG', 'git/ref/tags/$TAG');
  const result = runChecker(createFixture(workflow));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /URL-encoded tag-state lookup/);
});

test('rejects protected mutation without a fresh current-main guard', () => {
  const workflow = replaceOnce(validWorkflow, 'git/ref/heads/main', 'git/ref/heads/stale');
  const result = runChecker(createFixture(workflow));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fresh current-main guard/);
});

test('rejects tag creation without the resumable-state guard', () => {
  const workflow = replaceOnce(
    validWorkflow,
    "        if: steps.resume_state.outputs.tag_exists != 'true'\n",
    '',
  );
  const result = runChecker(createFixture(workflow));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /tag creation guard/);
});

test('rejects tag creation that does not target the exact inspected head', () => {
  const workflow = replaceOnce(validWorkflow, '-f object="$HEAD_SHA"', '-f object="$GITHUB_SHA"');
  const result = runChecker(createFixture(workflow));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exact-head tag target/);
});

test('rejects the draft-invisible release-by-tag endpoint', () => {
  const workflow = replaceOnce(
    validWorkflow,
    'gh api --paginate --slurp "repos/$REPO/releases?per_page=100"',
    'gh api "repos/$REPO/releases/tags/$ENCODED_TAG"',
  );
  const result = runChecker(createFixture(workflow));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /draft-safe paginated release list lookup/);
});

test('rejects a release list lookup without pagination', () => {
  const workflow = replaceOnce(
    validWorkflow,
    'gh api --paginate --slurp "repos/$REPO/releases?per_page=100"',
    'gh api "repos/$REPO/releases?per_page=100"',
  );
  const result = runChecker(createFixture(workflow));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /draft-safe paginated release list lookup/);
});

test('rejects release discovery without exact tag filtering', () => {
  const workflow = replaceOnce(validWorkflow, '.tag_name == $tag', '.draft == true');
  const result = runChecker(createFixture(workflow));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exact release tag filter/);
});

test('rejects release discovery without duplicate detection', () => {
  const workflow = replaceOnce(
    validWorkflow,
    '          echo "Multiple releases exist for $TAG"\n',
    '',
  );
  const result = runChecker(createFixture(workflow));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /duplicate release rejection/);
});

test('rejects publish without re-downloading and checksum-verifying release assets', () => {
  let workflow = replaceOnce(
    validWorkflow,
    '          gh release download "$TAG" --pattern "gitnexus-$VERSION.tgz" --pattern SHA256SUMS\n',
    '',
  );
  workflow = replaceOnce(workflow, '          sha256sum --check SHA256SUMS\n', '');
  const result = runChecker(createFixture(workflow));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fresh release asset download/);
  assert.match(result.stderr, /fresh release checksum verification/);
});

test('rejects missing electric tag, tarball, or checksum wiring', () => {
  let workflow = validWorkflow.replaceAll('electric/v1.6.10-electric.1', 'v1.6.10');
  workflow = workflow.replaceAll('gitnexus-*.tgz', 'bundle.zip');
  workflow = workflow.replaceAll('SHA256SUMS', 'checksums.txt');
  const result = runChecker(createFixture(workflow));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /electric\/v/);
  assert.match(result.stderr, /\.tgz/);
  assert.match(result.stderr, /SHA256SUMS/);
});
