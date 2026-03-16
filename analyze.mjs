#!/usr/bin/env node

import { execSync, spawnSync } from 'child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// --- Config ---
const MODEL = process.env.MODEL || 'sonnet';

// --- Paths excluded from bug analysis ---
// Files whose paths start with any of these prefixes are stripped from the diff
// before BugBot sees it. Add more entries here as new cases are discovered.
const EXCLUDED_PATH_PREFIXES = [
  '.github/', // GitHub Actions workflows and configs — not application code
];

// --- Read PR info from GitHub event ---
function getPRInfo() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error('GITHUB_EVENT_PATH not set. This script must run inside a GitHub Action.');
  }
  const event = JSON.parse(readFileSync(eventPath, 'utf-8'));
  const pr = event.pull_request;
  if (!pr) {
    throw new Error('No pull_request in event payload. Ensure this runs on pull_request events.');
  }
  return {
    number: pr.number,
    headSha: pr.head.sha,
    branch: pr.head.ref,
    repo: process.env.GITHUB_REPOSITORY, // owner/repo
  };
}

// --- Fetch PR diff ---
function fetchDiff(prNumber) {
  try {
    const diff = execSync(`gh pr diff ${prNumber}`, {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer
    });
    return diff;
  } catch (err) {
    // GitHub returns 406 when PR has >300 files — fall back to paginated files API
    if (err.message.includes('too_large') || err.message.includes('406')) {
      console.warn('⚠️  PR diff too large (>300 files), falling back to paginated files API...');
      return fetchDiffViaFilesAPI(prNumber);
    }
    throw new Error(`Failed to fetch PR diff: ${err.message}`);
  }
}

// --- Fallback: reconstruct unified diff from the paginated PR files API ---
// Used when the PR has >300 changed files (GitHub's limit for the diff endpoint).
function fetchDiffViaFilesAPI(prNumber) {
  const repo = process.env.GITHUB_REPOSITORY;
  const raw = execSync(
    `gh api repos/${repo}/pulls/${prNumber}/files --paginate`,
    { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }
  );

  // gh --paginate concatenates JSON arrays, so we need to merge them
  const files = JSON.parse(raw.trim().replace(/\]\s*\[/g, ','));

  let allPatches = '';
  for (const file of files) {
    if (!file.patch) continue; // binary file or individual file too large for GitHub to diff
    if (EXCLUDED_PATH_PREFIXES.some(prefix => file.filename.startsWith(prefix))) continue;
    allPatches += `diff --git a/${file.filename} b/${file.filename}\n`;
    allPatches += `--- a/${file.filename}\n`;
    allPatches += `+++ b/${file.filename}\n`;
    allPatches += file.patch + '\n';
  }
  return allPatches;
}

// --- Strip excluded paths from a unified diff string ---
// Splits on "diff --git" section boundaries and drops any section whose file
// path starts with one of the EXCLUDED_PATH_PREFIXES entries.
function filterDiff(diff) {
  if (EXCLUDED_PATH_PREFIXES.length === 0) return diff;
  const sections = diff.split(/(?=^diff --git )/m);
  return sections
    .filter(section => {
      const match = section.match(/^diff --git a\/(.+) b\//);
      if (!match) return true; // keep preamble / unparseable sections
      return !EXCLUDED_PATH_PREFIXES.some(prefix => match[1].startsWith(prefix));
    })
    .join('');
}

// --- Parse diff to extract valid commentable lines per file ---
// Returns: Map<string, Set<number>> mapping file paths to valid RIGHT-side line numbers
function parseDiff(diff) {
  const validLines = new Map();
  let currentFile = null;
  let newLineNum = 0;

  for (const line of diff.split('\n')) {
    // Detect file header: +++ b/path/to/file
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6); // Remove "+++ b/"
      if (!validLines.has(currentFile)) {
        validLines.set(currentFile, new Set());
      }
      continue;
    }

    // Detect hunk header: @@ -a,b +c,d @@
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      newLineNum = parseInt(hunkMatch[1], 10);
      continue;
    }

    if (!currentFile) continue;

    // Context line (space prefix) - valid on RIGHT side
    if (line.startsWith(' ')) {
      validLines.get(currentFile).add(newLineNum);
      newLineNum++;
      continue;
    }

    // Added line (+ prefix) - valid on RIGHT side
    if (line.startsWith('+')) {
      validLines.get(currentFile).add(newLineNum);
      newLineNum++;
      continue;
    }

    // Deleted line (- prefix) - only on LEFT side, don't increment new line counter
    if (line.startsWith('-')) {
      continue;
    }
  }

  return validLines;
}

// --- Build the analysis prompt ---
function buildPrompt(diffPath, openThreads = []) {
  const hasOpenThreads = openThreads.length > 0;

  let prompt = `You are a senior software engineer performing a focused bug review on a pull request diff.

TASK: Read the file at "${diffPath}" — it contains a PR diff. Identify ONLY genuine bugs, logic errors, security vulnerabilities, race conditions, null/undefined dereferences, off-by-one errors, resource leaks, and other concrete defects in the ADDED or MODIFIED lines (lines starting with +).

DO NOT report:
- Style issues, naming conventions, or formatting
- Missing documentation or comments
- Performance suggestions unless they cause correctness issues
- Test coverage gaps
- Suggestions or improvements that aren't bugs

For each bug found, determine the EXACT line number in the NEW version of the file. The line numbers can be calculated from the @@ hunk headers in the diff. For example, "@@ -10,6 +15,8 @@" means the new file starts at line 15 for that hunk.

If the same bug pattern or a directly related issue also appears in OTHER files within the diff, list those in additional_locations.`;

  if (hasOpenThreads) {
    prompt += `

PREVIOUSLY REPORTED OPEN BUGS: The following bugs were reported by BugBot on an earlier commit of this PR and their review threads are still open. For each one, determine whether it has been fixed.

${JSON.stringify(openThreads, null, 2)}

Resolution rules:
Always use the "bugId" field (format: "file:line") to identify the real bug location — NOT the GitHub thread anchor, which may differ when the bug's file was not in the diff at the time of reporting.

1. If the bug's file (from bugId) appears in the diff and the bug is clearly still present → omit its threadId from resolved_thread_ids.
2. If the bug's file (from bugId) appears in the diff and the bug has been fixed → include its threadId in resolved_thread_ids.
3. If the bug's file (from bugId) does NOT appear in the diff, use broader judgment: if the PR addresses the root cause elsewhere (e.g. a shared function, a caller, a config) or if no related code path looks broken, include its threadId in resolved_thread_ids.

IMPORTANT: resolved_thread_ids must contain the "threadId" field value (the GitHub GraphQL node ID, e.g. "PRRT_kwDO...") — NOT the "bugId" field value.

Do NOT re-report still-open bugs as new entries in the bugs array — they already have open threads.`;
  }

  prompt += `

Respond with ONLY a JSON object (no markdown fences, no extra text) in this exact format:
{
  "bugs": [
    {
      "file": "path/to/file.js",
      "line": 42,
      "severity": "critical|high|medium|low",
      "title": "Short bug title",
      "description": "Clear explanation of the bug and suggested fix",
      "additional_locations": [
        {"file": "path/to/other/file.js", "line": 15, "note": "Related instance of the same issue"}
      ]
    }
  ],
  "summary": "Brief 1-2 sentence overall summary"${hasOpenThreads ? `,
  "resolved_thread_ids": ["<threadId of each thread now fixed>"]` : ''}
}

Omit additional_locations or set it to [] if there are no related locations.
If no bugs are found, return: {"bugs": [], "summary": "No bugs found in the changes."${hasOpenThreads ? `, "resolved_thread_ids": ["<threadId of each thread now fixed — [] only if none are fixed>"]` : ''}}${hasOpenThreads ? `

Note: when there are previously-reported open threads, resolved_thread_ids must ALWAYS be present and list every thread whose bug is now fixed. Do not default to an empty list just because no new bugs were found — evaluate each open thread independently.` : ''}`;

  return prompt;
}

// --- Mask a secret for safe logging (show first 12 + last 4 chars) ---
function maskSecret(value) {
  if (!value || value.length < 20) return '[too short to mask]';
  return value.slice(0, 12) + '...' + value.slice(-4);
}

// --- Check authentication and verify claude CLI starts ---
function checkAuth() {
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (oauthToken) {
    console.log(`🔑 Auth method : Claude OAuth token (setup-token)`);
    console.log(`   Token       : ${maskSecret(oauthToken)}`);
  } else if (apiKey) {
    console.log(`🔑 Auth method : Anthropic API key`);
    console.log(`   Key         : ${maskSecret(apiKey)}`);
  } else {
    throw new Error(
      'No auth credentials found. Set CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) ' +
      'or ANTHROPIC_API_KEY in your workflow secrets.'
    );
  }

  // Verify the claude CLI binary starts and log its version
  const ver = spawnSync('claude', ['--version'], {
    encoding: 'utf-8',
    timeout: 15_000,
    env: { ...process.env, CI: 'true', NO_COLOR: '1' },
  });

  if (ver.error) {
    throw new Error(`claude CLI failed to start: ${ver.error.message}`);
  }
  const versionLine = (ver.stdout || ver.stderr || '').trim().split('\n')[0];
  console.log(`   CLI version : ${versionLine || '(no version output)'}`);

  // Make a lightweight API call to confirm the token/key is valid and the API is reachable.
  // Uses haiku (fastest model) with a trivial prompt — fails fast if auth is broken.
  console.log('🔒 Verifying API connectivity...');
  const ping = spawnSync('claude', [
    '-p', 'Reply with the single word: ok',
    '--output-format', 'text',
    '--max-turns', '1',
    '--dangerously-skip-permissions',
    '--model', MODEL,
  ], {
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, CI: 'true', NO_COLOR: '1', TERM: 'dumb', CLAUDE_NO_TELEMETRY: '1' },
  });

  if (ping.stderr) {
    console.log('Auth check stderr:\n' + ping.stderr);
  }

  if (ping.error) {
    throw new Error(`Auth check timed out or failed to start: ${ping.error.message}`);
  }

  if (ping.status !== 0) {
    throw new Error(
      `Auth check failed (exit ${ping.status}) — token may be expired or invalid.\n` +
      (ping.stderr || ping.stdout || '(no output)').trim()
    );
  }

  console.log(`   API response : ${(ping.stdout || '').trim() || '(empty)'}`);
  console.log('✅ Auth verified');
}

// --- Run Claude Code CLI ---
// Writes the diff to a temp file and passes the file path in the prompt so
// claude reads it using its native file tool. This avoids all stdin/argument
// size issues that caused 5-minute hangs in previous approaches.
const ANALYSIS_TIMEOUT_MS = 30 * 60_000; // 30-minute hard timeout per attempt
const MAX_ATTEMPTS = 3;

async function runClaude(diff, openThreads = []) {
  // Write diff to a temp file — claude will read it via its file tool
  const tmpDir = mkdtempSync(join(tmpdir(), 'bugbot-diff-'));
  const diffPath = join(tmpDir, 'pr.diff');
  writeFileSync(diffPath, diff, 'utf-8');
  console.log(`   Diff written to ${diffPath} (${(Buffer.byteLength(diff) / 1024).toFixed(1)}KB)`);

  const prompt = buildPrompt(diffPath, openThreads);
  const args = [
    '-p', prompt,
    '--output-format', 'text',   // text (not json) — avoids outer-wrapper hang
    '--dangerously-skip-permissions',
    '--model', MODEL,
    // no --max-budget-usd — unnecessary and a potential hang trigger
  ];
  const env = {
    ...process.env,
    CI: 'true',
    NO_COLOR: '1',
    TERM: 'dumb',
    CLAUDE_NO_TELEMETRY: '1',
  };

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        console.log(`🔄 Retry ${attempt}/${MAX_ATTEMPTS} — waiting 5s before restart...`);
        await new Promise((r) => setTimeout(r, 5_000));
      }

      console.log(`   Attempt ${attempt}/${MAX_ATTEMPTS} (timeout: ${ANALYSIS_TIMEOUT_MS / 1000}s)...`);

      const result = spawnSync('claude', args, {
        encoding: 'utf-8',
        maxBuffer: 50 * 1024 * 1024,
        timeout: ANALYSIS_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        env,
      });

      if (result.stderr) {
        console.log(result.stderr);
      }

      if (result.error) {
        if (result.error.code === 'ETIMEDOUT') {
          console.warn(`⚠️  Process timed out after ${ANALYSIS_TIMEOUT_MS / 1000}s.`);
          if (attempt < MAX_ATTEMPTS) continue;
          throw new Error(`Claude Code CLI timed out on all ${MAX_ATTEMPTS} attempts.`);
        }
        throw new Error(`Claude Code CLI failed to start: ${result.error.message}`);
      }

      if (result.status !== 0) {
        throw new Error(
          `Claude Code CLI exited with status ${result.status}` +
          (result.stderr ? ': ' + result.stderr.trim() : '')
        );
      }

      // Try to parse the response — retry if Claude returned non-JSON output
      try {
        return parseResponse(result.stdout);
      } catch (parseErr) {
        console.warn(`⚠️  ${parseErr.message}`);
        if (attempt < MAX_ATTEMPTS) {
          console.warn(`   Claude returned non-JSON output. Retrying...`);
          continue;
        }
        throw parseErr;
      }
    }
  } finally {
    // Clean up temp dir regardless of success or failure
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// --- Parse Claude's response ---
// With --output-format text, stdout is the raw text response (no outer wrapper).
function parseResponse(stdout) {
  const text = stdout.trim();

  // Try direct JSON parse
  try {
    return JSON.parse(text);
  } catch {
    // Fallback: extract JSON from code fences
    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) {
      try {
        return JSON.parse(fenceMatch[1]);
      } catch {
        // Fall through
      }
    }

    // Fallback: find first { ... } block
    const braceMatch = text.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      try {
        return JSON.parse(braceMatch[0]);
      } catch {
        // Fall through
      }
    }

    throw new Error(`Could not extract JSON from Claude's response: ${text.slice(0, 500)}`);
  }
}

// --- Format review body ---
function formatSummary(analysis) {
  const { bugs, summary } = analysis;
  const bugCount = bugs.length;

  if (bugCount === 0) {
    return `## 🟢 Claude BugBot Analysis\n\n${summary}\n\nNo bugs were detected in this PR.`;
  }

  const severityCounts = {};
  for (const bug of bugs) {
    severityCounts[bug.severity] = (severityCounts[bug.severity] || 0) + 1;
  }

  const severityLine = Object.entries(severityCounts)
    .map(([sev, count]) => `**${sev}**: ${count}`)
    .join(' | ');

  return [
    `## 🔴 Claude BugBot Analysis`,
    '',
    `Found **${bugCount}** potential bug${bugCount !== 1 ? 's' : ''} in this PR.`,
    '',
    severityLine,
    '',
    summary,
  ].join('\n');
}

// --- Stable identifier for a bug (file + line, avoids depending on Claude's title wording) ---
function makeBugId(bug) {
  return `${bug.file}:${bug.line}`;
}

function formatInlineComment(bug, repo, headSha, { isOrphan = false, fileMissing = false } = {}) {
  const severityEmoji = {
    critical: '🔴',
    high: '🟠',
    medium: '🟡',
    low: '🔵',
  };
  const emoji = severityEmoji[bug.severity] || '⚪';

  let comment = `${emoji} **${bug.severity.toUpperCase()}**: ${bug.title}\n\n${bug.description}`;

  if (fileMissing) {
    const fileUrl = `https://github.com/${repo}/blob/${headSha}/${bug.file}#L${bug.line}`;
    comment += `\n\n> ⚠️ *This file is not part of this PR's diff. The bug is at [\`${bug.file}:${bug.line}\`](${fileUrl}).*`;
  } else if (isOrphan) {
    const fileUrl = `https://github.com/${repo}/blob/${headSha}/${bug.file}#L${bug.line}`;
    comment += `\n\n> ⚠️ *Could not locate exact line in the diff. The bug is at [\`${bug.file}:${bug.line}\`](${fileUrl}).*`;
  }

  // Additional locations
  if (bug.additional_locations && bug.additional_locations.length > 0) {
    comment += '\n\n**Additional Locations**\n';
    for (const loc of bug.additional_locations) {
      const fileUrl = `https://github.com/${repo}/blob/${headSha}/${loc.file}#L${loc.line}`;
      const note = loc.note ? ` — ${loc.note}` : '';
      comment += `\n- [\`${loc.file}:${loc.line}\`](${fileUrl})${note}`;
    }
  }

  // Hidden machine-readable ID used to auto-resolve this thread when the bug is fixed
  comment += `\n<!-- bugbot-id:${makeBugId(bug)} -->`;

  return comment;
}

// --- Post PR review ---
function postReview(repo, prNumber, headSha, analysis, validLines, alreadyCommentedBugIds) {
  const { bugs } = analysis;

  // All bugs are posted as inline comments — no review body fallback.
  // Skipping any that already have an open thread (to avoid duplicates).
  const inlineComments = [];

  // First file in the diff (with at least one valid line) is the last-resort anchor
  // when a bug's file isn't in the diff at all. We skip files with empty Sets because
  // Math.min() on an empty spread returns Infinity which the GitHub API rejects.
  let firstDiffFile = null;
  let firstDiffFileAnchorLine = null;
  for (const [file, lines] of validLines) {
    if (lines.size > 0) {
      firstDiffFile = file;
      firstDiffFileAnchorLine = Math.min(...lines);
      break;
    }
  }

  for (const bug of bugs) {
    if (alreadyCommentedBugIds.has(makeBugId(bug))) continue;
    const fileLines = validLines.get(bug.file);
    if (fileLines && fileLines.has(bug.line)) {
      // Exact line is in the diff — normal inline comment
      inlineComments.push({
        path: bug.file,
        line: bug.line,
        side: 'RIGHT',
        body: formatInlineComment(bug, repo, headSha),
      });
    } else if (fileLines && fileLines.size > 0) {
      // File is in the diff but the exact line isn't — anchor to first valid line in the file
      const anchorLine = Math.min(...fileLines);
      inlineComments.push({
        path: bug.file,
        line: anchorLine,
        side: 'RIGHT',
        body: formatInlineComment(bug, repo, headSha, { isOrphan: true }),
      });
    } else if (firstDiffFile && firstDiffFileAnchorLine !== null) {
      // Bug's file is not in the diff at all — anchor to first line of first file in the diff
      inlineComments.push({
        path: firstDiffFile,
        line: firstDiffFileAnchorLine,
        side: 'RIGHT',
        body: formatInlineComment(bug, repo, headSha, { fileMissing: true }),
      });
    }
    // If the diff is somehow empty, silently skip (shouldn't happen — checked earlier)
  }

  // Build summary body (bug details are always in inline comments, never in the body)
  const body = formatSummary(analysis);

  // Build review payload
  const review = {
    commit_id: headSha,
    body,
    event: 'COMMENT',
  };

  if (inlineComments.length > 0) {
    review.comments = inlineComments;
  }

  // Write payload to temp file (avoids shell escaping issues)
  const tmpDir = mkdtempSync(join(tmpdir(), 'bugbot-'));
  const payloadPath = join(tmpDir, 'review.json');
  writeFileSync(payloadPath, JSON.stringify(review));

  const [owner, repoName] = repo.split('/');

  try {
    execSync(
      `gh api --method POST -H "Accept: application/vnd.github+json" /repos/${owner}/${repoName}/pulls/${prNumber}/reviews --input "${payloadPath}"`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    );
    console.log(`✅ Posted review with ${inlineComments.length} inline comment(s)`);
  } catch (err) {
    console.warn(`⚠️ Failed to post review with inline comments: ${err.message}`);
    console.log('Falling back to simple PR comment...');
    postFallbackComment(repo, prNumber, body);
  }
}

// --- Fallback: post a simple PR comment ---
function postFallbackComment(repo, prNumber, body) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'bugbot-'));
  const payloadPath = join(tmpDir, 'comment.json');
  writeFileSync(payloadPath, JSON.stringify({ body }));

  const [owner, repoName] = repo.split('/');

  try {
    execSync(
      `gh api --method POST -H "Accept: application/vnd.github+json" /repos/${owner}/${repoName}/issues/${prNumber}/comments --input "${payloadPath}"`,
      { encoding: 'utf-8' }
    );
    console.log('✅ Posted fallback comment');
  } catch (err) {
    console.error(`❌ Failed to post fallback comment: ${err.message}`);
    process.exit(1);
  }
}

// --- Fetch open BugBot review threads from previous runs ---
// Returns an array of { threadId, bugId, description } for each open BugBot thread.
// threadId is the stable GitHub node ID used to resolve the thread via GraphQL.
// bugId is the file:line tag embedded in the comment (used for deduplication).
function fetchOpenBugThreads(repo, prNumber) {
  const [owner, repoName] = repo.split('/');
  const tmpDir = mkdtempSync(join(tmpdir(), 'bugbot-threads-'));

  const paginatedQuery = `query($owner: String!, $repo: String!, $pr: Int!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $pr) {
          reviewThreads(first: 100, after: $cursor) {
            nodes {
              id
              isResolved
              comments(first: 1) {
                nodes { body }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    }`;

  let rawThreads = [];
  let cursor = null;
  let page = 0;
  try {
    do {
      const queryPayload = {
        query: paginatedQuery,
        variables: { owner, repo: repoName, pr: prNumber, cursor },
      };
      const queryPath = join(tmpDir, `query-${page}.json`);
      writeFileSync(queryPath, JSON.stringify(queryPayload));
      const raw = execSync(`gh api graphql --input "${queryPath}"`, { encoding: 'utf-8' });
      const reviewThreads = JSON.parse(raw)?.data?.repository?.pullRequest?.reviewThreads;
      rawThreads = rawThreads.concat(reviewThreads?.nodes ?? []);
      cursor = reviewThreads?.pageInfo?.hasNextPage ? reviewThreads.pageInfo.endCursor : null;
      page++;
    } while (cursor);
  } catch (err) {
    console.warn(`⚠️ Could not fetch review threads: ${err.message}`);
    return [];
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  const openThreads = [];
  for (const thread of rawThreads) {
    if (thread.isResolved) continue;
    const body = thread.comments?.nodes?.[0]?.body ?? '';
    const idMatch = body.match(/<!-- bugbot-id:([^\s>]+) -->/);
    if (!idMatch) continue; // not a BugBot comment
    openThreads.push({
      threadId: thread.id,
      bugId: idMatch[1],
      // Strip the hidden tag and pass the human-readable comment body to Claude
      description: body.replace(/\n<!-- bugbot-id:[^\s>]+ -->/, '').trim(),
    });
  }

  return openThreads;
}

// --- Resolve a list of GitHub review threads by their node IDs ---
function resolveThreads(threadIds) {
  if (threadIds.length === 0) return;
  const tmpDir = mkdtempSync(join(tmpdir(), 'bugbot-resolve-'));
  try {
    for (let i = 0; i < threadIds.length; i++) {
      const mutationPayload = {
        query: `mutation($threadId: ID!) {
          resolveReviewThread(input: { threadId: $threadId }) {
            thread { isResolved }
          }
        }`,
        variables: { threadId: threadIds[i] },
      };
      const mutationPath = join(tmpDir, `resolve-${i}.json`);
      writeFileSync(mutationPath, JSON.stringify(mutationPayload));
      try {
        execSync(`gh api graphql --input "${mutationPath}"`, { encoding: 'utf-8' });
        console.log(`  ✅ Auto-resolved thread: ${threadIds[i]}`);
      } catch (err) {
        console.warn(`  ⚠️ Could not resolve thread ${threadIds[i]}: ${err.message}`);
      }
    }
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// --- Main ---
async function main() {
  console.log('🤖 Claude BugBot - Starting analysis...');

  // 0. Verify auth
  checkAuth();

  // 1. Get PR info
  const pr = getPRInfo();
  console.log(`📋 PR #${pr.number} in ${pr.repo} @ ${pr.branch} (head: ${pr.headSha.slice(0, 7)})`);

  // 2. Fetch diff
  console.log('📥 Fetching PR diff...');
  let diff = filterDiff(fetchDiff(pr.number));

  if (!diff.trim()) {
    console.log('ℹ️ Empty diff, nothing to analyze.');
    return;
  }

  // 3. Parse diff for valid lines
  console.log('🔍 Parsing diff...');
  const validLines = parseDiff(diff);
  const fileCount = validLines.size;
  console.log(`   Found changes in ${fileCount} file(s)`);

  // 5. Fetch open BugBot threads from previous runs (before Claude, to include in prompt)
  console.log('🔍 Fetching open BugBot threads...');
  const openThreads = fetchOpenBugThreads(pr.repo, pr.number);
  console.log(`   Found ${openThreads.length} open thread(s) from previous runs`);

  // 6. Run Claude analysis (open threads included so it can determine what's fixed)
  console.log(`🧠 Running Claude (${MODEL}) analysis...`);
  console.log('📊 Parsing results...');
  const analysis = await runClaude(diff, openThreads);

  if (!analysis.bugs || !Array.isArray(analysis.bugs)) {
    throw new Error('Invalid response format: missing bugs array');
  }

  console.log(`   Found ${analysis.bugs.length} potential bug(s)`);

  // 8. Resolve threads Claude says are fixed
  const resolvedIds = Array.isArray(analysis.resolved_thread_ids) ? analysis.resolved_thread_ids : [];
  if (resolvedIds.length > 0) {
    console.log(`🔄 Resolving ${resolvedIds.length} fixed thread(s)...`);
    resolveThreads(resolvedIds);
  }

  // 9. Build deduplication set: still-open threads whose bug shouldn't get a new comment
  const resolvedSet = new Set(resolvedIds);
  const alreadyCommentedBugIds = new Set(
    openThreads.filter(t => !resolvedSet.has(t.threadId)).map(t => t.bugId)
  );

  // 10. Post review for new bugs
  console.log('💬 Posting PR review...');
  postReview(pr.repo, pr.number, pr.headSha, analysis, validLines, alreadyCommentedBugIds);

  console.log('🤖 Claude BugBot - Done!');
}

main().catch((err) => {
  console.log(`❌ BugBot failed: ${err.message}`);
  // Exit 0 so a BugBot analysis failure doesn't block the PR / fail the CI job.
  process.exit(0);
});
