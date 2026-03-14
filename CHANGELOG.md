# Changelog

All notable changes to Claude BugBot GitHub Action will be documented in this file.

## [1.0.7] - 2026-03-15

### Fixed

- **Review threads beyond the first 100 are no longer silently missed** — `fetchOpenBugThreads` previously fetched review threads with `first: 100` and no pagination, so PRs with more than 100 threads would silently drop any threads past the first page. This caused BugBot to re-post comments it had already posted (failing deduplication) and miss threads it should have resolved. The query now uses cursor-based pagination (`after: $cursor` + `pageInfo { hasNextPage endCursor }`) and loops until all pages are fetched, accumulating threads across pages before filtering for open BugBot comments.

---

## [1.0.6] - 2026-03-05

### Fixed

- **PRs with more than 300 changed files no longer crash BugBot** — `gh pr diff` calls the GitHub diff endpoint which returns HTTP 406 (`too_large`) when a PR touches more than 300 files. Previously this caused an unhandled error and BugBot would exit without analysis. Now `fetchDiff` catches the 406/`too_large` error and automatically falls back to `fetchDiffViaFilesAPI`, which uses the paginated `GET /repos/{owner}/{repo}/pulls/{number}/files` API (supporting up to 3 000 files). Each file's `patch` field is reassembled into standard unified diff format so all downstream parsing (`parseDiff`, inline comment placement, etc.) continues to work without modification. Binary files and individual files whose patch GitHub cannot produce are silently skipped, consistent with the existing diff-truncation behaviour.

---

## [1.0.5] - 2026-03-02

### Changed

- **Analysis timeout raised from 10 minutes to 30 minutes** — `ANALYSIS_TIMEOUT_MS` increased from `10 * 60_000` to `30 * 60_000`. Large or complex diffs can legitimately require more than 10 minutes for Claude to fully analyze; the previous limit caused premature SIGKILL and retry cycles on heavier PRs.

---

## [1.0.4] - 2026-02-28

### Fixed

- **JSON parse failures now trigger retries instead of immediate CI failure** — Claude Code CLI occasionally responds with natural-language preamble (e.g. `"After reading through the full diff, here is my analysis:"`) instead of the requested bare JSON, causing `parseResponse` to throw `"Could not extract JSON from Claude's response"`. Previously this error propagated straight to the top-level handler and failed the job. `parseResponse` is now called inside the `runClaude` retry loop: if parsing fails on an attempt, a warning is logged and the full Claude invocation is retried up to `MAX_ATTEMPTS` (3) times before giving up.

- **BugBot analysis failure no longer fails the CI job** — The top-level `main().catch()` handler previously called `process.exit(1)`, causing the GitHub Actions job to report `Process completed with exit code 1` and block the PR status check whenever BugBot encountered any unrecoverable error. Changed to `process.exit(0)` so a BugBot failure is visible in the logs but does not mark the job as failed or block merging.

---

## [1.0.3] - 2026-02-27

### Changed

- **Bugs with unmappable lines are now always posted as inline comments** — Previously, any bug whose exact line was not present in the diff was appended as plain text to the review body under "Additional findings". This made them invisible in the Files Changed tab and impossible for BugBot to auto-resolve later (no review thread was created). Now all bugs are always posted as inline comments:
  - If the bug's exact line is in the diff → normal inline comment at that line (unchanged).
  - If the bug's file is in the diff but the exact line is not → comment anchored to the **first valid line of that file**, with a note: *"Could not locate exact line in the diff. The bug is at `file:line`."*
  - If the bug's file is not in the diff at all → comment anchored to the **first valid line of the first file in the diff**, with a note: *"This file is not part of this PR's diff. The bug is at `file:line`."*
  - In all cases the hidden `<!-- bugbot-id:file:line -->` tag uses the **real** bug location, so deduplication and auto-resolution work correctly on subsequent commits.
  - The "Additional findings" section in the review body has been removed entirely.

- **Resolution prompt hardened for anchored threads** — The Claude prompt now explicitly states that `bugId` always reflects the real bug location regardless of where the review thread is anchored. This prevents Claude from evaluating resolution based on the anchor file instead of the actual file where the bug lives.

### Fixed

- **`Infinity` line number crash when first diff file is deletion-only** — The last-resort anchor (used when a bug's file is absent from the diff) was computed with `Math.min(...validLines.get(firstFile))`. If the first file in the diff had only deleted lines, its valid-lines Set was empty, causing `Math.min()` to return `Infinity`. The GitHub API rejected this with an error. Fixed by iterating `validLines` to find the first file that has at least one valid commentable line before computing the anchor.

---

## [1.0.2] - 2026-02-27

### Fixed

- **Open threads not resolved when PR has no new bugs** — When Claude reported no new bugs (`bugs: []`), the "no bugs found" example template in the prompt showed `"resolved_thread_ids": []`, causing Claude to copy it verbatim and return an empty list regardless of whether previously-reported bugs were actually fixed. The template now shows a semantic placeholder (`"<threadId of each thread now fixed>"`) and adds an explicit note that `resolved_thread_ids` must be evaluated independently of `bugs` — an empty `bugs` array is not a reason to leave `resolved_thread_ids` empty.

- **Threads not resolved when fixed file is absent from the diff** — The prompt instruction "if a thread's bug is untouched by the diff, omit it from `resolved_thread_ids`" caused Claude to conservatively skip resolution whenever the bug's file did not appear in the diff (e.g. a bug fixed indirectly via a shared function or caller). Resolution rules are now explicit: if the bug's file is in the diff and the bug is gone → resolve; if the file is in the diff and the bug remains → keep open; if the file is NOT in the diff, use broader judgment and resolve if the PR addresses the root cause elsewhere or nothing related looks broken.

- **Silent failure when Claude returned `bugId` instead of `threadId`** — The `resolved_thread_ids` field in the prompt schema used placeholder names (`"threadId1"`, `"threadId2"`) that did not distinguish between the `threadId` (GitHub GraphQL node ID, e.g. `PRRT_kwDO...`) and `bugId` (`file:line`) fields present in the open-threads JSON. Claude occasionally placed `bugId` values in `resolved_thread_ids`, causing the `resolveReviewThread` GraphQL mutation to fail silently (logged as `console.warn`). The prompt now explicitly states: `resolved_thread_ids must contain the "threadId" field value (the GitHub GraphQL node ID, e.g. "PRRT_kwDO...") — NOT the "bugId" field value.`

---

## [1.0.1] - 2026-02-27

### Changed

- **Removed `--max-turns` limit** — The `--max-turns 3` cap on Claude's analysis run has been removed. Complex diffs require multiple tool call rounds (file reads, multi-step reasoning); capping at 3 turns caused premature termination with `Reached max turns` errors and incomplete JSON output.

---

## [1.0.0] - 2026-02-26

First stable release of Claude BugBot. The beta cycle hardened auth, diff delivery, CI environment compatibility, and thread lifecycle management. This release represents the production-ready state of all those subsystems.

### Features

- **Automated bug detection** — Uses Claude Code CLI to analyze PR diffs for bugs, logic errors, security vulnerabilities, race conditions, null/undefined dereferences, off-by-one errors, and resource leaks. Only added/modified lines are analyzed — no noise from unchanged code.
- **Inline PR review comments** — Findings are posted directly on the affected diff lines in the GitHub review interface, with severity-coded emoji (🔴 critical, 🟠 high, 🟡 medium, 🔵 low). Bugs that cannot be mapped to their exact diff line are anchored to the nearest commentable line in the same file (or the first file in the diff), with a note pointing to the real location.
- **Semantic thread resolution** — On each new commit, open BugBot threads from previous runs are fetched and passed to Claude alongside the new diff. Claude semantically determines which bugs were fixed and returns their GitHub thread IDs in `resolved_thread_ids`. Resolved threads are auto-dismissed via the GraphQL `resolveReviewThread` mutation. This is robust to Claude rephrasing bug titles across runs.
- **Duplicate suppression** — Bugs that still have an open thread from a previous run are skipped when posting the new review, so the same issue is never commented twice.
- **Additional locations** — When a bug pattern appears in multiple files within the diff, all locations are listed in the inline comment with clickable GitHub links to the exact line.
- **Dual auth support** — Works with a Claude Max/Pro subscription OAuth token (`claude setup-token`) or a standard Anthropic API key. Auth is verified with a live API call before analysis begins; credentials are logged in masked form for easy debugging.
- **PAT support for thread resolution** — `github-token` accepts a Personal Access Token with `repo` scope as an alternative to the default `GITHUB_TOKEN`, for repos where the integration token lacks `pull-requests: write`.
- **Diff-aware line validation** — Unified diff hunk headers are parsed to build a map of valid commentable lines per file. Only lines that exist in the right-side diff are used for inline comments.
- **Large diff handling** — Diffs exceeding 200KB are truncated with a notice to keep latency and cost reasonable.
- **Temp-file diff delivery** — The diff is written to a temp file and the path is referenced in the prompt. Claude reads it via its native file tool, avoiding stdin and argument-size limitations that caused hangs in earlier approaches.
- **Retry logic** — Up to 3 spawn attempts with SIGKILL on timeout. A 5-second pause separates retries.
- **10-minute analysis timeout** — Hard per-attempt limit; generous enough for large diffs analyzed by Sonnet.
- **CI environment hardening** — Passes `CI=true`, `NO_COLOR=1`, `TERM=dumb`, and `CLAUDE_NO_TELEMETRY=1` to suppress interactive prompts, update checks, and color codes that can hang headless runners.
- **Fallback comment mode** — If the GitHub review API rejects inline comments, BugBot retries as a plain PR issue comment so findings are never silently lost.
- **Configurable model** — Supports `sonnet`, `opus`, and `haiku` via the `model` input. Defaults to `sonnet`.
- **Bot PR skipping** — Example workflow excludes Dependabot PRs by default.
- **Composite action** — Runs as a composite GitHub Action (no Docker required); installs Claude Code CLI via npm on the runner.

### Inputs

| Input | Default | Description |
|---|---|---|
| `claude-setup-token` | — | OAuth token from `claude setup-token` |
| `anthropic-api-key` | — | Anthropic API key (alternative auth) |
| `model` | `sonnet` | Claude model to use (`sonnet`, `opus`, `haiku`) |
| `github-token` | `github.token` | GitHub token for posting reviews and resolving threads |

### How It Works

1. Verifies auth with a live API call before doing anything else
2. Reads PR metadata from the GitHub Actions event payload
3. Fetches the PR diff via `gh pr diff`
4. Parses the diff to build a map of valid commentable lines per file
5. Fetches all open BugBot review threads from previous runs on this PR
6. Writes the diff to a temp file; runs Claude with the diff path and open threads in the prompt
7. Claude analyzes the diff for new bugs and determines which previously-reported bugs were fixed
8. Resolves threads Claude identified as fixed via GitHub GraphQL
9. Posts a PR review with inline comments on new bugs (skipping any that still have open threads)

---

## [1.0.0-beta.12] - 2026-02-25

### Fixed

- **Non-deterministic thread resolution** — The previous approach matched old bug threads against new analysis results using a slugified title (`file:slug-of-title`). Since Claude is non-deterministic, the same bug could be phrased differently on the next run, causing threads to be wrongly auto-resolved (false "fixed") or re-commented as duplicates. Fix: open threads are now passed to Claude in the prompt; Claude semantically determines which were fixed and returns their stable GitHub thread IDs in `resolved_thread_ids`. Resolution is no longer based on title wording.

### Changed

- `fetchOpenBugThreads(repo, prNumber)` — new function; fetches open BugBot review threads before running Claude and returns `[{ threadId, bugId, description }]`
- `resolveThreads(threadIds)` — new function; resolves a list of GitHub thread node IDs via GraphQL mutation; replaces `resolveFixedThreads`
- `buildPrompt(diffPath, openThreads)` — now accepts open threads; when present, embeds them in the prompt and instructs Claude to return `resolved_thread_ids` in its JSON response
- `runClaude(diff, openThreads)` — passes `openThreads` through to `buildPrompt`
- `makeBugId(bug)` — now uses `file:line` instead of `file:slugified-title`; structural and stable regardless of wording
- `main()` — updated order: fetch open threads → run Claude → resolve fixed threads → deduplicate → post

---

## [1.0.0-beta.11] - 2026-02-25

### Changed

- `ANALYSIS_TIMEOUT_MS` — increased from 5 minutes to 10 minutes to give Claude more headroom on large or complex diffs

---

## [1.0.0-beta.10] - 2026-02-25

### Fixed

- **Analysis timing out on all diff-passing approaches** — stdin (`spawnSync input:`), async `spawn` stdin, and embedding the full diff in `-p` all caused 5-minute hangs or zero output. Root cause: the claude CLI in non-interactive `-p` mode does not reliably consume large inputs via stdin or oversized argument strings. Fix: write the diff to a temp file and reference the path in the prompt — claude reads it via its native file tool, the same mechanism used by the auth ping that has never failed.

### Changed

- `buildPrompt(diffPath)` — accepts the temp file path; prompt instructs claude to read the file rather than consume stdin or a large argument
- `runClaude(diff)` — writes diff to `mkdtempSync` temp file before spawning; no `input:` (no stdin); temp dir cleaned up in `finally` block via `rmSync`
- `--output-format text` — switched from `json` to match the working auth ping; the `{ result, is_error }` outer wrapper is unnecessary since JSON is extracted from the response text directly
- `--max-turns 3` — increased from `1` to allow the file-read tool call turn plus the analysis turn
- `--max-budget-usd` removed — unnecessary and a potential hang trigger
- `parseResponse()` simplified — removed outer `{ result, is_error }` unwrap; parses raw text response directly

---

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
