/**
 * Child process for `fixtures-redaction.test.ts` (epic #1175, #1181): scans the committed fixtures
 * with the scan's real, process-derived identity, and prints the findings as JSON. The test runs it
 * under `env -i`, where `os.userInfo().username` is the literal `unknown`, a word the fixtures use.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURE_DIR, readApprovedFreeText } from './codex-fixtures.ts';
import { scanForLeaks } from './fixture-scan.ts';

const approvedFreeText = readApprovedFreeText();
const findings: Array<{ file: string; rule: string }> = [];
for (const file of readdirSync(FIXTURE_DIR)) {
  if (!file.endsWith('.jsonl') && file !== 'index.json') continue;
  for (const f of scanForLeaks(readFileSync(join(FIXTURE_DIR, file), 'utf8'), {
    approvedFreeText,
  })) {
    findings.push({ file, rule: f.rule });
  }
}
console.log(JSON.stringify(findings));
