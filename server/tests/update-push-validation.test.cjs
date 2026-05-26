'use strict';

const { validateVersion, normalizeChangelogArray, buildCommitMessage } = require('../updatePushValidators.cjs');

describe('update-push validation (injection-safe)', () => {
  test('version rejects shell injection payload', () => {
    const bad = validateVersion(`1.0"; rm -rf /; echo "`);
    expect(bad.ok).toBe(false);
  });

  test('version rejects semicolons and pipes', () => {
    expect(validateVersion('1.0;a').ok).toBe(false);
    expect(validateVersion('x|y').ok).toBe(false);
  });

  test('changelog strips shell metacharacters but keeps alphanumeric content', () => {
    const { ok, changelog } = normalizeChangelogArray(['fix bug', '`rm` $PATH ; | &']);
    expect(ok).toBe(true);
    expect(changelog[0]).toContain('fix');
    expect(changelog[1]).not.toMatch(/[`$|;|&]/);
  });

  test('commit message never embeds unsanitized user strings', () => {
    const { ok, changelog } = normalizeChangelogArray(['`; git push malicious`']);
    expect(ok).toBe(true);
    const msg = buildCommitMessage('1.2.3', changelog);
    expect(msg).not.toMatch(/[`;$|&]/);
    expect(msg).toContain('v1.2.3');
  });
});
