# Electric Fork GitHub Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fork's public registry publisher with a protected GitHub-only release lane and ship `electric/v1.6.10-electric.1` with an installable tarball and SHA-256 checksum.

**Architecture:** The repository keeps ordinary CI and container scans as validation, deletes the upstream npm/Docker publisher, and adds one manual `electric-release.yml` workflow. A standalone policy checker validates workflow structure and forbidden publication commands locally and in CI; a protected release job creates only an `electric/v*` GitHub tag/release after exact-head CI and packaged-install proof.

**Tech Stack:** GitHub Actions YAML, Node.js ESM policy checker, `node:test`, npm pack, GitHub Releases, SHA-256.

## Global Constraints

- Fork package versions match `^[0-9]+\.[0-9]+\.[0-9]+-electric\.[0-9]+$`.
- Fork tags match `electric/v<version>` and never use upstream `v*` or npm dist-tags.
- No workflow may run `npm publish`, push Docker images, authenticate to npm/container registries, or request `packages: write` or `id-token: write` for releases.
- The only write-capable release job uses protected environment `internal-release` and `contents: write`.
- Release assets are `gitnexus-<version>.tgz` and `SHA256SUMS`.
- No task mutates OpenClaw, a live GitNexus index, embeddings, npm, Docker registries, or deployed runtime state.
- Promotion PR #98 is merged with a merge commit to preserve the reviewed capability history.

---

### Task 1: Promote the reviewed reconciliation source

**Files:** None.

**Interfaces:**
- Consumes: PR #98 head `2ec953bda2dbccfa2605cea2992879925d277e54` and green required checks.
- Produces: fork `main` containing the reconciled source, with no release side effect.

- [ ] **Step 1: Rehydrate exact-head merge state**

Run:

```bash
gh pr view 98 --repo electricsheephq/evaOS-gitnexus \
  --json state,headRefOid,baseRefOid,mergeable,reviewDecision,isDraft
gh pr checks 98 --repo electricsheephq/evaOS-gitnexus --required
```

Expected: open, non-draft, exact head `2ec953bd`, mergeable, approved, all required checks pass.

- [ ] **Step 2: Merge without squash or branch deletion**

Run:

```bash
gh pr merge 98 --repo electricsheephq/evaOS-gitnexus --merge
```

Expected: PR merged normally; no workflow dispatch, tag, package, release, or runtime change.

- [ ] **Step 3: Verify default-branch identity**

Run:

```bash
gh pr view 98 --repo electricsheephq/evaOS-gitnexus --json state,mergedAt,mergeCommit
git ls-remote origin refs/heads/main
```

Expected: merged state and new `main` merge commit containing `2ec953bd` as ancestry.

### Task 2: Add a fail-closed fork release policy checker

**Files:**
- Create: `.github/scripts/check-electric-release-policy.mjs`
- Create: `.github/scripts/check-electric-release-policy.test.mjs`
- Modify: `package.json`
- Delete: `.github/scripts/check-release-governance.mjs`

**Interfaces:**
- Consumes: a repository root passed as `--repo-root <path>` or the current repository by default.
- Produces: exit 0 and `electric release policy check passed`, or nonzero with one specific policy error per line.

- [ ] **Step 1: Write the failing policy tests**

Use `node:test` fixtures to prove:

```javascript
test('accepts the protected GitHub-only electric release workflow', () => {
  const result = runChecker(validFixture());
  assert.equal(result.status, 0, result.stderr);
});

test('rejects npm publication and registry-capable permissions', () => {
  const root = validFixture();
  appendWorkflow(root, 'npm publish --access public');
  const result = runChecker(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /npm publish/);
});

test('rejects missing protected environment and non-electric tags', () => {
  const root = invalidReleaseFixture({ environment: null, tagPrefix: 'v' });
  const result = runChecker(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /internal-release/);
  assert.match(result.stderr, /electric\/v/);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
node --test .github/scripts/check-electric-release-policy.test.mjs
```

Expected: FAIL because the checker does not exist.

- [ ] **Step 3: Implement the minimal checker**

The checker must parse every `.yml` workflow, require `electric-release.yml`, reject `publish.yml`, scan scalar strings for forbidden publication commands, and validate:

```javascript
const FORBIDDEN = [
  /\bnpm\s+publish\b/i,
  /docker\s+(?:push|login)\b/i,
  /\bpackages:\s*write\b/i,
  /\bid-token:\s*write\b/i,
];
```

It must require `workflow_dispatch`, reject all other release triggers, require `internal-release`, require `contents: write` only on the release job, and require literal `electric/v` plus tarball/checksum asset wiring.

- [ ] **Step 4: Run the focused tests and repository policy command**

Run:

```bash
node --test .github/scripts/check-electric-release-policy.test.mjs
npm run check:electric-release-policy
```

Expected: PASS after Task 3 adds the workflow; before that, the repository command must fail specifically because `electric-release.yml` is missing.

- [ ] **Step 5: Commit policy checker and tests with Task 3 workflow**

Commit after the workflow exists so the repository never lands in an intentionally failing state.

### Task 3: Replace public publishing with a protected GitHub Release workflow

**Files:**
- Delete: `.github/workflows/publish.yml`
- Create: `.github/workflows/electric-release.yml`
- Modify: `.github/workflows/ci-quality.yml`
- Modify: `gitnexus/test/unit/sync-plugin-versions.test.ts`
- Modify: `RUNBOOK.md`

**Interfaces:**
- Consumes: `workflow_dispatch` inputs `expected_version` and `prerelease` on `main`.
- Produces: a protected `electric/v<version>` GitHub Release with `.tgz` and `SHA256SUMS` assets.

- [ ] **Step 1: Update synchronization test first**

Change the release-workflow assertion to read `electric-release.yml` and require version verification before the tag/release action. Run:

```bash
cd gitnexus
npx vitest run test/unit/sync-plugin-versions.test.ts
```

Expected: FAIL because `electric-release.yml` does not exist.

- [ ] **Step 2: Create the manual workflow**

The workflow has these jobs:

```yaml
jobs:
  inspect:
    permissions:
      contents: read
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
  release:
    needs: [inspect, package]
    environment:
      name: internal-release
    permissions:
      contents: write
```

`inspect` validates ref, current remote main, package name/version, expected version, plugin manifests, and tag/release absence. `package` runs build, pack dry-run, pack, isolated install/version/help smoke, and checksum creation. `release` downloads the artifact and uses a pinned GitHub Release action to create `electric/v${version}` at the validated SHA.

- [ ] **Step 3: Remove the public publisher and update CI policy**

Delete `publish.yml`. Replace `check:release-governance` with `check:electric-release-policy` in root `package.json`, and run it from the quality workflow.

- [ ] **Step 4: Document operator and consumer commands**

Add a `Fork releases` section to `RUNBOOK.md` covering release PR, workflow dispatch, checksum verification, local `.tgz` installation, and the prohibition on npm/Docker publication.

- [ ] **Step 5: Verify focused workflow policy**

Run:

```bash
node --test .github/scripts/check-electric-release-policy.test.mjs
npm run check:electric-release-policy
npx prettier --check .github/workflows/electric-release.yml \
  .github/scripts/check-electric-release-policy.mjs \
  .github/scripts/check-electric-release-policy.test.mjs RUNBOOK.md package.json
git diff --check
```

Expected: all pass and `rg -n 'npm publish|docker push|docker login' .github/workflows` returns no release-publication command.

- [ ] **Step 6: Run the focused plugin synchronization test**

Run:

```bash
cd gitnexus
npx vitest run test/unit/sync-plugin-versions.test.ts
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add .github package.json gitnexus/test/unit/sync-plugin-versions.test.ts RUNBOOK.md
git commit -m "ci: add fork-only GitHub release workflow"
```

### Task 4: Review and land release governance

**Files:** No new source files.

**Interfaces:**
- Consumes: release-governance branch based on merged PR #98.
- Produces: reviewed fork `main` with no public publisher and a protected GitHub-only release workflow.

- [ ] **Step 1: Push and open one capability PR**

Create a release-blocker issue and PR linking the design, focused tests, prohibited-action scan, and rollback.

- [ ] **Step 2: Wait for exact-head required CI and review**

Verify required contexts, review threads, check annotations, and the release-policy job separately.

- [ ] **Step 3: Merge with normal protection**

Use a merge commit, do not bypass protection, and verify no tag/release/package was created.

### Task 5: Prepare `1.6.10-electric.1`

**Files:**
- Modify: `gitnexus/package.json`
- Modify: `gitnexus/package-lock.json`
- Modify: `gitnexus-claude-plugin/.claude-plugin/plugin.json`
- Modify: `gitnexus-claude-plugin/.codex-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `.agents/plugins/marketplace.json`
- Modify: `gitnexus/CHANGELOG.md`
- Create: `Documentation/releases/1.6.10-electric.1.md`

**Interfaces:**
- Consumes: release-governed fork `main`.
- Produces: exact, synchronized `1.6.10-electric.1` source ready for protected dispatch.

- [ ] **Step 1: Write the release-note and version-policy expectation**

The release notes use Highlights, Changes, Fixes, Known Boundaries, and Release Verification. They state GitHub-only distribution and no automatic runtime/index migration.

- [ ] **Step 2: Apply the version and synchronize manifests**

Run:

```bash
cd gitnexus
npm version 1.6.10-electric.1 --no-git-tag-version
node scripts/sync-plugin-versions.mjs
```

- [ ] **Step 3: Run focused release preparation checks**

Run the synchronization test, release policy, build, typecheck, `npm pack --dry-run`, and isolated tarball install/version smoke.

- [ ] **Step 4: Open, review, and merge a release-only PR**

No workflow dispatch or tag creation occurs in this task.

### Task 6: Create and verify the GitHub Release

**Files:** No repository edits.

**Interfaces:**
- Consumes: merged `main` at version `1.6.10-electric.1`.
- Produces: immutable tag `electric/v1.6.10-electric.1`, GitHub Release, tarball, and checksum.

- [ ] **Step 1: Dispatch from exact `main`**

Run:

```bash
gh workflow run electric-release.yml \
  --repo electricsheephq/evaOS-gitnexus \
  --ref main \
  -f expected_version=1.6.10-electric.1 \
  -f prerelease=false
```

- [ ] **Step 2: Approve only the protected release environment gate**

Confirm the run's exact head and artifact proof before approving `internal-release`.

- [ ] **Step 3: Verify immutable release state**

Download the `.tgz` and `SHA256SUMS`, verify SHA-256, install into an isolated prefix, and confirm `gitnexus --version` reports `1.6.10-electric.1`.

- [ ] **Step 4: Verify prohibited surfaces stayed unchanged**

Confirm npm `gitnexus` dist-tags are unchanged, no Docker package was published, OpenClaw/runtime was untouched, and the live index was not opened or modified.

- [ ] **Step 5: Close the release issue with exact SHA/tag/assets**

Link the workflow run, release URL, tag commit, checksums, and rollback boundary.
