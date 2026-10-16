// Copyright (c) 2026 Cloudflare, Inc.
// SPDX-License-Identifier: Apache-2.0

import { getSandbox, type DirectoryBackup } from '@cloudflare/sandbox';
import { posix } from 'node:path';
import type { Bindings } from '../../env';
import {
  checkoutSourceEnv,
  checkoutSourceScript,
} from '../../shared/source-checkout';
import { slugify } from '../../shared/slugify';
import type { RunStepInput, RunStepResult, Runner } from './runner';

// Sandbox implementation limits. Pipeline-facing command and Snapshot
// retention settings are supplied through RunnerConfig.
const WORKSPACE_DIR = '/workspace';
const STDOUT_FILE = '/tmp/ci-step.out';
const STDERR_FILE = '/tmp/ci-step.err';
const COMMAND_TIMEOUT_MS = 11 * 60 * 1000;
const SOURCE_TIMEOUT_MS = 5 * 60 * 1000;
const PORT_READY_TIMEOUT_MS = 60_000;
// Keep notification and failure previews bounded by slicing each stream to its
// tail in the sandbox, where command failures usually surface.
const TAIL_BYTES = 28_000;
// Two inline logs plus result metadata must remain below Workflows' 1 MiB limit.
const INLINE_LOG_BYTES = 300_000;

export class SandboxRunner implements Runner<DirectoryBackup> {
  readonly name = 'sandbox';

  constructor(private readonly env: Bindings) {}

  /**
   * Copies source, runs the command, and snapshots `/workspace` after a
   * successful exit. A restored Snapshot is overlaid with the current source.
   */
  async run(
    input: RunStepInput & { restore?: DirectoryBackup }
  ): Promise<RunStepResult<DirectoryBackup>> {
    // create the sandbox handle
    const sandbox = getSandbox(this.env.SANDBOX, createRunnerId(input.label), {
      transport: 'rpc',
      enableDefaultSession: false,
      containerTimeouts: { portReadyTimeoutMS: PORT_READY_TIMEOUT_MS },
    });

    try {
      // Containers without FUSE must restore through the local R2 binding and
      // unsquashfs. RPC streams those archives instead of base64-encoding them
      // into a single request, which can exceed the local dev request limit.
      const localBucket =
        (await sandbox.exec('test -c /dev/fuse')).exitCode !== 0;
      if (input.restore) {
        await sandbox.restoreBackup(input.restore);
        // Overlay (no rm) so cached node_modules survive while tracked source
        // files are refreshed to this commit. The restored archive may carry a
        // different commit's source (e.g. a reused install cache), so this is
        // what keeps it correct. Files deleted since then linger; the next
        // install/build regenerates derived output.
        await sandbox.exec(
          checkoutSourceScript(input.source, WORKSPACE_DIR, true),
          {
            cwd: '/',
            timeout: SOURCE_TIMEOUT_MS,
            env: checkoutSourceEnv(input.source),
          }
        );
      } else {
        await sandbox.exec(checkoutSourceScript(input.source, WORKSPACE_DIR), {
          cwd: '/',
          timeout: SOURCE_TIMEOUT_MS,
          env: checkoutSourceEnv(input.source),
        });
      }

      const proc = await sandbox.startProcess(
        `(${input.command}) > ${STDOUT_FILE} 2> ${STDERR_FILE}`,
        {
          cwd: resolveCwd(input.cwd),
          env: {
            CI: 'true',
            ...input.extraEnv,
          },
          autoCleanup: false,
        }
      );
      const { exitCode } = await proc.waitForExit(
        input.timeoutMs ?? COMMAND_TIMEOUT_MS
      );
      const preview = await readPreviews(sandbox);

      if (exitCode !== 0) {
        return { exitCode, logs: preview, preview };
      }

      const snapshot = await sandbox.createBackup({
        dir: WORKSPACE_DIR,
        name: input.label,
        multipart: true,
        ttl: input.ttlSeconds,
        localBucket,
      });
      const logs = await readLogs(sandbox);
      return { exitCode, logs, preview, snapshot };
    } finally {
      await destroySandbox(sandbox);
    }
  }
}

async function readLogs(sandbox: ReturnType<typeof getSandbox>) {
  return {
    stdout: await readLog(sandbox, STDOUT_FILE),
    stderr: await readLog(sandbox, STDERR_FILE),
  };
}

/**
 * Reads at most INLINE_LOG_BYTES from the end of a log, marking any truncation.
 * The result is a step output, so it must be a bounded string: a stream is not
 * serializable, and a listing size does not bound a symlink's target. Anything
 * other than a regular file reads as empty.
 */
async function readLog(
  sandbox: ReturnType<typeof getSandbox>,
  file: string
): Promise<string> {
  const { stdout } = await sandbox.exec(
    `[ -f ${file} ] && [ ! -L ${file} ] || exit 0; wc -c < ${file}; tail -c ${INLINE_LOG_BYTES} ${file}`,
    { cwd: '/', timeout: 30_000 }
  );
  const newline = stdout.indexOf('\n');
  if (newline < 0) {
    return '';
  }
  const size = Number(stdout.slice(0, newline).trim());
  const content = stdout.slice(newline + 1);
  return size > INLINE_LOG_BYTES
    ? `[log truncated: showing last ${INLINE_LOG_BYTES} of ${size} bytes]\n${content}`
    : content;
}

async function readPreviews(sandbox: ReturnType<typeof getSandbox>) {
  const [stdout, stderr] = await Promise.all([
    readTail(sandbox, STDOUT_FILE),
    readTail(sandbox, STDERR_FILE),
  ]);
  return { stdout, stderr };
}

async function readTail(sandbox: ReturnType<typeof getSandbox>, file: string) {
  return (
    await sandbox.exec(`tail -c ${TAIL_BYTES} ${file} 2>/dev/null`, {
      cwd: '/',
      timeout: 30_000,
    })
  ).stdout;
}

function resolveCwd(cwd: string | undefined) {
  if (!cwd || cwd === '.' || cwd === './') {
    return WORKSPACE_DIR;
  }
  const normalized = posix.normalize(cwd);
  // Commands stay inside the snapshotted workspace so chained runners cannot
  // depend on filesystem state that lineage backups do not preserve.
  if (
    posix.isAbsolute(normalized) ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    throw new Error(`cwd must be inside ${WORKSPACE_DIR}: ${cwd}`);
  }
  return posix.join(WORKSPACE_DIR, normalized);
}

function createRunnerId(label: string) {
  return `${slugify(label).slice(0, 16)}-${crypto.randomUUID()}`;
}

async function destroySandbox(sandbox: ReturnType<typeof getSandbox>) {
  try {
    await sandbox.destroy();
  } catch (error) {
    console.error('Failed to destroy CI sandbox', { error });
  }
}
