# Claude BugBot GitHub Action

**The free Cursor BugBot alternative** — get the same automated PR bug analysis without paying for a Cursor subscription. If you already have a Claude Pro or Max plan, you can generate a setup token in seconds and use it directly. No API costs, no extra subscriptions.

A GitHub Action that uses Claude Code CLI to automatically find bugs in your pull requests and post inline review comments on the exact lines where issues are detected. It runs directly on top of Claude Code, so analysis is fast and leverages the full power of the model without any middleware overhead.

## Why use this instead of Cursor BugBot?

| | Claude BugBot | Cursor BugBot |
|---|---|---|
| **Cost** | Free with Claude Pro/Max plan | Requires Cursor subscription |
| **Setup** | One `claude setup-token` command | Tied to Cursor IDE |
| **Speed** | Directly calls Claude Code — no middleware | Runs through Cursor's infrastructure |
| **IDE dependency** | None — works in any repo | Requires Cursor |
| **Model** | Claude Sonnet/Opus/Haiku (your choice) | Claude via Cursor |

If you're already paying for Claude Pro or Max, you're leaving money on the table by also paying for Cursor just for BugBot. Run `claude setup-token`, add the secret to your repo, and you're done.

## Features

- Analyzes PR diffs for bugs, logic errors, security vulnerabilities, race conditions, null dereferences, off-by-one errors, and resource leaks
- Posts inline review comments directly on the affected lines
- Free to use with any Claude Pro or Max subscription — just generate a setup token
- Focuses only on real bugs — ignores style, formatting, and documentation issues
- Handles large diffs gracefully (truncates at 200KB)
- Falls back to a summary comment if inline comments can't be mapped to diff lines

## Quick Start

### 1. Generate your Claude setup token

```bash
claude setup-token
```

Copy the output token (`sk-ant-oat01-...`).

### 2. Add secrets to your repo

Go to your repo's **Settings > Secrets and variables > Actions > New repository secret** and create:

- Name: `CLAUDE_SETUP_TOKEN` — the token from step 1

**Optional — for auto-resolving fixed threads:** If you see `Resource not accessible by integration` errors on thread resolution, create a [Personal Access Token (classic)](https://github.com/settings/tokens) with `repo` scope and add it as:

- Name: `GH_PAT` — your PAT with `repo` scope

### 3. Add the workflow

Create `.github/workflows/bugbot.yml` in your repo:

```yaml
name: Claude BugBot

on:
  pull_request:
    types: [opened, synchronize]

permissions:
  contents: read
  pull-requests: write

jobs:
  bugbot:
    runs-on: ubuntu-latest
    if: github.actor != 'dependabot[bot]'
    steps:
      - uses: actions/checkout@v4
      - uses: rekpero/claude-bugbot-github-action@main
        with:
          claude-setup-token: ${{ secrets.CLAUDE_SETUP_TOKEN }}
```

That's it. Open a PR and BugBot will analyze the changes automatically.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `claude-setup-token` | No* | — | OAuth token from `claude setup-token` (for Max/Pro subscribers) |
| `anthropic-api-key` | No* | — | Anthropic API key (billed per token) |
| `model` | No | `sonnet` | Claude model (`sonnet`, `opus`, `haiku`) |
| `github-token` | No | `${{ github.token }}` | GitHub token for posting reviews and resolving fixed threads. Requires `pull-requests: write`. |
| `max-budget` | No | `1.00` | Max spend per run in USD |

\* One of `claude-setup-token` or `anthropic-api-key` must be provided.

> **Required workflow permission:** The token needs `pull-requests: write` for both posting comments and auto-resolving threads when a bug is fixed. Also verify: **Settings → Actions → General → Workflow permissions → "Read and write permissions"** — if this is set to read-only it overrides workflow-level declarations.

## How It Works

1. Fetches the PR diff
2. Parses the diff to identify which lines are commentable
3. Sends the diff to Claude Code CLI for bug analysis
4. Claude returns structured findings with file paths, line numbers, and descriptions
5. Validates line numbers against the actual diff (to avoid invalid review comments)
6. Posts a PR review with inline comments on buggy lines and a summary

## Example Output

When bugs are found, you'll see inline comments like:

> **HIGH**: Potential null dereference
>
> `user.profile.name` will throw if `user.profile` is null. Add a null check before accessing nested properties.

And a summary review comment:

> **Claude BugBot Analysis**
>
> Found **2** potential bugs in this PR.
> **high**: 1 | **medium**: 1

## Auth: Setup Token vs API Key

| | Setup Token | API Key |
|---|---|---|
| **Cost** | Included in Max/Pro subscription | Billed per token |
| **Setup** | `claude setup-token` | Get key from console.anthropic.com |
| **Secret name** | `CLAUDE_SETUP_TOKEN` | `ANTHROPIC_API_KEY` |
| **Expiration** | Expires periodically, regenerate with `claude setup-token` | Does not expire |

## Notes

- The setup token expires periodically. If the action starts failing with auth errors, regenerate it with `claude setup-token`.
- Diffs larger than 200KB are truncated to keep analysis costs and latency reasonable.
- The action only comments on bugs in added/modified lines — it won't flag issues in unchanged code.
- Bot PRs (e.g. Dependabot) are skipped by default in the example workflow. Remove the `if` condition to include them.

## Disclaimer

Built for personal use and experimentation by [rekpero](https://github.com/rekpero). Use it at your own risk.

## Contributing

Want to help make it better? Open a PR — the same Claude BugBot will review it for you.
