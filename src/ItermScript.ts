/**
 * Helpers for building AppleScript that targets a specific iTerm2 session.
 *
 * iTerm2 exposes a stable `unique id` per session, but it cannot be addressed
 * directly with `session id "..."`. Instead we walk windows/tabs/sessions and
 * match on `unique id`. This is independent of which tab the user has focused,
 * so the target does not drift when they click around.
 */

const SESSION_ID_PATTERN = /^[A-Za-z0-9-]+$/;

export function assertValidSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`Invalid iTerm session id: ${sessionId}`);
  }
}

/**
 * Wraps `body` in a `tell` block addressing the given session. When no
 * sessionId is given, falls back to the focused session of the front window
 * (the historical behaviour of this server).
 *
 * `body` is AppleScript that runs inside `tell <session> ... end tell`.
 */
export function scriptForSession(sessionId: string | undefined, body: string): string {
  if (!sessionId) {
    return `tell application "iTerm2"
  tell current session of current window
    ${body}
  end tell
end tell`;
  }

  assertValidSessionId(sessionId);

  return `tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if unique id of s is "${sessionId}" then
          tell s
            ${body}
          end tell
          return
        end if
      end repeat
    end repeat
  end repeat
  error "iTerm session ${sessionId} not found"
end tell`;
}

/**
 * Quotes a full AppleScript program for use as `osascript -e '<script>'`.
 * The script must not itself contain unescaped single quotes; callers that
 * embed user text are responsible for escaping it (see CommandExecutor).
 */
export function osascriptCommand(script: string): string {
  return `/usr/bin/osascript -e '${script}'`;
}
