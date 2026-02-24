#!/usr/bin/env node

import { execSync, execFileSync } from 'child_process';
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
function buildPrompt() {
  return `You are a senior software engineer performing a focused bug review on a pull request diff.

TASK: Analyze the diff provided via stdin and identify ONLY genuine bugs, logic errors, security vulnerabilities, race conditions, null/undefined dereferences, off-by-one errors, resource leaks, and other concrete defects in the ADDED or MODIFIED lines (lines starting with +).

DO NOT report:
- Style issues, naming conventions, or formatting
- Missing documentation or comments
- Performance suggestions unless they cause correctness issues
- Test coverage gaps
- Suggestions or improvements that aren't bugs

For each bug found, determine the EXACT line number in the NEW version of the file. The line numbers can be calculated from the @@ hunk headers in the diff. For example, "@@ -10,6 +15,8 @@" means the new file starts at line 15 for that hunk.

Respond with ONLY a JSON object (no markdown fences, no extra text) in this exact format:
{
  "bugs": [
    {
      "file": "path/to/file.js",
      "line": 42,
      "severity": "critical|high|medium|low",
      "title": "Short bug title",
      "description": "Clear explanation of the bug and suggested fix"
    }
  ],
  "summary": "Brief 1-2 sentence overall summary"
}

If no bugs are found, return: {"bugs": [], "summary": "No bugs found in the changes."}`;
}

// --- Run Claude Code CLI ---
function runClaude(diff) {
  const prompt = buildPrompt();
  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--max-turns', '1',
    '--dangerously-skip-permissions',
    '--model', MODEL,
    '--max-budget-usd', MAX_BUDGET,
  ];

  try {
    // Use execFileSync to avoid shell escaping issues with the prompt
    const stdout = execFileSync('claude', args, {
      input: diff,
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
      timeout: 5 * 60 * 1000, // 5 minute timeout
    });
    return stdout;
  } catch (err) {
    throw new Error(`Claude Code CLI failed: ${err.message}`);
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

function formatInlineComment(bug) {
  const severityEmoji = {
    critical: '🔴',
    high: '🟠',
    medium: '🟡',
    low: '🔵',
  };
  const emoji = severityEmoji[bug.severity] || '⚪';
  return `${emoji} **${bug.severity.toUpperCase()}**: ${bug.title}\n\n${bug.description}`;
}

// --- Post PR review ---
function postReview(repo, prNumber, headSha, analysis, validLines) {
  const { bugs } = analysis;

  // Split bugs into inline-commentable and non-commentable
  const inlineComments = [];
  const orphanBugs = [];

  for (const bug of bugs) {
    const fileLines = validLines.get(bug.file);
    if (fileLines && fileLines.has(bug.line)) {
      inlineComments.push({
        path: bug.file,
        line: bug.line,
        side: 'RIGHT',
        body: formatInlineComment(bug),
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
      body += `\n- ${emoji} **${bug.file}:${bug.line}** - ${bug.title}: ${bug.description}`;
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

// --- Main ---
async function main() {
  console.log('🤖 Claude BugBot - Starting analysis...');

  // 1. Get PR info
  const pr = getPRInfo();
  console.log(`📋 PR #${pr.number} in ${pr.repo} (head: ${pr.headSha.slice(0, 7)})`);

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
  const stdout = runClaude(diff);

  // 6. Parse response
  console.log('📊 Parsing results...');
  const analysis = parseResponse(stdout);

  if (!analysis.bugs || !Array.isArray(analysis.bugs)) {
    throw new Error('Invalid response format: missing bugs array');
  }

  console.log(`   Found ${analysis.bugs.length} potential bug(s)`);

  // 7. Post review
  console.log('💬 Posting PR review...');
  postReview(pr.repo, pr.number, pr.headSha, analysis, validLines);

  console.log('🤖 Claude BugBot - Done!');
}

main().catch((err) => {
  console.error(`❌ BugBot failed: ${err.message}`);
  process.exit(1);
});
