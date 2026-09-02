// @ts-nocheck
import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import SessionSelector, { SessionResolutionError } from '../../src/SessionSelector.js';

function session(overrides) {
  return {
    id: 'ID', windowIndex: 1, tabIndex: 1, tty: '/dev/ttys000', name: 'n',
    isProcessing: false, jobName: 'zsh', commandLine: '-zsh', isCurrent: false,
    foregroundChain: ['zsh'], kind: 'local-shell', reason: 'zsh prompt',
    ...overrides,
  };
}

function selectorWith(sessions, options = {}) {
  const inspector = {
    listSessions: async () => sessions,
    openNewSession: async () => { throw new Error('openNewSession not expected'); },
  };
  return new SessionSelector(inspector as any, { autoOpenNewTab: false, sleep: async () => {}, ...options });
}

/**
 * Inspector whose openNewSession appends a tab that first looks like a
 * starting shell (no job, processing) and settles into an idle local shell
 * on the next listing, like real iTerm does.
 */
function selectorWithOpenableTabs(sessions, options = {}) {
  let listings = 0;
  let pending = null;
  const inspector = {
    listSessions: async () => {
      listings++;
      if (pending && listings > pending.settleAfter) {
        Object.assign(pending.session, { kind: 'local-shell', isProcessing: false, jobName: 'zsh', commandLine: '-zsh' });
        pending = null;
      }
      return sessions;
    },
    openNewSession: async () => {
      const fresh = session({ id: 'NEW-TAB', kind: 'unknown', isProcessing: true, jobName: '', commandLine: '', isCurrent: true });
      sessions.forEach(s => { s.isCurrent = false; });
      sessions.push(fresh);
      pending = { session: fresh, settleAfter: listings + 1 };
      return 'NEW-TAB';
    },
  };
  const selector = new SessionSelector(inspector as any, { sleep: async () => {}, ...options });
  return { selector, inspector };
}

describe('SessionSelector', () => {
  const savedEnv = process.env.ITERM_MCP_ALLOW_REMOTE;
  beforeEach(() => { delete process.env.ITERM_MCP_ALLOW_REMOTE; });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.ITERM_MCP_ALLOW_REMOTE;
    else process.env.ITERM_MCP_ALLOW_REMOTE = savedEnv;
  });

  test('uses the focused session when it is an idle local shell', async () => {
    const sel = selectorWith([
      session({ id: 'A' }),
      session({ id: 'B', isCurrent: true }),
    ]);
    const chosen = await sel.resolve({ forWrite: true });
    expect(chosen.id).toBe('B');
    expect(sel.pinnedSessionId).toBe('B');
  });

  test('skips a focused ssh session and picks another local shell', async () => {
    const sel = selectorWith([
      session({ id: 'SSH', isCurrent: true, kind: 'remote', jobName: 'ssh', commandLine: 'ssh box', reason: 'ssh box' }),
      session({ id: 'LOCAL', windowIndex: 2 }),
    ]);
    const chosen = await sel.resolve({ forWrite: true });
    expect(chosen.id).toBe('LOCAL');
  });

  test('prefers an idle local shell over a processing one', async () => {
    const sel = selectorWith([
      session({ id: 'BUSYSHELL', isCurrent: true, isProcessing: true }),
      session({ id: 'IDLE' }),
    ]);
    expect((await sel.resolve({ forWrite: true })).id).toBe('IDLE');
  });

  test('refuses when nothing local is available and auto-open is off', async () => {
    const sel = selectorWith([
      session({ id: 'SSH', isCurrent: true, kind: 'remote', commandLine: 'ssh box' }),
      session({ id: 'TMUX', kind: 'multiplexer', commandLine: 'tmux' }),
    ]);
    await expect(sel.resolve({ forWrite: true })).rejects.toThrow(SessionResolutionError);
    await expect(sel.resolve({ forWrite: true })).rejects.toThrow(/No local shell session/);
    await expect(sel.resolve({ forWrite: true })).rejects.toThrow(/open_terminal_session/);
    await expect(sel.resolve({ forWrite: true })).rejects.toThrow(/SSH/);
    expect(sel.pinnedSessionId).toBeNull();
  });

  test('opens a new tab when nothing local is available and auto-open is on', async () => {
    const { selector } = selectorWithOpenableTabs([
      session({ id: 'SSH', isCurrent: true, kind: 'remote', commandLine: 'ssh box' }),
    ]);
    const chosen = await selector.resolve({ forWrite: true });
    expect(chosen.id).toBe('NEW-TAB');
    expect(chosen.kind).toBe('local-shell');
    expect(chosen.isProcessing).toBe(false);
    expect(selector.pinnedSessionId).toBe('NEW-TAB');
  });

  test('auto-open follows ITERM_MCP_AUTO_NEW_TAB', async () => {
    process.env.ITERM_MCP_AUTO_NEW_TAB = '0';
    const inspector = { listSessions: async () => [], openNewSession: async () => 'X' };
    await expect(new SessionSelector(inspector as any, { sleep: async () => {} }).resolve({ forWrite: true }))
      .rejects.toThrow(/No iTerm2 sessions found/);
    delete process.env.ITERM_MCP_AUTO_NEW_TAB;
  });

  test('does not open a tab when a local shell exists', async () => {
    const { selector, inspector } = selectorWithOpenableTabs([session({ id: 'LOCAL' })]);
    expect((await selector.resolve({ forWrite: true })).id).toBe('LOCAL');
  });

  test('openNewSession can be called explicitly and re-pins', async () => {
    const { selector } = selectorWithOpenableTabs([session({ id: 'LOCAL', isCurrent: true })]);
    expect((await selector.resolve({ forWrite: true })).id).toBe('LOCAL');
    const fresh = await selector.openNewSession();
    expect(fresh.id).toBe('NEW-TAB');
    expect(selector.pinnedSessionId).toBe('NEW-TAB');
    expect((await selector.resolve({ forWrite: true })).id).toBe('NEW-TAB');
  });

  test('openNewSession gives up waiting but still pins a tab that never settles', async () => {
    const sessions = [];
    const inspector = {
      listSessions: async () => sessions,
      openNewSession: async () => {
        sessions.push(session({ id: 'SLOW', kind: 'unknown', isProcessing: true, jobName: '', commandLine: '' }));
        return 'SLOW';
      },
    };
    const sel = new SessionSelector(inspector as any, { sleep: async () => {} });
    const s = await sel.openNewSession();
    expect(s.id).toBe('SLOW');
    expect(sel.pinnedSessionId).toBe('SLOW');
  });

  test('openNewSession errors when the new tab never appears', async () => {
    const inspector = { listSessions: async () => [], openNewSession: async () => 'GHOST' };
    const sel = new SessionSelector(inspector as any, { sleep: async () => {} });
    await expect(sel.openNewSession()).rejects.toThrow(/did not show up/);
  });

  test('keeps the pinned session when the user focuses another tab', async () => {
    const sessions = [
      session({ id: 'A', isCurrent: true }),
      session({ id: 'B' }),
    ];
    const sel = selectorWith(sessions);
    expect((await sel.resolve({ forWrite: true })).id).toBe('A');

    sessions[0].isCurrent = false;
    sessions[1].isCurrent = true;
    expect((await sel.resolve({ forWrite: true })).id).toBe('A');
  });

  test('re-selects when the pinned session disappears', async () => {
    const sessions = [session({ id: 'A', isCurrent: true }), session({ id: 'B' })];
    const sel = selectorWith(sessions);
    await sel.resolve({ forWrite: true });
    sessions.shift();
    expect((await sel.resolve({ forWrite: true })).id).toBe('B');
    expect(sel.pinnedSessionId).toBe('B');
  });

  test('refuses to write to the pinned session once it runs ssh', async () => {
    const sessions = [session({ id: 'A', isCurrent: true })];
    const sel = selectorWith(sessions);
    await sel.resolve({ forWrite: true });

    sessions[0].kind = 'remote';
    sessions[0].commandLine = 'ssh box';
    sessions[0].reason = 'ssh box is in the foreground';
    await expect(sel.resolve({ forWrite: true })).rejects.toThrow(/Refusing to write/);
    // Reading is still fine
    expect((await sel.resolve({ forWrite: false })).id).toBe('A');
    // And writing on purpose is fine
    expect((await sel.resolve({ forWrite: true, allowRemote: true })).id).toBe('A');
  });

  test('explicit sessionId wins and re-pins, refusing remote unless allowed', async () => {
    const sel = selectorWith([
      session({ id: 'A', isCurrent: true }),
      session({ id: 'SSH-1234', kind: 'remote', commandLine: 'ssh box', reason: 'ssh' }),
    ]);
    await sel.resolve({ forWrite: true });
    await expect(sel.resolve({ forWrite: true, sessionId: 'SSH-1234' })).rejects.toThrow(/Refusing to write/);
    expect(sel.pinnedSessionId).toBe('A');

    const chosen = await sel.resolve({ forWrite: true, sessionId: 'SSH-1234', allowRemote: true });
    expect(chosen.id).toBe('SSH-1234');
    expect(sel.pinnedSessionId).toBe('SSH-1234');
  });

  test('explicit sessionId accepts the short prefix shown in listings', async () => {
    const sel = selectorWith([session({ id: 'ABCD1234-EF00' }), session({ id: 'FFFF-1' })]);
    expect((await sel.resolve({ forWrite: false, sessionId: 'abcd1234' })).id).toBe('ABCD1234-EF00');
  });

  test('unknown sessionId is an error that lists sessions', async () => {
    const sel = selectorWith([session({ id: 'A' })]);
    await expect(sel.resolve({ forWrite: false, sessionId: 'NOPE' })).rejects.toThrow(/not found[\s\S]*- A/);
  });

  test('ITERM_MCP_ALLOW_REMOTE=1 disables the remote guard', async () => {
    process.env.ITERM_MCP_ALLOW_REMOTE = '1';
    const sel = selectorWith([session({ id: 'SSH', kind: 'remote', commandLine: 'ssh box' })]);
    expect((await sel.resolve({ forWrite: true, sessionId: 'SSH' })).id).toBe('SSH');
  });

  test('busy sessions are not auto-selected but can be targeted explicitly', async () => {
    const sel = selectorWith([
      session({ id: 'VIM', isCurrent: true, kind: 'busy', commandLine: 'vim x' }),
      session({ id: 'LOCAL' }),
    ]);
    expect((await sel.resolve({ forWrite: true })).id).toBe('LOCAL');
    expect((await sel.resolve({ forWrite: true, sessionId: 'VIM' })).id).toBe('VIM');
  });

  test('no sessions at all is an error when auto-open is off', async () => {
    await expect(selectorWith([]).resolve({ forWrite: false })).rejects.toThrow(/No iTerm2 sessions/);
  });

  test('no sessions at all opens a window when auto-open is on', async () => {
    const { selector } = selectorWithOpenableTabs([]);
    expect((await selector.resolve({ forWrite: false })).id).toBe('NEW-TAB');
  });
});
