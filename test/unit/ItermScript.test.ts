// @ts-nocheck
import { describe, expect, test } from '@jest/globals';
import { scriptForSession, osascriptCommand, assertValidSessionId } from '../../src/ItermScript.js';

describe('scriptForSession', () => {
  test('falls back to the focused session when no id is given', () => {
    const script = scriptForSession(undefined, 'get tty');
    expect(script).toContain('current session of current window');
    expect(script).toContain('get tty');
  });

  test('matches on unique id when an id is given', () => {
    const script = scriptForSession('ABCD-1234', 'write text "ls"');
    expect(script).toContain('if unique id of s is "ABCD-1234"');
    expect(script).toContain('write text "ls"');
    expect(script).not.toContain('current session');
  });

  test('rejects ids that could break out of the script', () => {
    expect(() => scriptForSession('x" & (do shell script "rm")', 'get tty')).toThrow(/Invalid iTerm session id/);
    expect(() => assertValidSessionId("it's")).toThrow();
  });

  test('osascriptCommand wraps the script for the shell', () => {
    expect(osascriptCommand('tell application "iTerm2" to activate')).toBe(`/usr/bin/osascript -e 'tell application "iTerm2" to activate'`);
  });
});
