import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fromPartial } from '@total-typescript/shoehorn';
import type { Bindings } from '../../env';
import type { RunStepInput } from './runner';

const mocks = vi.hoisted(() => ({ getSandbox: vi.fn() }));

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: mocks.getSandbox }));

import { SandboxRunner } from './sandbox';

describe('SandboxRunner', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns separate inline logs and creates a lineage backup', async () => {
    const sandbox = fakeSandbox();
    mocks.getSandbox.mockReturnValue(sandbox);

    const result = await runner().run({ ...input, cwd: 'apps/example' });

    expect(result).toEqual({
      exitCode: 0,
      logs: { stdout: 'stdout', stderr: 'stderr' },
      preview: { stdout: 'stdout tail', stderr: 'stderr tail' },
      snapshot: { id: 'backup-1', dir: '/workspace' },
    });
    expect(sandbox.startProcess).toHaveBeenCalledWith(expect.any(String), {
      cwd: '/workspace/apps/example',
      env: { CI: 'true' },
      autoCleanup: false,
    });
    expect(sandbox.createBackup).toHaveBeenCalledOnce();
    expect(sandbox.createBackup).toHaveBeenCalledWith(
      expect.objectContaining({ localBucket: false })
    );
    expect(mocks.getSandbox).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ transport: 'rpc' })
    );
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  it('uses the localBucket path when FUSE is unavailable', async () => {
    const sandbox = fakeSandbox({ hasFuse: false });
    mocks.getSandbox.mockReturnValue(sandbox);

    await runner().run(input);

    expect(sandbox.exec).toHaveBeenNthCalledWith(1, 'test -c /dev/fuse');
    expect(sandbox.createBackup).toHaveBeenCalledWith(
      expect.objectContaining({ localBucket: true })
    );
    expect(mocks.getSandbox).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ transport: 'rpc' })
    );
  });

  it('restores a snapshot before overlaying the current source', async () => {
    const sandbox = fakeSandbox();
    mocks.getSandbox.mockReturnValue(sandbox);
    const restore = { id: 'previous-backup', dir: '/workspace' };

    await runner().run({ ...input, restore });

    expect(sandbox.exec).toHaveBeenNthCalledWith(1, 'test -c /dev/fuse');
    expect(sandbox.restoreBackup).toHaveBeenCalledWith(restore);
    expect(sandbox.restoreBackup.mock.invocationCallOrder[0]).toBeLessThan(
      sandbox.exec.mock.invocationCallOrder[1]!
    );
    expect(sandbox.exec).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/^mkdir -p/),
      expect.objectContaining({ cwd: '/' })
    );
  });

  it('rejects a cwd outside the workspace', async () => {
    const sandbox = fakeSandbox();
    mocks.getSandbox.mockReturnValue(sandbox);

    await expect(runner().run({ ...input, cwd: '../outside' })).rejects.toThrow(
      'cwd must be inside /workspace'
    );
    expect(sandbox.startProcess).not.toHaveBeenCalled();
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  it('does not create a backup for failed commands', async () => {
    const sandbox = fakeSandbox({ exitCode: 1 });
    mocks.getSandbox.mockReturnValue(sandbox);

    const result = await runner().run(input);

    expect(result).toMatchObject({
      exitCode: 1,
      logs: { stdout: 'stdout tail', stderr: 'stderr tail' },
    });
    expect(result).not.toHaveProperty('snapshot');
    expect(sandbox.createBackup).not.toHaveBeenCalled();
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  it('returns the tail of an oversized log with a truncation marker', async () => {
    const sandbox = fakeSandbox({ largeStdout: true });
    mocks.getSandbox.mockReturnValue(sandbox);

    const result = await runner().run(input);

    expect(result.logs).toEqual({
      stdout:
        '[log truncated: showing last 300000 of 500000 bytes]\nstdout end',
      stderr: 'stderr',
    });
    expect(sandbox.readFileStream).not.toHaveBeenCalled();
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  it('bounds log reads in the shell and skips symlinked logs', async () => {
    // A listing size describes a symlink, not its target, and the step can
    // replace its log before exiting. Run the real read against local files.
    const dir = mkdtempSync(join(tmpdir(), 'ci-logs-'));
    try {
      writeFileSync(join(dir, 'secret'), 'not a log');
      symlinkSync(join(dir, 'secret'), join(dir, 'ci-step.out'));
      writeFileSync(join(dir, 'ci-step.err'), `${'x'.repeat(400_000)}end`);
      const sandbox = fakeSandbox();
      sandbox.exec.mockImplementation((command: string) =>
        Promise.resolve({
          exitCode: 0,
          stdout: command.includes('wc -c')
            ? execFileSync(
                'sh',
                ['-c', command.replaceAll('/tmp/ci-step.', `${dir}/ci-step.`)],
                { encoding: 'utf8' }
              )
            : '',
        })
      );
      mocks.getSandbox.mockReturnValue(sandbox);

      const result = await runner().run(input);

      expect(result.logs.stdout).toBe('');
      const stderr = result.logs.stderr as string;
      expect(stderr).toMatch(
        /^\[log truncated: showing last 300000 of 400003 bytes\]\nx+end$/
      );
      expect(stderr.length).toBeLessThan(300_100);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function runner() {
  return new SandboxRunner(fromPartial<Bindings>({ SANDBOX: {} }));
}

function fakeSandbox(options?: {
  exitCode?: number;
  hasFuse?: boolean;
  largeStdout?: boolean;
}) {
  return {
    restoreBackup: vi.fn().mockResolvedValue(undefined),
    exec: vi.fn().mockImplementation((command: string) => {
      if (command === 'test -c /dev/fuse') {
        return Promise.resolve({
          stdout: '',
          exitCode: options?.hasFuse === false ? 1 : 0,
        });
      }
      if (command.includes('wc -c')) {
        const out = command.includes('/tmp/ci-step.out');
        if (out && options?.largeStdout) {
          return Promise.resolve({ stdout: '500000\nstdout end' });
        }
        return Promise.resolve({ stdout: out ? '6\nstdout' : '6\nstderr' });
      }
      if (command.includes('/tmp/ci-step.out')) {
        return Promise.resolve({ stdout: 'stdout tail' });
      }
      if (command.includes('/tmp/ci-step.err')) {
        return Promise.resolve({ stdout: 'stderr tail' });
      }
      return Promise.resolve({ stdout: '', exitCode: 0 });
    }),
    startProcess: vi.fn().mockResolvedValue({
      waitForExit: vi
        .fn()
        .mockResolvedValue({ exitCode: options?.exitCode ?? 0 }),
    }),
    createBackup: vi
      .fn()
      .mockResolvedValue({ id: 'backup-1', dir: '/workspace' }),
    readFileStream: vi.fn(),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
}

const input = {
  label: 'test',
  command: 'pnpm test',
  source: { kind: 'archive', url: 'https://example.com/source.tar.gz' },
} satisfies RunStepInput;
