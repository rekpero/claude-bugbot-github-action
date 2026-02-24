# Changelog

All notable changes to Claude BugBot GitHub Action will be documented in this file.

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
