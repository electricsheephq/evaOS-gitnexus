# ElectricSheep Fork Catch-Up Review — 2026-05-10

## Branch Count Reconciliation

Compared `electricsheephq/GitNexus:main` against `abhigyanpatwari/GitNexus:main` after the catch-up push.

| Source | Result |
| --- | --- |
| Local `git rev-list --left-right --count upstream/main...origin/main` | `0 3` |
| GitHub compare API `abhigyanpatwari:main...electricsheephq:main` | `ahead_by=3`, `behind_by=0` |
| Public fork page | No stale `10 ahead / 616 behind` banner visible in rendered page text |

Current fork-only commits:

1. `4020f243` — `fix: normalize parameter aliases for impact and context tools (#5)`
2. `e9d0bb24` — `feat: add token-budgeted query output`
3. `6834a2e4` — `feat: eval-server bearer token authentication`

## Original 10-Commit Disposition

The pre-catch-up fork head was `38a4f909`. Its fork-only range from upstream base `6c18ae08` contained 10 commits.

| Original commit | Subject | Disposition | Reason |
| --- | --- | --- | --- |
| `7e9ddc7b` | `feat: add .gitnexusignore file support and ignore filter infrastructure` | Replaced by upstream | Upstream now has `.gitignore` / `.gitnexusignore` discovery and later ignore-rule fixes, including `fbff6d08`, `10f88156`, `0418cbb3`, and `248cb1e6`. |
| `df7870e9` | `feat: add --exclude CLI flag on analyze command` | Intentionally dropped | Upstream added broader ignore and indexing controls instead; carrying this old CLI shape would reintroduce outdated `runPipelineFromRepo` wiring. |
| `bc8f4e15` | `feat: add token-budgeted query output` | Carried | Replayed as `e9d0bb24`, then hardened to validate token budgets and move helpers out of ignore-service. |
| `18c8879d` | `feat: configurable AGENTS.md/CLAUDE.md generation` | Replaced by upstream | Upstream now supports `--skip-agents-md` and `--no-stats`; newer context generation includes group-aware behavior. |
| `d5c23fca` | `feat: eval-server bearer token authentication` | Carried | Replayed as `6834a2e4`, then hardened so `/health` remains usable without leaking repo names. |
| `f250f404` | `Merge pull request #1 from 100yenadmin/feat/evaos-customizations` | Intentionally dropped | Merge commit only; substantive children were individually classified. |
| `794fbdef` | `fix: --skip-agents-md/--skip-claude-md flags (Commander --no- prefix bug)` | Replaced by upstream | Upstream adopted `--skip-agents-md` semantics and removed the problematic old `--no-*` split. |
| `2fcc9fba` | `Merge pull request #2 from 100yenadmin/fix/no-agents-md-flag` | Intentionally dropped | Merge commit only; substantive child was replaced by upstream behavior. |
| `0438759a` | `fix: normalize parameter aliases for impact and context tools (#5)` | Carried | Replayed as `4020f243`; still needed for documented alias compatibility. |
| `38a4f909` | `fix(mcp): detect stale DB after re-indexing and reconnect (#297)` | Replaced by upstream | Original was a cherry-pick of upstream PR #297; upstream now contains the newer implementation and follow-up staleness work. |

## Hardening Follow-Up

The carried commits were reviewed for merge hazards. Follow-up hardening keeps the fork-only intent but removes the two review risks found during catch-up:

- Eval-server auth now protects `/tool/*` and `/shutdown`, while unauthenticated `/health` returns only `{ "status": "ok", "auth": "required" }`.
- `maxTokens` parsing now rejects invalid values instead of silently ignoring them.
- Token-budget helpers now live under CLI code instead of `ignore-service`.
- Dispatch tests cover `context({ symbol, file })`, `impact({ name })`, `impact({ symbol })`, and default `direction: "upstream"`.
