import { describe, expect, test } from 'bun:test';
import type { IntentAssessment } from '../../src/auto-approve/intent-assessment.ts';
import { parseGitHubRemoteUrl } from '../../src/auto-approve/repository-context.ts';
import {
  SessionWorkflowGrantStore,
  classifySessionWorkflowOperation,
  semanticAssessmentMatchesWorkflow,
} from '../../src/auto-approve/session-workflow-grant.ts';

const context = {
  sessionId: 'session-a',
  workingDirectory: '/repo/a',
  repository: 'yooz-labs/remi',
} as const;

function classify(command: string) {
  return classifySessionWorkflowOperation('Bash', { command }, context);
}

describe('session workflow grant classifier (#1095)', () => {
  test('recognizes a literal issue-planning create command', () => {
    const facts = classify(
      "gh issue create --repo Yooz-Labs/remi --title 'Improve routing' --body 'Document the benign workflow' --label planning --draft",
    );
    expect(facts).toEqual({
      sessionId: 'session-a',
      workingDirectory: '/repo/a',
      repository: 'yooz-labs/remi',
      family: 'github-issue-planning',
      kind: 'github-issue-create',
      effects: ['network_write', 'remote_mutation'],
      target: { repository: 'yooz-labs/remi', issueNumbers: [] },
    });
  });

  test('recognizes sub-issue linking and derives the target numbers', () => {
    const facts = classify('gh sub-issue add 1386 --sub-issue-number 1402');
    expect(facts?.kind).toBe('github-sub-issue-add');
    expect(facts?.target).toEqual({
      repository: 'yooz-labs/remi',
      issueNumbers: [1386, 1402],
    });
  });

  test('keeps quoted prose literal while rejecting shell control outside it', () => {
    expect(
      classify("gh issue create --title 'literal > and $(not-run)' --body 'planning'")?.kind,
    ).toBe('github-issue-create');
    expect(
      classify("gh issue create --title 'planning' --body 'details' > /tmp/out"),
    ).toBeUndefined();
    expect(classify("gh issue create --title 'planning' --body 'details'; whoami")).toBeUndefined();
    expect(classify('gh issue create --title \'planning\' --body "$(whoami)"')).toBeUndefined();
  });

  test('rejects alternate targets and unsupported or file-backed actions', () => {
    for (const command of [
      "gh issue create --hostname evil.example --title 'x' --body 'y'",
      "gh issue create --title 'x' --body-file notes.md",
      "gh issue create --title 'x' --body 'y' --web",
      'gh issue close 1386',
      'gh issue delete 1386',
      'gh pr merge 1386',
      'gh sub-issue remove 1386 --sub-issue-number 1402',
      'gh issue create --title "$TITLE" --body "y"',
      "gh issue create --title 'x' --body 'y' && gh issue close 1386",
      "python3 -c 'print(1)'",
    ]) {
      expect(classify(command), command).toBeUndefined();
    }
  });

  test('requires a complete literal scope', () => {
    expect(
      classifySessionWorkflowOperation(
        'Bash',
        { command: "gh issue create --title 'x' --body 'y'" },
        { sessionId: context.sessionId, workingDirectory: context.workingDirectory },
      ),
    ).toBeUndefined();
    expect(
      classifySessionWorkflowOperation(
        'Write',
        { command: "gh issue create --title 'x' --body 'y'" },
        context,
      ),
    ).toBeUndefined();
    expect(classify('gh sub-issue add 1386')).toBeUndefined();
    expect(classify('gh sub-issue add nope --sub-issue-number 1402')).toBeUndefined();
  });
});

describe('repository context parsing (#1095)', () => {
  test('accepts credential-free GitHub remote forms only', () => {
    expect(parseGitHubRemoteUrl('https://github.com/Yooz-Labs/remi.git')).toBe('yooz-labs/remi');
    expect(parseGitHubRemoteUrl('git@github.com:yooz-labs/remi.git')).toBe('yooz-labs/remi');
    expect(parseGitHubRemoteUrl('ssh://git@github.com/yooz-labs/remi')).toBe('yooz-labs/remi');
    expect(
      parseGitHubRemoteUrl('https://user:secret@github.com/yooz-labs/remi.git'),
    ).toBeUndefined();
    expect(parseGitHubRemoteUrl('https://gitlab.com/yooz-labs/remi.git')).toBeUndefined();
  });
});

describe('session workflow grant store (#1095)', () => {
  test('binds a grant to session, cwd, repository, family, and expiry', () => {
    let now = 1_000;
    const store = new SessionWorkflowGrantStore(
      context.sessionId,
      context.workingDirectory,
      context.repository,
      { ttlMs: 100, now: () => now },
    );
    const operation = classify("gh issue create --title 'x' --body 'y'");
    expect(operation).toBeDefined();
    if (!operation) return;

    expect(store.matches(operation)).toBe(false);
    expect(store.grant(operation)).toBe(true);
    expect(store.matches(operation)).toBe(true);
    expect(store.matches({ ...operation, sessionId: 'session-b' })).toBe(false);
    expect(store.matches({ ...operation, workingDirectory: '/repo/b' })).toBe(false);
    expect(
      store.matches({
        ...operation,
        repository: 'other/project',
        target: { ...operation.target, repository: 'other/project' },
      }),
    ).toBe(false);
    expect(
      store.matches({ ...operation, family: 'github-issue-planning', effects: ['network_write'] }),
    ).toBe(false);

    now = 1_100;
    expect(store.matches(operation)).toBe(false);
    expect(store.grant(operation)).toBe(true);
    store.clear();
    expect(store.matches(operation)).toBe(false);
  });

  test('requires deterministic semantic confirmation without trusting extra effects', () => {
    const operation = classify("gh issue create --title 'x' --body 'y'");
    expect(operation).toBeDefined();
    if (!operation) return;
    const assessment: IntentAssessment = {
      intent: 'remote_mutation',
      effects: ['network_write', 'remote_mutation'],
      scope: 'remote_repository',
      reversible: true,
      confidence: 0.9,
      reasoning: 'It creates a planning issue in the named repository.',
    };
    expect(semanticAssessmentMatchesWorkflow(operation, assessment)).toBe(true);
    expect(
      semanticAssessmentMatchesWorkflow(operation, {
        ...assessment,
        effects: ['network_write', 'remote_mutation', 'credential_access'],
      }),
    ).toBe(false);
    expect(semanticAssessmentMatchesWorkflow(operation, { ...assessment, confidence: 0.84 })).toBe(
      false,
    );
    expect(semanticAssessmentMatchesWorkflow(operation, { ...assessment, reversible: false })).toBe(
      false,
    );
    expect(
      semanticAssessmentMatchesWorkflow(operation, { ...assessment, scope: 'repository' }),
    ).toBe(false);
  });
});
