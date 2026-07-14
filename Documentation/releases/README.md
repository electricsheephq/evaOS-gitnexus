# Electric Release Notes

Each Electric fork release must add a versioned Markdown file here before the
protected release workflow can run:

```text
Documentation/releases/<version>.md
```

Use the fork version and tag conventions `X.Y.Z-electric.N` and
`electric/vX.Y.Z-electric.N`. Release notes should lead with user and operator
outcomes, then list highlights, changes, fixes, known boundaries, and compact
release verification. State the upstream source floor honestly; an Electric
version does not imply that an identically numbered upstream stable tag exists.

The workflow rejects a missing or mismatched version file before packaging. A
release PR must update this directory, `gitnexus/CHANGELOG.md`, the package
version and lockfile, and every plugin and marketplace manifest together.
