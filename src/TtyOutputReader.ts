import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { scriptForSession, osascriptCommand } from './ItermScript.js';

const execPromise = promisify(exec);

export default class TtyOutputReader {
  static async call(linesOfOutput?: number, sessionId?: string) {
    const buffer = await this.retrieveBuffer(sessionId);
    if (!linesOfOutput) {
      return buffer;
    }
    const lines = buffer.split('\n');
    return lines.slice(-linesOfOutput - 1).join('\n');
  }

  /**
   * Returns the full scrollback contents of a session.
   * @param sessionId iTerm session `unique id`; defaults to the focused session
   */
  static async retrieveBuffer(sessionId?: string): Promise<string> {
    const script = scriptForSession(sessionId, 'return (get contents)');
    const { stdout: finalContent } = await execPromise(osascriptCommand(script));
    return finalContent.trim();
  }
}
