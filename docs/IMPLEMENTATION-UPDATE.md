# Implementation update — 2026-11-04

## Changes included

### Finding lifecycle authority

- AI-returned `status` and `occurrence` values are no longer trusted by `ReviewService`.
- Every finding returned by the AI is normalized to `status: open` and `occurrence: new` before server-side deduplication and tracking.
- The server-side tracker remains responsible for marking a finding as previously reported.
- If a finding previously marked resolved is reported again by the current AI review, it is reopened.

### Automatic resolution is fail-closed

- `CONFIRMED_FIXED` is rejected by `verifyFindingResolution`.
- `STILL_PRESENT` and `UNVERIFIED` keep the previous finding open.
- Automatic resolution must remain disabled until a separate verifier actually inspects the updated source and supplies independently derived evidence.
- Non-empty caller-provided text and a matching commit SHA alone are not proof that a defect is fixed.

### Secret hygiene

- `.env` has been excluded from this archive.
- `.gitignore` now excludes `.env`, other `.env.*` files, `node_modules`, build output, coverage, and logs while allowing `.env.example`.
- `.env.example` contains only blank placeholders and non-secret defaults.

## Verification status

The source changes and test expectations were updated. Automated verification could not be completed in this packaging environment because dependencies were not available: `npm ci` timed out, `vitest` was unavailable, and the TypeScript compiler reported that the Node type definitions could not be found. This archive must therefore be verified locally after installing dependencies:

```powershell
npm ci
npm run build
npm test
```

Do not treat this archive as a fully verified or production-ready release.

## Known remaining work

- Implement actual source-code-based resolution verification before enabling `CONFIRMED_FIXED`.
- Handle PRs with no eligible source files so they cannot produce a misleading PASS.
- Add cross-runner concurrency and stale-write protection for persisted review state.
- Verify base and head commit consistency throughout PR context retrieval.
- Harden review-context serialization against hostile repository content.
- Add GitHub comment publishing, required status checks, Actions workflows, merge queue support, and end-to-end tests.
