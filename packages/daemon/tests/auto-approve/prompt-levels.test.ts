/**
 * #966: the prompt's DEFAULT GUIDELINES vary by level.
 *
 * Two properties matter more than the wording:
 *
 *  1. `strict`'s prompt is PINNED, so every change to it is deliberate.
 *     Through #1040 the baseline was `develop`'s own pre-levels output, which
 *     made this a differential check ("introducing levels changed nothing for
 *     existing users"). #1040 had to correct the shared header at EVERY level,
 *     so the baseline is now this branch's output and the pin is a
 *     change-gate, not a comparison. See the `describe` block below for the
 *     standard that governs regenerating it.
 *  2. Raising a level widens what is ROUTINE, never what is dangerous. The
 *     DENY FLOOR, deletion, remote mutation, package install and design
 *     questions are fixed at every level, and each is asserted rather than
 *     described. "Fixed" is a claim about THIS PROMPT: ADR 0023's
 *     `artifact-clean` approves proved-derived deletion deterministically,
 *     before any prompt is built, and everything that does reach the model
 *     still escalates deletion at every level.
 */

import { describe, expect, test } from 'bun:test';
import { AUTO_APPROVE_LEVELS } from '../../src/auto-approve/levels.ts';
import { buildPrompt } from '../../src/auto-approve/prompt-builder.ts';

const BASELINE_PATH = `${import.meta.dir}/fixtures/prompt-strict-baseline.txt`;

/** The section heading, not the bare words: "DENY FLOOR" also appears in the
 *  header's action definitions, so a plain indexOf finds that one first and
 *  every section slice runs backwards into an empty string. */
const FLOOR_HEADING = 'DENY FLOOR (always applies';

/** The system prompt for one level, with no instructions and no authority. */
function systemPrompt(level?: (typeof AUTO_APPROVE_LEVELS)[number]): string {
  const messages = buildPrompt('Bash', { command: 'PLACEHOLDER' }, undefined, undefined, level);
  return messages[0]?.content ?? '';
}

// #966 pinned this to prove that introducing LEVELS changed nothing for
// existing (strict) users. The pin still does that job, but the baseline moves
// when the shared prompt's decision procedure changes deliberately. This
// change removes contradictory claims that prose guidance is both a primary
// authority and deterministic authorization. Multi-choice guidance has its own
// contract tests in multichoice.test.ts.
//
// Regenerate ONLY with a reason of that kind, never to make a diff go green:
//   bun -e "import {buildPrompt} from './packages/daemon/src/auto-approve/prompt-builder.ts'; \
//     await Bun.write('packages/daemon/tests/auto-approve/fixtures/prompt-strict-baseline.txt', \
//     buildPrompt('Bash',{command:'PLACEHOLDER'},undefined,undefined,'strict')[0].content)"
describe('the strict prompt is pinned; every change to it is deliberate', () => {
  test('matches the captured baseline', async () => {
    const baseline = await Bun.file(BASELINE_PATH).text();
    expect(systemPrompt('strict')).toBe(baseline);
  });

  test('the default parameter is strict', () => {
    // Every existing caller omitted the argument. If the default were
    // anything else, this change would silently widen every one of them.
    expect(systemPrompt()).toBe(systemPrompt('strict'));
  });

  test('an unrecognised level falls back to strict rather than dropping a section', () => {
    // A prompt missing its guidelines is far worse than a conservative one.
    const bogus = systemPrompt('nonsense' as (typeof AUTO_APPROVE_LEVELS)[number]);
    expect(bogus).toBe(systemPrompt('strict'));
  });
});

describe('what every level shares', () => {
  const prompts = AUTO_APPROVE_LEVELS.map((l) => ({ level: l, text: systemPrompt(l) }));

  test('the DENY FLOOR block is identical at every level', () => {
    const floors = prompts.map(({ text }) => {
      const start = text.indexOf(FLOOR_HEADING);
      const end = text.indexOf('Respond with JSON ONLY');
      return text.slice(start, end);
    });
    expect(floors[0]).toContain('rm -rf /');
    for (const floor of floors) expect(floor).toBe(floors[0] as string);
  });

  test('the response format is identical at every level', () => {
    const formats = prompts.map(({ text }) => text.slice(text.indexOf('Respond with JSON ONLY')));
    for (const format of formats) expect(format).toBe(formats[0] as string);
  });

  // Renamed by the ADR 0023 adversarial pass. It was 'deletion escalates at
  // every level', which the body already qualified — but the NAME is a claim
  // too, and at `trusted` a proved-derived deletion does not escalate: it is
  // approved deterministically before any prompt exists. A name that overstates
  // what a test pins is the ADR 0011 failure mode in the place it hides best.
  test('every deletion that REACHES the prompt escalates, at every level', () => {
    // #956's rule: deletion is where escalation earns its cost. No level,
    // including `trusted`, may move it. Amended, not weakened, by ADR 0023:
    // `artifact-clean` approves proved-derived deletion in the DETERMINISTIC
    // layer, which never builds a prompt — so what this pins is exactly the
    // surviving half of the rule: every deletion that REACHES the LLM still
    // escalates, at every level.
    //
    // Case-insensitive on purpose: `strict` carries develop's original
    // wording ("file creation, modification, or deletion") verbatim, because
    // byte-identity there matters more than a consistent house style. Matching
    // the CASING would pin the phrasing rather than the property.
    for (const { level, text } of prompts) {
      const escalate = text.slice(
        text.indexOf('ESCALATE these operations'),
        text.indexOf(FLOOR_HEADING),
      );
      expect(escalate.toLowerCase(), `level ${level}`).toContain('deletion');
    }
  });

  test('at balanced and trusted, deletion is the ONLY file operation left escalating', () => {
    // The replace-not-delete property. The pre-#966 line bundles "creation,
    // modification, or deletion" into one entry -- dropping it wholesale to
    // approve writes would have silently promoted `rm` too. Still true after
    // ADR 0023: `artifact-clean` lives in the deterministic layer and this
    // prompt is what governs everything that layer did NOT prove.
    for (const level of ['balanced', 'trusted'] as const) {
      const text = systemPrompt(level);
      const escalate = text.slice(
        text.indexOf('ESCALATE these operations'),
        text.indexOf(FLOOR_HEADING),
      );
      expect(escalate, `level ${level}`).toContain('file DELETION under the project tree');
      expect(escalate, `level ${level}`).not.toContain('file creation, modification');
    }
  });

  test('at trusted, git push and reset still escalate', () => {
    // Same shape one line down: the pre-#966 git entry names `git push` and
    // `git reset` alongside `git add`. `trusted` narrows it instead of
    // removing it, or approving local git would have approved a push.
    const text = systemPrompt('trusted');
    const escalate = text.slice(
      text.indexOf('ESCALATE these operations'),
      text.indexOf(FLOOR_HEADING),
    );
    expect(escalate).toContain('git push');
    expect(escalate).toContain('git reset');
    expect(escalate).toContain('--force');
  });

  test('remote mutation escalates at every level', () => {
    for (const { level, text } of prompts) {
      const escalate = text.slice(text.indexOf('ESCALATE these operations'));
      expect(escalate, `level ${level}`).toContain('remote MUTATIONS');
      expect(escalate, `level ${level}`).toContain('git push');
    }
  });

  test('package install escalates at every level', () => {
    for (const { level, text } of prompts) {
      const escalate = text.slice(text.indexOf('ESCALATE these operations'));
      expect(escalate, `level ${level}`).toContain('package install');
    }
  });

  test('the design/direction rule is present at every level', () => {
    for (const { level, text } of prompts) {
      expect(text, `level ${level}`).toContain('Design / direction / steering decisions');
    }
  });
});

describe('what each level changes', () => {
  test('balanced approves writes; strict escalates them', () => {
    const strict = systemPrompt('strict');
    const balanced = systemPrompt('balanced');
    const escalateOf = (t: string) =>
      t.slice(t.indexOf('ESCALATE these operations'), t.indexOf(FLOOR_HEADING));
    const approveOf = (t: string) =>
      t.slice(t.indexOf('APPROVE these operations'), t.indexOf('ESCALATE these operations'));

    expect(escalateOf(strict)).toContain('Write/Edit/NotebookEdit');
    expect(escalateOf(balanced)).not.toContain('Write/Edit/NotebookEdit');
    expect(approveOf(balanced)).toContain('Write/Edit/NotebookEdit');
  });

  test('balanced still escalates local git; trusted approves it', () => {
    const escalateOf = (t: string) =>
      t.slice(t.indexOf('ESCALATE these operations'), t.indexOf(FLOOR_HEADING));
    expect(escalateOf(systemPrompt('balanced'))).toContain('git add, git commit');
    expect(escalateOf(systemPrompt('trusted'))).not.toContain('git add, git commit');
    expect(systemPrompt('trusted')).toContain('LOCAL git mutation');
  });

  test('trusted names every local git op it approves, by name', () => {
    // `git switch`, `git worktree add` and `git stash push` are approved at
    // `trusted` but appear NOWHERE in the pre-#966 prompt, so nothing else in
    // this file would notice if one were dropped (#967 review).
    const approve = systemPrompt('trusted').slice(
      systemPrompt('trusted').indexOf('APPROVE these operations'),
      systemPrompt('trusted').indexOf('ESCALATE these operations'),
    );
    for (const op of [
      'git add',
      'git commit',
      'git checkout',
      'git switch',
      'git merge',
      'git stash push',
      'git worktree add',
    ]) {
      expect(approve, `trusted should approve ${op}`).toContain(op);
    }
  });

  test('git rebase escalates even at trusted', () => {
    // Deliberately absent from the approve list: a rebase rewrites history and
    // is not in the same reversible class as add/commit/checkout. Asserted
    // because it is the kind of omission that looks like an oversight and
    // would be "fixed" by someone tidying the list.
    const trusted = systemPrompt('trusted');
    const escalate = trusted.slice(
      trusted.indexOf('ESCALATE these operations'),
      trusted.indexOf(FLOOR_HEADING),
    );
    expect(escalate).toContain('git rebase');
  });

  test('trusted names what it does NOT cover, inline', () => {
    // The approve entry has to carry its own exclusions, or "approve local git
    // mutation" reads as covering push and force.
    const trusted = systemPrompt('trusted');
    expect(trusted).toContain('NOT git push');
    expect(trusted).toContain('NOT any --force');
  });

  test('every level produces a prompt with both sections and a floor', () => {
    for (const level of AUTO_APPROVE_LEVELS) {
      const text = systemPrompt(level);
      expect(text, `level ${level}`).toContain('APPROVE these operations');
      expect(text, `level ${level}`).toContain('ESCALATE these operations');
      expect(text, `level ${level}`).toContain(FLOOR_HEADING);
    }
  });
});

describe('instructions and authority still work at every level', () => {
  test('user guidance is injected and reinforced at every level', () => {
    for (const level of AUTO_APPROVE_LEVELS) {
      const messages = buildPrompt(
        'Bash',
        { command: 'x' },
        'Escalate anything touching packages/signaling.',
        undefined,
        level,
      );
      const text = messages[0]?.content ?? '';
      expect(text, `level ${level}`).toContain('USER GUIDANCE');
      expect(text, `level ${level}`).toContain('packages/signaling');
      // Keep the recency reminder at every level; it is part of the prompt
      // contract and the small model sees the same guidance shape everywhere.
      expect(text, `level ${level}`).toContain(
        'REMEMBER: USER GUIDANCE is model exception context, not deterministic authorization',
      );
    }
  });

  test('the conversation-context block is injected at every level', () => {
    for (const level of AUTO_APPROVE_LEVELS) {
      const messages = buildPrompt('Bash', { command: 'x' }, undefined, 'I asked for this', level);
      const text = messages[0]?.content ?? '';
      expect(text, `level ${level}`).toContain('CONVERSATION CONTEXT — reported history');
      expect(text, `level ${level}`).toContain('I asked for this');
    }
  });
});

// #1040. The fixture above is generated with `instructions === undefined`, so
// it pins the shared header. The checks below cover every guidance-bearing
// location, including the recency reminder, so the prompt cannot quietly
// reintroduce "guidance is mandatory authorization" in one of them.
describe('the guidance block is model exception context, not deterministic authorization (#1040)', () => {
  function withGuidance(): string {
    return (
      buildPrompt(
        'Bash',
        { command: 'PLACEHOLDER' },
        'Approve routine work.',
        undefined,
        'strict',
      )[0]?.content ?? ''
    );
  }

  /** Every place the binary prompt tells the model what to do about guidance.
   *  The recency slot is last on purpose and was the site the scoping fix missed. */
  function guidanceSites(p: string): Record<string, string> {
    return {
      rule1: p.slice(p.indexOf('1. USER GUIDANCE:'), p.indexOf('2. CONVERSATION CONTEXT:')),
      block: p.slice(
        p.indexOf('USER GUIDANCE — MODEL EXCEPTION CONTEXT'),
        p.indexOf('APPROVE these operations'),
      ),
      reminder: p.slice(p.lastIndexOf('REMEMBER:')),
    };
  }

  test('no site tells the model that guidance is mandatory authorization', () => {
    for (const [name, text] of Object.entries(guidanceSites(withGuidance()))) {
      expect(text, `${name}: stale authority wording`).not.toContain('HIGHEST PRIORITY, MANDATORY');
      expect(text, `${name}: stale override wording`).not.toContain('OVERRIDES every default');
    }
  });

  test('every site identifies guidance as exception context and preserves an escalate branch', () => {
    const sites = guidanceSites(withGuidance());
    for (const [name, text] of Object.entries(sites)) {
      expect(text.toLowerCase(), `${name}: no exception wording`).toContain('exception');
    }
    for (const [name, text] of Object.entries(sites)) {
      expect(text.toLowerCase(), `${name}: no escalate branch`).toContain('escalate');
    }
  });

  test('each binary guidance site keeps the exact precedence contract', () => {
    const sites = guidanceSites(withGuidance());
    expect(sites.rule1).toContain(
      'model exception context, NOT deterministic authorization. Use it only to resolve genuine ambiguity on routine or moderate-risk work.',
    );
    expect(sites.rule1).toContain(
      'It cannot override the DENY FLOOR, the RISK CEILING, or a design/steering question.',
    );
    expect(sites.block).toContain(
      "It may influence the model's answer for routine or moderate-risk work, but it is not deterministic authorization; code-owned grants (allow/approve_groups and scoped workflow grants) remain separate.",
    );
    expect(sites.block).toContain(
      'If it plainly covers routine or moderate work, follow it; otherwise apply the default guidelines and escalate when unsure.',
    );
    expect(sites.reminder).toBe(
      'REMEMBER: USER GUIDANCE is model exception context, not deterministic authorization. Use it only for clearly routine or moderate work; otherwise follow the defaults and escalate when unsure.',
    );
  });

  test('the model is told that guidance is not deterministic authorization', () => {
    const p = withGuidance();
    expect(p).toContain('NOT DETERMINISTIC AUTHORIZATION');
    expect(p).toContain("may influence the model's answer");
    expect(p).toContain('code-owned grants');
  });

  test('the guidance block names the code-owned boundaries without enumerating guessed coverage', () => {
    const rule1 = guidanceSites(withGuidance())['rule1'] ?? '';
    expect(rule1).toContain('cannot override');
    expect(rule1).not.toContain('package install, destructive local op');
  });

  test('none of it renders when there is no guidance', () => {
    const bare = systemPrompt('strict');
    expect(bare).not.toContain('USER GUIDANCE — MODEL EXCEPTION CONTEXT');
    expect(bare).not.toContain('REMEMBER:');
  });
});
