#!/usr/bin/env node

import { execSync, spawnSync, spawn } from 'child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// --- Config ---
const MODEL = process.env.MODEL || 'sonnet';
const MAX_BUDGET = process.env.MAX_BUDGET || '1.00';
const MAX_DIFF_SIZE = 200 * 1024; // 200KB

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
    throw new Error(`Failed to fetch PR diff: ${err.message}`);
  }
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
function buildPrompt(diff) {
  return `You are a senior software engineer performing a focused bug review on a pull request diff.

TASK: Analyze the following PR diff and identify ONLY genuine bugs, logic errors, security vulnerabilities, race conditions, null/undefined dereferences, off-by-one errors, resource leaks, and other concrete defects in the ADDED or MODIFIED lines (lines starting with +).

DO NOT report:
- Style issues, naming conventions, or formatting
- Missing documentation or comments
- Performance suggestions unless they cause correctness issues
- Test coverage gaps
- Suggestions or improvements that aren't bugs

For each bug found, determine the EXACT line number in the NEW version of the file. The line numbers can be calculated from the @@ hunk headers in the diff. For example, "@@ -10,6 +15,8 @@" means the new file starts at line 15 for that hunk.

If the same bug pattern or a directly related issue also appears in OTHER files within the diff, list those in additional_locations.

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
  "summary": "Brief 1-2 sentence overall summary"
}

Omit additional_locations or set it to [] if there are no related locations.
If no bugs are found, return: {"bugs": [], "summary": "No bugs found in the changes."}

Here is the PR diff to analyze:

${diff}`;
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
    console.error('Auth check stderr:\n' + ping.stderr);
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

// --- Single attempt: spawn claude, kill+return if no output for stallTimeoutMs ---
function runClaudeAttempt(args, env, stallTimeoutMs) {
  return new Promise((resolve) => {
    // stdin is 'ignore' — diff is embedded in the -p prompt arg, no stdin needed
    const child = spawn('claude', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let lastActivityAt = Date.now();
    let stalledAndKilled = false;

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      lastActivityAt = Date.now();
      process.stdout.write(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      lastActivityAt = Date.now();
      // Stream live so the Actions log shows Claude is actively working
      process.stderr.write(chunk);
    });

    // Check every 5s: log idle time after 15s of silence, kill at stallTimeoutMs
    const stallChecker = setInterval(() => {
      const idleMs = Date.now() - lastActivityAt;
      if (idleMs > stallTimeoutMs) {
        stalledAndKilled = true;
        clearInterval(stallChecker);
        child.kill('SIGKILL');
      } else if (idleMs > 30_000) {
        console.log(`   ⏳ No output for ${Math.round(idleMs / 1000)}s (kill threshold: ${stallTimeoutMs / 1000}s)...`);
      }
    }, 5_000);

    child.on('close', (code) => {
      clearInterval(stallChecker);
      if (stalledAndKilled) {
        resolve({ stalled: true, stderr });
        return;
      }
      // stderr was already streamed live above — don't print again
      if (code !== 0) {
        resolve({ success: false, code, stderr });
        return;
      }
      resolve({ success: true, stdout });
    });

    child.on('error', (err) => {
      clearInterval(stallChecker);
      resolve({ success: false, code: null, stderr, spawnError: err });
    });
  });
}

// --- Run Claude Code CLI with stall detection and automatic retry ---
const STALL_TIMEOUT_MS = 3 * 60_000; // kill if no output for 3 minutes
const MAX_ATTEMPTS = 3;

async function runClaude(diff) {
  const prompt = buildPrompt(diff);
  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--max-turns', '1',
    '--dangerously-skip-permissions',
    '--model', MODEL,
    '--max-budget-usd', MAX_BUDGET,
  ];
  const env = {
    ...process.env,
    CI: 'true',
    NO_COLOR: '1',
    TERM: 'dumb',
    CLAUDE_NO_TELEMETRY: '1',
  };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      console.log(`🔄 Retry ${attempt}/${MAX_ATTEMPTS} — waiting 5s before restart...`);
      await new Promise((r) => setTimeout(r, 5_000));
    }

    console.log(`   Attempt ${attempt}/${MAX_ATTEMPTS} (stall limit: ${STALL_TIMEOUT_MS / 1000}s)...`);
    const result = await runClaudeAttempt(args, env, STALL_TIMEOUT_MS);

    if (result.stalled) {
      console.warn(`⚠️  No output for ${STALL_TIMEOUT_MS / 1000}s — process killed.`);
      if (attempt < MAX_ATTEMPTS) continue;
      throw new Error(`Claude Code CLI stalled on all ${MAX_ATTEMPTS} attempts with no output.`);
    }

    if (result.spawnError) {
      throw new Error(`Claude Code CLI failed to start: ${result.spawnError.message}`);
    }

    if (!result.success) {
      throw new Error(
        `Claude Code CLI exited with status ${result.code}` +
        (result.stderr ? ': ' + result.stderr.trim() : '')
      );
    }

    return result.stdout;
  }
}

// --- Parse Claude's response ---
function parseResponse(stdout) {
  // The --output-format json wraps the response in { result: "...", ... }
  let outer;
  try {
    outer = JSON.parse(stdout);
  } catch {
    throw new Error(`Failed to parse Claude CLI output as JSON: ${stdout.slice(0, 500)}`);
  }

  if (outer.is_error) {
    throw new Error(`Claude returned an error: ${outer.result}`);
  }

  const resultText = outer.result;

  // Try direct JSON parse of the result
  try {
    return JSON.parse(resultText);
  } catch {
    // Fallback: extract JSON from code fences
    const fenceMatch = resultText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) {
      try {
        return JSON.parse(fenceMatch[1]);
      } catch {
        // Fall through
      }
    }

    // Fallback: find first { ... } block
    const braceMatch = resultText.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      try {
        return JSON.parse(braceMatch[0]);
      } catch {
        // Fall through
      }
    }

    throw new Error(`Could not extract JSON from Claude's response: ${resultText.slice(0, 500)}`);
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

// --- Stable identifier for a bug (used to match across commits) ---
function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function makeBugId(bug) {
  return `${bug.file}:${slugify(bug.title)}`;
}

function formatInlineComment(bug, repo, headSha) {
  const severityEmoji = {
    critical: '🔴',
    high: '🟠',
    medium: '🟡',
    low: '🔵',
  };
  const emoji = severityEmoji[bug.severity] || '⚪';

  let comment = `${emoji} **${bug.severity.toUpperCase()}**: ${bug.title}\n\n${bug.description}`;

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

  // Split bugs into inline-commentable and non-commentable,
  // skipping any that already have an open thread (to avoid duplicates)
  const inlineComments = [];
  const orphanBugs = [];

  for (const bug of bugs) {
    if (alreadyCommentedBugIds.has(makeBugId(bug))) continue;
    const fileLines = validLines.get(bug.file);
    if (fileLines && fileLines.has(bug.line)) {
      inlineComments.push({
        path: bug.file,
        line: bug.line,
        side: 'RIGHT',
        body: formatInlineComment(bug, repo, headSha),
      });
    } else {
      orphanBugs.push(bug);
    }
  }

  // Build summary body, including any orphan bugs
  let body = formatSummary(analysis);

  if (orphanBugs.length > 0) {
    body += '\n\n### Additional findings (could not map to diff lines)\n';
    for (const bug of orphanBugs) {
      const emoji = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵' }[bug.severity] || '⚪';
      body += `\n- ${emoji} **${bug.file}:${bug.line}** — ${bug.title}: ${bug.description}`;
    }
  }

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

// --- Manage open BugBot threads from previous runs ---
// Requires the github-token to have pull-requests: write permission.
// Queries open BugBot review threads, auto-resolves threads whose bug is no longer
// detected, and returns the Set of bug IDs that still have open threads so
// postReview can skip re-posting duplicate inline comments for them.
function resolveFixedThreads(repo, prNumber, newBugs) {
  const [owner, repoName] = repo.split('/');
  const activeBugIds = new Set(newBugs.map(b => makeBugId(b)));
  const tmpDir = mkdtempSync(join(tmpdir(), 'bugbot-resolve-'));

  const queryPayload = {
    query: `query($owner: String!, $repo: String!, $pr: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $pr) {
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              comments(first: 1) {
                nodes { body }
              }
            }
          }
        }
      }
    }`,
    variables: { owner, repo: repoName, pr: prNumber },
  };

  const queryPath = join(tmpDir, 'query.json');
  writeFileSync(queryPath, JSON.stringify(queryPayload));

  let threads;
  try {
    const raw = execSync(`gh api graphql --input "${queryPath}"`, { encoding: 'utf-8' });
    threads = JSON.parse(raw)?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  } catch (err) {
    console.warn(`⚠️ Could not fetch review threads (skipping deduplication): ${err.message}`);
    return new Set();
  }

  const alreadyCommentedBugIds = new Set();

  for (let i = 0; i < threads.length; i++) {
    const thread = threads[i];
    if (thread.isResolved) continue;

    const body = thread.comments?.nodes?.[0]?.body ?? '';
    const match = body.match(/<!-- bugbot-id:([^\s>]+) -->/);
    if (!match) continue;

    const bugId = match[1];

    if (activeBugIds.has(bugId)) {
      // Bug still present — record so we don't post a duplicate comment
      alreadyCommentedBugIds.add(bugId);
    } else {
      // Bug fixed — resolve the thread
      const mutationPayload = {
        query: `mutation($threadId: ID!) {
          resolveReviewThread(input: { threadId: $threadId }) {
            thread { isResolved }
          }
        }`,
        variables: { threadId: thread.id },
      };
      const mutationPath = join(tmpDir, `resolve-${i}.json`);
      writeFileSync(mutationPath, JSON.stringify(mutationPayload));
      try {
        execSync(`gh api graphql --input "${mutationPath}"`, { encoding: 'utf-8' });
        console.log(`  ✅ Auto-resolved: ${bugId}`);
      } catch (err) {
        console.warn(`  ⚠️ Could not resolve thread for ${bugId}: ${err.message}`);
      }
    }
  }

  return alreadyCommentedBugIds;
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
  let diff = fetchDiff(pr.number);

  if (!diff.trim()) {
    console.log('ℹ️ Empty diff, nothing to analyze.');
    return;
  }

  // 3. Size check
  if (Buffer.byteLength(diff) > MAX_DIFF_SIZE) {
    console.warn(`⚠️ Diff is ${(Buffer.byteLength(diff) / 1024).toFixed(0)}KB, truncating to ${MAX_DIFF_SIZE / 1024}KB`);
    diff = diff.slice(0, MAX_DIFF_SIZE) + '\n\n[... diff truncated due to size ...]';
  }

  // 4. Parse diff for valid lines
  console.log('🔍 Parsing diff...');
  const validLines = parseDiff(diff);
  const fileCount = validLines.size;
  console.log(`   Found changes in ${fileCount} file(s)`);

  // 5. Run Claude analysis
  console.log(`🧠 Running Claude (${MODEL}) analysis...`);
  const stdout = await runClaude(diff);

  // 6. Parse response
  console.log('📊 Parsing results...');
  const analysis = parseResponse(stdout);

  if (!analysis.bugs || !Array.isArray(analysis.bugs)) {
    throw new Error('Invalid response format: missing bugs array');
  }

  console.log(`   Found ${analysis.bugs.length} potential bug(s)`);

  // 7. Resolve fixed threads and get already-commented bug IDs to suppress duplicates
  console.log('🔄 Checking for resolved issues...');
  const alreadyCommentedBugIds = resolveFixedThreads(pr.repo, pr.number, analysis.bugs);

  // 8. Post review for new / still-present bugs
  console.log('💬 Posting PR review...');
  postReview(pr.repo, pr.number, pr.headSha, analysis, validLines, alreadyCommentedBugIds);

  console.log('🤖 Claude BugBot - Done!');
}

main().catch((err) => {
  console.error(`❌ BugBot failed: ${err.message}`);
  process.exit(1);
});
