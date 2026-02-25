# Changelog

All notable changes to Claude BugBot GitHub Action will be documented in this file.

## [1.0.0-beta.9] - 2026-02-25

### Fixed

- **Reverted to `spawnSync` for analysis** — Async `spawn` produced zero output on every attempt regardless of stdin, prompt size, stdio config, or timeout length. `spawnSync` is used for `checkAuth` and reliably works. The root cause of the original `spawnSync` ETIMEDOUT hang was the auth env var conflict (fixed in beta.3), not `spawnSync` itself. With auth now confirmed working, `spawnSync` + 5-minute timeout is the correct approach.

### Changed

- `runClaude()` now uses `spawnSync` with `timeout: 300s` and `killSignal: 'SIGKILL'`; on `ETIMEDOUT` it retries up to 3 times
- Removed `runClaudeAttempt()` helper (was only needed for async spawn stall detection)
- Removed `spawn` import (no longer used)
- Renamed constant `STALL_TIMEOUT_MS` → `ANALYSIS_TIMEOUT_MS` (5 minutes)
- Stderr is printed after completion (can't stream live with `spawnSync`)

---

## [1.0.0-beta.8] - 2026-02-25

### Changed

- **Stall timeout raised from 60s to 3 minutes** — Claude sonnet analyzing a real diff can legitimately take 1–2+ minutes before producing its first output token (especially with `--output-format json` which may buffer until the full response is ready). The 60s threshold was killing the process mid-analysis. 3 minutes gives normal runs enough headroom while still catching genuinely stuck processes.
- **Idle heartbeat threshold raised from 15s to 30s** — Reduces log noise during the first 30s of normal startup before the heartbeat countdown begins.

---

## [1.0.0-beta.7] - 2026-02-25

### Fixed

- **Claude process producing zero output / hanging on all attempts** — Root cause: `claude -p "prompt"` in non-interactive mode does not read from piped stdin. The async `spawn` was writing the diff to stdin, but claude ignored it and stalled indefinitely waiting on the unread pipe. Fix: the diff is now embedded directly at the end of the `-p` prompt argument so no stdin is needed at all.

### Changed

- `buildPrompt()` now accepts `diff` as a parameter and appends the full diff content to the prompt string under a `Here is the PR diff to analyze:` header
- `runClaudeAttempt()` spawns with `stdio: ['ignore', 'pipe', 'pipe']` — stdin is explicitly closed (`/dev/null`); stdout and stderr remain piped as before
- `diff` parameter removed from `runClaudeAttempt()` signature (diff is now part of `args` via the prompt)

---

## [1.0.0-beta.6] - 2026-02-25

### Changed

- **Live stdout streaming added** — Claude CLI stdout is now also piped to `process.stdout` in real time alongside stderr, so the full output stream (including the JSON response as it builds) is visible in the Actions log as it arrives.

---

## [1.0.0-beta.5] - 2026-02-25

### Added

- **Stall detection with automatic retry** — `runClaude()` now uses async `spawn` instead of `spawnSync`. A stall checker fires every 5s; if no output (stdout or stderr) is received for 60s, the process is killed with `SIGKILL` and automatically retried. Up to 3 attempts are made before failing, with a 5s pause between retries.
- **Live stderr streaming** — Claude CLI stderr is now piped to `process.stderr` in real time so the Actions log shows Claude's progress (thinking steps, tool use, etc.) as it happens instead of only on exit.
- **Idle heartbeat** — If the process has been silent for more than 15s, a `⏳ No output for Xs (kill threshold: 60s)...` line is logged every 5s so it's clear the process is alive but quiet, not invisibly hung.

### Changed

- `runClaude()` is now `async` (returns a `Promise`); call site in `main()` updated to `await runClaude(diff)`
- `runClaudeAttempt()` extracted as a private helper that encapsulates a single spawn attempt and resolves with `{ stalled }`, `{ success, stdout }`, `{ success: false, code, stderr }`, or `{ spawnError }` for clean retry logic
- Stall timeout (`60s`) and max attempts (`3`) defined as top-level constants for easy tuning
- Stderr no longer printed as a block on process exit — it was already shown live

---

## [1.0.0-beta.4] - 2026-02-25

### Added

- **PAT support for thread resolution** — `github-token` input now accepts a Personal Access Token with `repo` scope as an alternative to the default `GITHUB_TOKEN`. Useful when `resolveReviewThread` GraphQL mutations fail with `Resource not accessible by integration` errors due to repo-level permission restrictions. Example workflow now includes a commented-out `github-token: ${{ secrets.GH_PAT }}` option.
- **Permission documentation** — README and action description now explicitly call out that `pull-requests: write` is required for both posting comments and resolving threads, and note the repo-level setting (Settings → Actions → General → Workflow permissions → "Read and write permissions") that can silently override workflow-level declarations.

### Removed

- **"Fix in VS Code" and "Fix in Web" links** — Removed `vscode://` deep-links and `claude.ai/new` links from all inline review comments and orphan bug entries in the summary comment. Comments are now focused on the bug description only.
- **`buildFixPrompt()`** — Helper function removed along with the fix links.

### Fixed

- **`gh: Resource not accessible by integration` on thread resolution** — `resolveReviewThread` GraphQL mutation fails when the default `GITHUB_TOKEN` integration token lacks the necessary permissions. Fix: pass a PAT with `repo` scope via `secrets.GH_PAT` and set `github-token: ${{ secrets.GH_PAT }}` in the workflow.

### Changed

- `postReview()` and `formatInlineComment()` no longer accept or forward a `branch` parameter (was only used for fix links)
- README Quick Start step 2 updated with optional `GH_PAT` secret instructions and when to use it

---

## [1.0.0-beta.3] - 2026-02-24

### Added

- **Auth verification before analysis** — `checkAuth()` makes a live API call (`Reply with the single word: ok`) using the configured model before running the full diff analysis. Confirms the token is valid and the API is reachable; fails fast with a clear error rather than burning the 5-minute analysis timeout on a bad credential.
- **Masked credential logging** — The active token or API key is logged in masked form (`sk-ant-oat01-...wxyz`) so it's easy to confirm the right secret is being used without exposing the full value.
- **`claude --version` pre-flight** — Logged before every run to confirm the installed CLI version.

### Fixed

- **Auth env var conflict causing 5-minute hang** — When only `claude-setup-token` was provided, `ANTHROPIC_API_KEY` was still being set to an empty string in the runner environment. The Anthropic SDK inside the `claude` binary sees a set-but-empty `ANTHROPIC_API_KEY`, attempts API key auth with a blank value, receives a 401, and hangs in a retry/fallback loop for the full 5-minute timeout. The fix adds an explicit "Configure auth" step that writes only the non-empty auth var to `$GITHUB_ENV` — the other is left truly absent from the environment.

### Changed

- Auth configuration split into its own `Configure auth` step, separate from the analysis step, to ensure mutual exclusivity between `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY`
- `Run bug analysis` step no longer sets auth env vars directly; it relies on vars written to `$GITHUB_ENV` by the configure step
- Auth ping uses `MODEL` (defaults to `sonnet`) to validate the exact model the analysis will use

---

## [1.0.0-beta.2] - 2026-02-24

### Added

- **Stderr capture for diagnostics** — Claude CLI stderr is now captured and printed to the action log before any error is thrown, making it possible to see what claude was actually doing when a run fails or times out
- **CI environment hardening** — Passes `CI=true`, `NO_COLOR=1`, `TERM=dumb`, and `CLAUDE_NO_TELEMETRY=1` to the claude process to suppress interactive prompts, update checks, and terminal color codes that can cause hangs in headless runners
- **Auto-updater and telemetry disabled on first run** — `~/.claude.json` now includes `autoUpdaterStatus: "disabled"` and `enableTelemetry: false` to prevent first-run prompts from blocking the action

### Fixed

- **`ETIMEDOUT` hang in GitHub Actions** — The action was silently running the full 5-minute timeout because claude was waiting on a prompt or blocking on first-run initialization. The above changes suppress all known interactive flows so claude exits cleanly without user input.

### Changed

- `runClaude()` switched from `execFileSync` to `spawnSync` to enable separate stdout/stderr capture
- Improved error messages: exit status and stderr are both included when claude exits non-zero

---

## [1.0.0-beta.1] - 2026-02-24

### Added

- **Additional Locations** — Each inline comment lists other files in the diff that share the same bug pattern, with clickable GitHub links to the exact line (`file.ts:42` → `github.com/.../blob/<sha>/file.ts#L42`)
- **Fix in VS Code** — Each comment includes a `vscode://` deep-link that opens the Claude Code extension pre-filled with the bug description, file, line, repo, and branch so the fix can be applied with one Enter press
- **Fix in Web** — Each comment includes a `https://claude.ai/new` link that opens a new Claude conversation pre-loaded with the full fix prompt including repo and branch context
- Fix links are also appended to orphan bugs in the summary comment (bugs that could not be mapped to diff lines)
- **Auto-resolve fixed threads** — When a new commit is pushed, BugBot queries all open BugBot review threads via the GitHub GraphQL API (`resolveReviewThread` mutation) and automatically marks resolved any thread whose bug is no longer detected
- **Duplicate suppression** — Bugs that still have an open thread from a previous run are skipped when posting the new review, so the same issue is never commented twice

### Changed

- `getPRInfo()` now also extracts `pr.head.ref` (branch name) passed through to all comment formatters
- Each inline comment embeds a hidden `<!-- bugbot-id:file:title-slug -->` marker used to match threads across commits
- `postReview()` accepts `branch` and `alreadyCommentedBugIds` as new parameters

---

## [1.0.0-beta.0] - 2026-02-24

### Initial Release

First public release of Claude BugBot — a GitHub Action that uses Claude Code CLI to automatically find bugs in pull requests and post inline review comments.

### Features

- **Automated bug detection** — Analyzes PR diffs for bugs, logic errors, security vulnerabilities, race conditions, null/undefined dereferences, off-by-one errors, and resource leaks
- **Inline PR review comments** — Posts findings directly on the affected lines in the GitHub PR review interface, with severity-coded emoji (🔴 critical, 🟠 high, 🟡 medium, 🔵 low)
- **Structured JSON output** — Claude returns machine-parseable findings with file path, line number, severity, title, and description for each bug
- **Dual auth support** — Works with Claude Max/Pro subscription OAuth tokens (`claude setup-token`) or a standard Anthropic API key
- **Diff-aware line validation** — Parses unified diff hunk headers to verify that reported line numbers actually exist in the PR diff before posting comments; unmappable findings fall back to a summary section
- **Large diff handling** — Gracefully truncates diffs exceeding 200KB to keep latency and cost reasonable
- **Fallback comment mode** — If the GitHub review API rejects inline comments, automatically retries as a plain PR issue comment
- **Configurable model and budget** — Supports `sonnet`, `opus`, and `haiku` models; configurable max spend per run (default $1.00 USD)
- **Bot PR skipping** — Example workflow excludes Dependabot PRs by default via `if: github.actor != 'dependabot[bot]'`
- **Composite action** — Runs as a composite GitHub Action (no Docker required); installs Claude Code CLI via npm on the runner

### Inputs

| Input | Default | Description |
|---|---|---|
| `claude-setup-token` | — | OAuth token from `claude setup-token` |
| `anthropic-api-key` | — | Anthropic API key (alternative auth) |
| `model` | `sonnet` | Claude model to use |
| `github-token` | `github.token` | GitHub token for posting reviews |
| `max-budget` | `1.00` | Max spend per run in USD |

### How It Works

1. Reads PR metadata from the GitHub Actions event payload
2. Fetches the PR diff via `gh pr diff`
3. Parses the diff to build a map of valid commentable lines per file
4. Sends the diff to Claude Code CLI with a focused bug-review prompt
5. Parses the structured JSON response from Claude
6. Posts a PR review with inline comments on valid diff lines and a severity summary
