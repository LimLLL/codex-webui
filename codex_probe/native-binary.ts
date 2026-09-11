/** Resolves the pinned native executable so signals never target an npm launcher. */
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

/**
 * Resolves the same platform package as the installed Codex npm entrypoint.
 * Only the repository's pinned wrapper or its native executable is accepted;
 * a shell script or a global CLI cannot silently become a crash-test target.
 *
 * @param requested - Existing probe callers may supply the pinned npm wrapper.
 * @returns Native executable and package root used by the npm launcher.
 * @throws If the platform package is missing or a different executable was requested.
 */
export function nativeCodexBinary(requested?: string) {
  const packagePath = require.resolve('@openai/codex/package.json');
  const packageRoot = dirname(realpathSync(packagePath));
  const targets: Record<string, string> = {
    'darwin-arm64': 'aarch64-apple-darwin',
    'darwin-x64': 'x86_64-apple-darwin',
    'linux-arm64': 'aarch64-unknown-linux-musl',
    'linux-x64': 'x86_64-unknown-linux-musl',
    'win32-arm64': 'aarch64-pc-windows-msvc',
    'win32-x64': 'x86_64-pc-windows-msvc',
  };
  const platform = `${process.platform}-${process.arch}`;
  const target = targets[platform];
  if (!target) throw new Error(`Unsupported probe platform: ${platform}`);
  const platformPackage = createRequire(packagePath).resolve(
    `@openai/codex-${platform}/package.json`,
  );
  const executable = join(
    dirname(platformPackage),
    'vendor',
    target,
    'bin',
    process.platform === 'win32' ? 'codex.exe' : 'codex',
  );
  if (!existsSync(executable))
    throw new Error('Pinned native Codex executable is missing');
  const wrapper = resolve(__dirname, '../node_modules/.bin/codex');
  if (
    requested &&
    requested !== 'codex' &&
    resolve(requested) !== wrapper &&
    realpathSync(requested) !== realpathSync(executable)
  ) {
    throw new Error(
      'Probe binary must be the repository-pinned Codex executable',
    );
  }
  return { executable: realpathSync(executable), packageRoot };
}
