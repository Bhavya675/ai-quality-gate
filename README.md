# AI Quality Gate

AI-powered GitHub pull-request review using Gemini and GitHub Actions.

## What is wired up

For `opened`, `synchronize`, `reopened`, and `ready_for_review` pull-request events, the workflow:

1. Checks out the trusted base-branch version of this project.
2. Retrieves pull-request metadata and changed source files from GitHub.
3. Applies the review file policy and builds the review context.
4. Runs the Gemini review and validates the structured result.
5. Persists signed review state in a dedicated pull-request comment.
6. Creates or updates the visible AI Quality Gate result comment.
7. Fails the GitHub Actions job when the review is incomplete or contains an open blocker.

The PR source is retrieved from GitHub at the pull-request head SHA. The workflow does not check out or execute code from the pull-request branch.

## GitHub repository setup

Create these repository Actions secrets under **Settings → Secrets and variables → Actions**:

- `GEMINI_API_KEY`: the Google AI Studio API key.
- `REVIEW_STATE_SIGNING_SECRET`: a random secret of at least 32 characters. Keep it stable between runs because it is used to verify previously stored review state.

The workflow uses the automatically provided `GITHUB_TOKEN`; no personal access token is required for the normal same-repository workflow.

Ensure GitHub Actions is enabled for the repository. The workflow needs the permissions declared in `.github/workflows/ai-quality-gate.yml`:

- `contents: read`
- `pull-requests: write`
- `issues: write`

## Local configuration

Copy `.env.example` to `.env` and set the same values for local execution. Never commit `.env` or share API keys. `REVIEW_GUIDELINES_SHA` must be the SHA-256 hash of `docs/review-guidelines.md`.

PowerShell command to calculate the hash:

```powershell
(Get-FileHash .\docs\review-guidelines.md -Algorithm SHA256).Hash.ToLower()
```

## Commands

```powershell
npm ci
npm run build
npm test
```

The `npm run review` command is intended to run inside a GitHub Actions `pull_request` event because it reads `GITHUB_EVENT_PATH` and uses the event payload.

## Enforce the gate before merging

After the workflow has completed successfully at least once, open **Settings → Branches** (or the repository's ruleset settings) and require the `AI Quality Gate` job/check for the target branch. Also require any normal build/test checks that protect the project. A failed AI Quality Gate job will then block merging under that rule.

## Current POC boundaries

- Findings are published in a single updated pull-request summary comment; they are not yet posted as inline code-review threads.
- A `FAIL` verdict makes the workflow job fail. `WORTH_A_LOOK` and `NIT` findings do not fail the gate.
- Automatic confirmation that a previous finding is fixed is disabled until source-code resolution verification is implemented.
- Fork pull requests do not receive repository secrets through the standard `pull_request` event, so Gemini review requires a same-repository PR or a separately designed secure fork workflow.
