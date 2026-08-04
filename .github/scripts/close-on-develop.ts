#!/usr/bin/env bun
/**
 * Glue script for .github/workflows/close-on-develop.yml.
 *
 * Reads the push event payload for this run, extracts GitHub issue-closing
 * keyword references from every commit in the push, filters them down to
 * references this repo's own GITHUB_TOKEN can act on, and writes the result
 * to $GITHUB_OUTPUT as `issues` (a compact JSON array of {issue, keyword})
 * for the workflow's next step to close via `gh`.
 *
 * This file is intentionally thin I/O plumbing around the pure, unit-tested
 * logic in packages/shared/src/issue-closing.ts (see
 * packages/shared/tests/issue-closing.test.ts) -- it is not itself unit
 * tested, and should stay simple enough that it doesn't need to be.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import {
  extractClosingReferencesFromMessages,
  filterSameRepoReferences,
} from '../../packages/shared/src/issue-closing.ts';

interface PushCommit {
  id?: string;
  message?: string;
}

interface PushEvent {
  deleted?: boolean;
  commits?: PushCommit[];
  head_commit?: PushCommit | null;
}

function writeOutput(name: string, value: string): void {
  const outputPath = process.env['GITHUB_OUTPUT'];
  if (!outputPath) {
    throw new Error('GITHUB_OUTPUT is not set; this script must run inside a GitHub Actions step.');
  }
  appendFileSync(outputPath, `${name}=${value}\n`);
}

function main(): void {
  const eventPath = process.env['GITHUB_EVENT_PATH'];
  const repository = process.env['GITHUB_REPOSITORY'];
  if (!eventPath || !repository) {
    throw new Error('GITHUB_EVENT_PATH and GITHUB_REPOSITORY must both be set.');
  }
  const [currentOwner, currentRepo] = repository.split('/');
  if (!currentOwner || !currentRepo) {
    throw new Error(`Unexpected GITHUB_REPOSITORY format: "${repository}"`);
  }

  const event = JSON.parse(readFileSync(eventPath, 'utf8')) as PushEvent;

  // A branch-deletion push carries no new commits -- nothing to scan.
  if (event.deleted) {
    writeOutput('issues', '[]');
    console.log('Push deleted the ref; nothing to scan.');
    return;
  }

  // Use the event payload's own commit list rather than computing a
  // before..after diff ourselves. Deriving a range would crash on the
  // first push to a branch (`before` is all-zeros, not a real commit) and
  // misbehave on a force-push (`before` may not even be an ancestor of
  // `after` anymore) -- GitHub has already resolved both cases for us into
  // this array, so trust it instead of re-deriving it.
  const commits = event.commits ?? [];
  const byId = new Map<string, string>();
  for (const commit of commits) {
    if (commit.id && typeof commit.message === 'string') {
      byId.set(commit.id, commit.message);
    }
  }
  // head_commit is normally already present in `commits`, but merge it in
  // defensively in case a payload shape ever omits it from the array.
  if (event.head_commit?.id && typeof event.head_commit.message === 'string') {
    byId.set(event.head_commit.id, event.head_commit.message);
  }

  const messages = [...byId.values()];
  const refs = extractClosingReferencesFromMessages(messages);
  const sameRepoRefs = filterSameRepoReferences(refs, currentOwner, currentRepo);

  const issues = sameRepoRefs.map((ref) => ({ issue: ref.issue, keyword: ref.keyword }));
  writeOutput('issues', JSON.stringify(issues));

  if (issues.length > 0) {
    const summary = issues.map((entry) => `#${entry.issue} (${entry.keyword})`).join(', ');
    console.log(`Found ${issues.length} issue reference(s) to close: ${summary}`);
  } else {
    console.log('No same-repo closing references found in this push.');
  }
}

main();
