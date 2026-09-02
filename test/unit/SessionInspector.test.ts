// @ts-nocheck
import { describe, expect, test } from '@jest/globals';
import SessionInspector, { classifySession } from '../../src/SessionInspector.js';

describe('classifySession', () => {
  test('idle zsh prompt is a local shell', () => {
    expect(classifySession('zsh', '-zsh', ['zsh']).kind).toBe('local-shell');
  });

  test('bash login shell with dash prefix is a local shell', () => {
    expect(classifySession('bash', '-bash', ['-bash']).kind).toBe('local-shell');
  });

  test('ssh in the foreground is remote', () => {
    const result = classifySession('ssh', 'ssh wyse-vpn', ['ssh']);
    expect(result.kind).toBe('remote');
    expect(result.reason).toContain('ssh wyse-vpn');
  });

  test('ssh detected from ps even when iTerm reports a wrapper job', () => {
    // e.g. a shell script that execs ssh; jobName still says the script
    expect(classifySession('connect.sh', './connect.sh prod', ['bash', 'ssh']).kind).toBe('remote');
  });

  test('mosh and telnet are remote', () => {
    expect(classifySession('mosh-client', 'mosh-client 10.0.0.1 60001', ['mosh-client']).kind).toBe('remote');
    expect(classifySession('telnet', 'telnet host 23', ['telnet']).kind).toBe('remote');
  });

  test('kubectl exec and docker exec are containers', () => {
    expect(classifySession('kubectl', 'kubectl exec -it pod -- bash', ['kubectl']).kind).toBe('container');
    expect(classifySession('docker', 'docker exec -it app sh', ['docker']).kind).toBe('container');
  });

  test('kubectl get pods is just busy, not a container shell', () => {
    expect(classifySession('kubectl', 'kubectl get pods -w', ['kubectl']).kind).toBe('busy');
  });

  test('tmux client is a multiplexer', () => {
    expect(classifySession('tmux', 'tmux attach', ['tmux']).kind).toBe('multiplexer');
  });

  test('vim in the foreground is busy', () => {
    expect(classifySession('vim', 'vim notes.md', ['vim']).kind).toBe('busy');
  });

  test('no information at all is unknown', () => {
    expect(classifySession('', '', []).kind).toBe('unknown');
  });

  test('login wrapper process is ignored', () => {
    expect(classifySession('zsh', '-zsh', ['login', 'zsh']).kind).toBe('local-shell');
  });
});

describe('SessionInspector.listSessions', () => {
  const US = '\u001f';
  const row = (fields: string[]) => fields.join(US);

  test('parses osascript output and classifies using ps', async () => {
    const exec = async (command: string) => {
      if (command.includes('osascript')) {
        return {
          stdout: [
            row(['1', '1', 'AAAA-1', '/dev/ttys012', '~ (-zsh)', 'false', 'zsh', '-zsh', 'false']),
            row(['1', '2', 'BBBB-2', '/dev/ttys000', 'apt (ssh)', 'true', 'ssh', 'ssh wyse-vpn', 'true']),
          ].join('\n') + '\n',
          stderr: '',
        };
      }
      if (command.includes('ps -t ttys012')) {
        return { stdout: ' 100 1 100 Ss login -fp raul\n 101 100 101 S+ -zsh\n', stderr: '' };
      }
      if (command.includes('ps -t ttys000')) {
        return { stdout: ' 200 1 200 Ss login -fp raul\n 201 200 201 S -zsh\n 202 201 202 S+ ssh wyse-vpn\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };

    const sessions = await new SessionInspector(exec as any).listSessions();

    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({
      id: 'AAAA-1', windowIndex: 1, tabIndex: 1, tty: '/dev/ttys012',
      isProcessing: false, isCurrent: false, kind: 'local-shell', foregroundChain: ['zsh'],
    });
    expect(sessions[1]).toMatchObject({
      id: 'BBBB-2', tabIndex: 2, isProcessing: true, isCurrent: true,
      kind: 'remote', commandLine: 'ssh wyse-vpn', foregroundChain: ['ssh'],
    });
  });

  test('falls back to iTerm job info when ps fails', async () => {
    const exec = async (command: string) => {
      if (command.includes('osascript')) {
        return { stdout: row(['1', '1', 'AAAA-1', '/dev/ttys012', 'x', 'false', 'ssh', 'ssh box', 'true']) + '\n', stderr: '' };
      }
      throw new Error('ps failed');
    };
    const [s] = await new SessionInspector(exec as any).listSessions();
    expect(s.kind).toBe('remote');
    expect(s.foregroundChain).toEqual([]);
  });
});
