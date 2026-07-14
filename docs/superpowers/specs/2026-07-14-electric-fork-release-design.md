# Electric Fork GitHub Release Design

Date: 2026-07-14
Repository: `electricsheephq/evaOS-gitnexus`
Status: approved direction; implementation follows this contract

## Purpose

Electric Sheep maintains a long-lived GitNexus fork. Fork releases are downloadable GitHub Releases, not npm or container-registry publications. The release system must make an installable CLI artifact available without risking the public upstream `gitnexus` npm package or Docker namespaces.

## Considered Approaches

### A. Protected GitHub Release with installable assets (selected)

Create `electric/v<version>` tags through a manual protected workflow. Attach the packed npm tarball and a SHA-256 checksum file to the GitHub Release. This preserves normal Node installation from a file or URL without publishing to a registry.

### B. Tag and source archives only

Rely on GitHub's automatic source `.zip` and `.tar.gz` archives. This is simpler, but consumers must clone/build the repository and do not receive the exact packed CLI artifact that validation exercised.

### C. Private registry publication

Publish to GitHub Packages or a private npm registry. This adds registry credentials, account routing, dist-tags, retention, and install configuration that the fork does not need.

Approach A is selected because it gives users a directly installable artifact while keeping the release surface entirely inside GitHub.

## Release Identity

- Package name inside the tarball remains `gitnexus` for CLI compatibility.
- Fork versions use `<upstream-base>-electric.<N>`, beginning with `1.6.10-electric.1`.
- Git tags use `electric/v<version>`, for example `electric/v1.6.10-electric.1`.
- The version committed to `gitnexus/package.json`, its lockfile, and plugin manifests must match exactly before release.
- Fork releases never use upstream `v*`, `rc`, `latest`, beta, or npm dist-tag namespaces.

## Repository Changes

1. Delete `.github/workflows/publish.yml` so the fork has no npm, Docker, upstream-style tag, or public registry publisher.
2. Add `.github/workflows/electric-release.yml` as the only fork release creator.
3. Add a policy test that fails if a workflow contains `npm publish`, registry login/push steps, upstream-style release tags, or an unauthorized release trigger.
4. Document the fork release procedure and installation commands.
5. Retain ordinary Docker build and Trivy workflows as validation only; they must not authenticate or push during fork releases.

## Workflow Contract

The workflow is manual-only through `workflow_dispatch` and may run only from `main`.

### Inputs

- `expected_version`: required exact version confirmation.
- `prerelease`: optional boolean, default `false`.

### Readiness Job

The readiness job has read-only permissions and fails before artifact creation when any condition is false:

- workflow ref is `refs/heads/main`;
- `gitnexus/package.json` name is exactly `gitnexus`;
- package version matches `^[0-9]+\.[0-9]+\.[0-9]+-electric\.[0-9]+$`;
- `expected_version` equals the package version;
- plugin manifest versions equal the package version;
- tag `electric/v<version>` does not already exist;
- a GitHub Release for that tag does not already exist;
- the checked-out commit is current remote `main`.

The workflow then invokes the repository's reusable CI matrix on the exact source head.

### Artifact Job

After CI succeeds, an unprivileged job:

- installs dependencies from the committed lockfile;
- builds the CLI;
- runs `npm pack --dry-run`;
- creates the `.tgz` using `npm pack`;
- installs the tarball into an isolated temporary prefix;
- proves `gitnexus --version` equals the expected fork version;
- runs CLI help and packaged MCP/plugin discovery smokes that do not mutate a live index;
- creates `SHA256SUMS` for the tarball;
- uploads the tarball and checksum as a temporary workflow artifact.

No network model, embedding provider, npm publish, Docker push, live index, or OpenClaw corpus analysis is used.

### Release Job

The only write-capable job:

- uses the protected `internal-release` environment;
- receives only `contents: write` permission;
- downloads the proven workflow artifact;
- creates annotated tag `electric/v<version>` at the exact validated `main` SHA;
- creates a GitHub Release with human-readable notes;
- attaches the `.tgz` and `SHA256SUMS`;
- fails when the tag/release already exists rather than overwriting it.

The job receives no npm token, registry token, `packages: write`, `id-token: write`, or Docker credentials.

## Release Preparation

Every release is prepared through a separate release PR that:

- changes `gitnexus/package.json` and `gitnexus/package-lock.json` to the fork version;
- synchronizes all plugin manifest versions with the existing repository script;
- adds a human-readable changelog section and release notes;
- contains no runtime rollout or index mutation;
- passes focused version-policy tests and the normal required CI matrix.

Merging a release PR does not create a tag or release. The protected workflow dispatch is a separate approval gate.

## Download And Installation

Each GitHub Release provides:

- GitHub-generated source archives;
- `gitnexus-<version>.tgz`;
- `SHA256SUMS`.

Supported installation examples:

```bash
npm install --global ./gitnexus-1.6.10-electric.1.tgz
```

or from the GitHub asset URL:

```bash
npm install --global https://github.com/electricsheephq/evaOS-gitnexus/releases/download/electric%2Fv1.6.10-electric.1/gitnexus-1.6.10-electric.1.tgz
```

Consumers verify the checksum before installation. A local OpenClaw or evaOS rollout remains a separate runtime change with its own rollback and does not trigger re-indexing by default.

## Failure And Rollback

- Before tag creation: a failed job leaves no release state; rerun after fixing the source or workflow.
- After tag creation but failed release creation: stop and repair the release transaction; do not silently retarget or overwrite a published tag.
- Faulty source release: revert through a reviewed PR and publish a new increment such as `1.6.10-electric.2`; never rewrite the prior tag.
- Local installation rollback: retain the previous tarball/install prefix and switch back without modifying the live GitNexus index.

## Acceptance Contract

- No fork workflow contains an npm or Docker publication command.
- The only release tag creator uses the `electric/v` namespace and protected environment.
- A wrong ref, version, tag, package identity, or stale main head fails before any write.
- The packed tarball installs and reports the exact fork version.
- Release assets include the tarball and matching SHA-256 checksum.
- A duplicate release attempt fails closed.
- No release step uses external embeddings, a live index, npm publication, Docker publication, deployment, or OpenClaw runtime mutation.
