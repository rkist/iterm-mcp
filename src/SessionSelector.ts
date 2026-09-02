import SessionInspector, { ItermSession, SessionKind } from './SessionInspector.js';

export interface ResolveOptions {
  /** Explicit session to use. Re-pins the selector to it. */
  sessionId?: string;
  /** Permit writing into remote/container sessions. */
  allowRemote?: boolean;
  /** True when the caller is about to send input (stricter checks). */
  forWrite: boolean;
}

export interface SessionSelectorOptions {
  /**
   * Open a new local tab when no local shell session is available.
   * Defaults to true unless ITERM_MCP_AUTO_NEW_TAB=0.
   */
  autoOpenNewTab?: boolean;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const WRITE_GUARDED: ReadonlySet<SessionKind> = new Set<SessionKind>(['remote', 'container']);
const NEW_SESSION_POLL_MS = 250;
const NEW_SESSION_MAX_POLLS = 20; // 5 seconds

export class SessionResolutionError extends Error {
  constructor(message: string, public readonly sessions: ItermSession[]) {
    super(message);
    this.name = 'SessionResolutionError';
  }
}

/**
 * Decides which iTerm session the tools operate on.
 *
 * Policy:
 *  1. An explicit `sessionId` always wins and becomes the pinned session.
 *  2. Otherwise the pinned session is reused while it still exists, so the
 *     target does not drift when the user clicks on other tabs.
 *  3. Otherwise pick a local shell: the focused one if it qualifies, then
 *     idle local shells in front-to-back window order.
 *  4. If there is no local shell at all, open a new tab (unless disabled)
 *     and pin it.
 *  5. Writing into a remote/container session requires `allowRemote`
 *     (or ITERM_MCP_ALLOW_REMOTE=1) so commands never silently land on
 *     another machine.
 */
export default class SessionSelector {
  private pinnedId: string | null = null;
  private autoOpenNewTab: boolean;
  private sleep: (ms: number) => Promise<void>;

  constructor(private inspector: SessionInspector = new SessionInspector(), options: SessionSelectorOptions = {}) {
    this.autoOpenNewTab = options.autoOpenNewTab ?? process.env.ITERM_MCP_AUTO_NEW_TAB !== '0';
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  get pinnedSessionId(): string | null {
    return this.pinnedId;
  }

  reset(): void {
    this.pinnedId = null;
  }

  async listSessions(): Promise<ItermSession[]> {
    return this.inspector.listSessions();
  }

  async resolve(opts: ResolveOptions): Promise<ItermSession> {
    const sessions = await this.inspector.listSessions();
    const allowRemote = opts.allowRemote === true || process.env.ITERM_MCP_ALLOW_REMOTE === '1';

    if (opts.sessionId) {
      const explicit = sessions.find(s => s.id === opts.sessionId || s.id.startsWith(opts.sessionId!.toUpperCase()));
      if (!explicit) {
        throw new SessionResolutionError(
          `iTerm session ${opts.sessionId} not found.\n\n${formatSessionList(sessions, null)}`,
          sessions
        );
      }
      this.guardWrite(explicit, opts.forWrite, allowRemote, sessions, true);
      this.pinnedId = explicit.id;
      return explicit;
    }

    if (this.pinnedId) {
      const pinned = sessions.find(s => s.id === this.pinnedId);
      if (pinned) {
        this.guardWrite(pinned, opts.forWrite, allowRemote, sessions, false);
        return pinned;
      }
      // Pinned session is gone (tab closed). Fall through to auto-select.
      this.pinnedId = null;
    }

    const chosen = pickLocalShell(sessions);
    if (chosen) {
      this.pinnedId = chosen.id;
      return chosen;
    }

    if (this.autoOpenNewTab) {
      return this.openNewSession();
    }

    const hint = sessions.length === 0
      ? 'No iTerm2 sessions found. Is iTerm2 running with at least one window?'
      : 'The focused session and all others are remote, in a container, in a multiplexer, or busy.';
    throw new SessionResolutionError(
      `No local shell session is available to target.\n${hint}\n` +
      `Options: call open_terminal_session to create a fresh local tab; or call again with sessionId ` +
      `(add allowRemote: true to deliberately target a remote/container session).\n\n` +
      formatSessionList(sessions, null),
      sessions
    );
  }

  /**
   * Opens a new local tab, waits for its shell to come up, pins it and
   * returns it.
   */
  async openNewSession(): Promise<ItermSession> {
    const id = await this.inspector.openNewSession();

    let seen: ItermSession | undefined;
    for (let i = 0; i < NEW_SESSION_MAX_POLLS; i++) {
      const sessions = await this.inspector.listSessions();
      seen = sessions.find(s => s.id === id);
      if (seen && seen.kind === 'local-shell' && !seen.isProcessing) break;
      await this.sleep(NEW_SESSION_POLL_MS);
    }

    if (!seen) {
      throw new SessionResolutionError(
        `Opened a new iTerm tab (${id}) but it did not show up in the session list.`,
        await this.inspector.listSessions()
      );
    }

    this.pinnedId = seen.id;
    return seen;
  }

  private guardWrite(
    session: ItermSession,
    forWrite: boolean,
    allowRemote: boolean,
    sessions: ItermSession[],
    explicit: boolean
  ): void {
    if (!forWrite || allowRemote || !WRITE_GUARDED.has(session.kind)) return;
    const how = explicit ? 'The requested session' : 'The session this server is pinned to';
    throw new SessionResolutionError(
      `Refusing to write: ${how} (${shortId(session.id)}, ${session.tty}) is ${session.kind}: ${session.reason}.\n` +
      `Commands typed here would run on another machine.\n` +
      `Either pass allowRemote: true to do this on purpose, pass sessionId of a local session, ` +
      `or call open_terminal_session for a fresh local tab.\n\n` +
      formatSessionList(sessions, this.pinnedId),
      sessions
    );
  }
}

function pickLocalShell(sessions: ItermSession[]): ItermSession | undefined {
  const local = sessions.filter(s => s.kind === 'local-shell');
  const current = local.find(s => s.isCurrent);
  if (current && !current.isProcessing) return current;
  // `sessions` is in front-to-back window order, tab order within a window.
  return local.find(s => !s.isProcessing) ?? current ?? local[0];
}

export function shortId(id: string): string {
  return id.split('-')[0];
}

export function describeSession(s: ItermSession): string {
  const job = s.commandLine || s.jobName || '?';
  const state = s.isProcessing ? 'processing' : 'idle';
  return `${shortId(s.id)} · window ${s.windowIndex} tab ${s.tabIndex} · ${s.tty} · ${s.kind} · ${job} · ${state}`;
}

export function formatSessionList(sessions: ItermSession[], pinnedId: string | null): string {
  if (sessions.length === 0) return 'iTerm sessions (0)';
  const lines = sessions.map(s => {
    const marks: string[] = [];
    if (s.id === pinnedId) marks.push('target');
    if (s.isCurrent) marks.push('focused');
    const mark = marks.length ? ` (${marks.join(', ')})` : '';
    return `- ${s.id}${mark}\n    ${describeSession(s)}\n    ${s.reason}`;
  });
  return `iTerm sessions (${sessions.length}):\n${lines.join('\n')}`;
}
