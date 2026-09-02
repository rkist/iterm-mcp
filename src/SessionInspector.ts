import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { basename } from 'node:path';
import { osascriptCommand } from './ItermScript.js';

const execPromise = promisify(exec);
type ExecPromise = typeof execPromise;

/**
 * What a session is currently doing, from the point of view of "is it safe to
 * type a shell command into it and have it run on this Mac?".
 *
 * - local-shell: a shell prompt on this machine. Safe target.
 * - remote:      ssh / mosh / telnet etc. Typing here runs on another host.
 * - container:   docker/kubectl/podman exec. Typing here runs in a container.
 * - multiplexer: tmux/screen/zellij client. We cannot see inside; there may
 *                be an ssh in a pane.
 * - busy:        some other foreground program (vim, a REPL, a build...).
 * - unknown:     could not determine (no job info and ps failed).
 */
export type SessionKind = 'local-shell' | 'remote' | 'container' | 'multiplexer' | 'busy' | 'unknown';

export interface ItermSession {
  id: string;
  windowIndex: number;
  tabIndex: number;
  tty: string;
  name: string;
  isProcessing: boolean;
  /** iTerm's `session.jobName`: name of the foreground job on the local tty. */
  jobName: string;
  /** iTerm's `session.commandLine`: full command line of that job. */
  commandLine: string;
  /** True for the focused session of the front window. */
  isCurrent: boolean;
  /** Foreground process names on the tty as reported by `ps`, parent first. */
  foregroundChain: string[];
  kind: SessionKind;
  /** Short human explanation of the classification. */
  reason: string;
}

const SHELLS = new Set(['bash', 'zsh', 'sh', 'fish', 'csh', 'tcsh', 'ksh', 'dash', 'nu', 'xonsh']);
const REMOTE = new Set(['ssh', 'mosh', 'mosh-client', 'et', 'autossh', 'telnet', 'rlogin', 'sshpass']);
const CONTAINER_TOOLS = new Set(['docker', 'kubectl', 'podman', 'nerdctl', 'limactl', 'oc', 'k9s', 'devcontainer']);
const CONTAINER_SUBCOMMANDS = new Set(['exec', 'attach', 'run', 'debug', 'shell', 'ssh']);
const MULTIPLEXERS = new Set(['tmux', 'screen', 'zellij', 'byobu']);
const IGNORED = new Set(['login', 'ps', 'script']);

const UNIT_SEPARATOR = '\u001f';

function normalizeName(token: string): string {
  // Strip a login-shell dash prefix ("-zsh") and take the basename.
  return basename(token.replace(/^-/, ''));
}

/**
 * Pure classification so it can be unit tested without iTerm or ps.
 */
export function classifySession(
  jobName: string,
  commandLine: string,
  foregroundChain: string[]
): { kind: SessionKind; reason: string } {
  const job = normalizeName(jobName || '');
  const cmdTokens = (commandLine || '').trim().split(/\s+/).filter(Boolean).map((t, i) => (i === 0 ? normalizeName(t) : t));
  const candidates = [job, ...foregroundChain.map(normalizeName)].filter(n => n && !IGNORED.has(n));

  for (const name of candidates) {
    if (REMOTE.has(name)) {
      return { kind: 'remote', reason: `${commandLine || name} is in the foreground; input goes to a remote host` };
    }
  }

  for (const name of candidates) {
    if (CONTAINER_TOOLS.has(name)) {
      const sub = cmdTokens[0] === name ? cmdTokens.find((t, i) => i > 0 && CONTAINER_SUBCOMMANDS.has(t)) : undefined;
      if (sub || name === 'k9s' || name === 'devcontainer') {
        return { kind: 'container', reason: `${commandLine || name} is in the foreground; input goes to a container` };
      }
    }
  }

  for (const name of candidates) {
    if (MULTIPLEXERS.has(name)) {
      return { kind: 'multiplexer', reason: `${name} is in the foreground; cannot see what runs inside its panes` };
    }
  }

  if (candidates.length === 0) {
    return { kind: 'unknown', reason: 'no foreground job information available' };
  }

  if (candidates.every(n => SHELLS.has(n))) {
    return { kind: 'local-shell', reason: `${job || candidates[0]} prompt on this machine` };
  }

  const program = candidates.find(n => !SHELLS.has(n)) ?? candidates[0];
  return { kind: 'busy', reason: `${commandLine || program} is in the foreground` };
}

/**
 * Lists iTerm2 sessions and classifies each one.
 */
export default class SessionInspector {
  private _exec: ExecPromise;

  constructor(execOverride?: ExecPromise) {
    this._exec = execOverride || execPromise;
  }

  async listSessions(): Promise<ItermSession[]> {
    const script = `
tell application "iTerm2"
  set US to ASCII character 31
  set currentId to ""
  try
    set currentId to unique id of current session of current window
  end try
  set out to ""
  set wi to 0
  repeat with w in windows
    set wi to wi + 1
    set ti to 0
    repeat with t in tabs of w
      set ti to ti + 1
      repeat with s in sessions of t
        tell s
          set sid to unique id
          set jn to ""
          try
            set jn to variable named "session.jobName"
          end try
          if jn is missing value then set jn to ""
          set cl to ""
          try
            set cl to variable named "session.commandLine"
          end try
          if cl is missing value then set cl to ""
          set out to out & wi & US & ti & US & sid & US & (tty) & US & (name) & US & (is processing) & US & jn & US & cl & US & (sid is currentId) & linefeed
        end tell
      end repeat
    end repeat
  end repeat
  return out
end tell`;

    const { stdout } = await this._exec(osascriptCommand(script));
    const rows = stdout.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.length > 0);

    const sessions: ItermSession[] = [];
    for (const row of rows) {
      const f = row.split(UNIT_SEPARATOR);
      if (f.length < 9) continue;
      const tty = f[3].trim();
      const foregroundChain = await this.foregroundProcesses(tty);
      const jobName = f[6].trim();
      const commandLine = f[7].trim();
      const { kind, reason } = classifySession(jobName, commandLine, foregroundChain);
      sessions.push({
        windowIndex: parseInt(f[0], 10),
        tabIndex: parseInt(f[1], 10),
        id: f[2].trim(),
        tty,
        name: f[4],
        isProcessing: f[5].trim() === 'true',
        jobName,
        commandLine,
        isCurrent: f[8].trim() === 'true',
        foregroundChain,
        kind,
        reason,
      });
    }
    return sessions;
  }

  /**
   * Opens a new tab in the front iTerm window (or a new window if there is
   * none) with the default profile and returns the new session's unique id.
   * The shell inside it takes a moment to start; callers should re-list.
   */
  async openNewSession(): Promise<string> {
    const script = `
tell application "iTerm2"
  if (count of windows) is 0 then
    set w to (create window with default profile)
    tell w to tell current session to return unique id
  else
    tell current window
      set t to (create tab with default profile)
      tell t to tell current session to return unique id
    end tell
  end if
end tell`;
    const { stdout } = await this._exec(osascriptCommand(script));
    const id = stdout.trim();
    if (!id) throw new Error('iTerm2 did not return a session id for the new tab');
    return id;
  }

  /**
   * Names of the processes in the foreground process group of a tty
   * (those `ps` marks with `+`), parent first. Empty if ps fails.
   */
  private async foregroundProcesses(ttyPath: string): Promise<string[]> {
    const ttyName = basename(ttyPath);
    if (!/^ttys?\d+$/.test(ttyName)) return [];
    try {
      const { stdout } = await this._exec(`ps -t ${ttyName} -o pid=,ppid=,pgid=,state=,command= -w`);
      const rows = stdout.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
        const parts = l.split(/\s+/);
        return { pid: parts[0], ppid: parts[1], pgid: parts[2], state: parts[3], command: parts.slice(4).join(' ') };
      });
      const foreground = rows.filter(r => r.state.includes('+'));
      // Order parent -> child so the chain reads naturally.
      const byPid = new Map(rows.map(r => [r.pid, r]));
      foreground.sort((a, b) => depth(a) - depth(b));
      function depth(r: { ppid: string }): number {
        let d = 0;
        let cur = byPid.get(r.ppid);
        while (cur && d < 20) { d++; cur = byPid.get(cur.ppid); }
        return d;
      }
      return foreground.map(r => normalizeName(r.command.split(/\s+/)[0]));
    } catch {
      return [];
    }
  }
}
