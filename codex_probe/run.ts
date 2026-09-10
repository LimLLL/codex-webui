/**
 * Probe runner: resolves the pinned binary, prepares an isolated CODEX_HOME,
 * and executes one probe by name.
 *
 * The home directory is a copy of `config.toml` into a throwaway tree rather
 * than the tree itself. Probes mutate configuration and accumulate rollouts,
 * sessions and a SQLite database; pointing CODEX_HOME at the checked-out
 * directory would mix that state into the repository and make a probe's result
 * depend on every probe that ran before it.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { AppServer } from './harness';

const PROBE_DIR = __dirname;
const REPO_ROOT = path.resolve(PROBE_DIR, '..');

/** Where the user keeps the config under test. Gitignored; may hold real keys. */
export const CONFIG_PATH = path.join(PROBE_DIR, 'config.toml');
/** Throwaway CODEX_HOME. Wiped per run unless a probe opts out. */
export const HOME_DIR = path.join(PROBE_DIR, 'home');
/** Throwaway working directory used as a thread's cwd. */
export const WORKSPACE_DIR = path.join(PROBE_DIR, 'workspace');

/**
 * Resolves the codex binary.
 *
 * The repo's pinned `@openai/codex` devDependency is the only supported
 * runtime, so a globally installed codex of another version must not be picked
 * up silently — that would make a measurement describe a protocol this project
 * does not target.
 *
 * @returns Absolute path to the pinned binary
 */
export function resolveCodexBin(): string {
  const pinned = path.join(REPO_ROOT, 'node_modules', '.bin', 'codex');
  if (!existsSync(pinned)) {
    throw new Error(
      `Pinned codex binary not found at ${pinned}. Run \`pnpm install\` first.`,
    );
  }
  return pinned;
}

/** Reports the pinned CLI version, so every probe log states what it measured. */
export function codexVersion(bin: string): string {
  try {
    return execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

export interface ProbeContext {
  app: AppServer;
  /** Throwaway directory safe to use as a thread cwd. */
  workspace: string;
}

/** One probe: a named question, answered by driving the app-server. */
export interface Probe {
  name: string;
  /** One line describing what this measures, shown by `--list`. */
  question: string;
  /** True when the probe needs a working model provider and spends tokens. */
  needsModel?: boolean;
  run: (context: ProbeContext) => Promise<void>;
}

/**
 * Prepares a clean CODEX_HOME seeded from `config.toml`.
 *
 * @returns The home directory path
 */
function prepareHome(): string {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      `Missing ${CONFIG_PATH}. Copy config.toml.exmaple to config.toml and fill it in.`,
    );
  }
  rmSync(HOME_DIR, { recursive: true, force: true });
  mkdirSync(HOME_DIR, { recursive: true });
  copyFileSync(CONFIG_PATH, path.join(HOME_DIR, 'config.toml'));
  rmSync(WORKSPACE_DIR, { recursive: true, force: true });
  mkdirSync(WORKSPACE_DIR, { recursive: true });
  return HOME_DIR;
}

/**
 * Runs one probe end to end.
 *
 * @param probe - The probe to execute
 */
export async function runProbe(probe: Probe): Promise<void> {
  const bin = resolveCodexBin();
  const home = prepareHome();
  console.log(`probe: ${probe.name}`);
  console.log(`codex: ${codexVersion(bin)}`);
  console.log(`question: ${probe.question}\n`);

  const app = await AppServer.start({ bin, home });
  try {
    await probe.run({ app, workspace: WORKSPACE_DIR });
  } finally {
    const stderr = app.stderr();
    app.close();
    if (stderr.trim()) {
      // Printed after the result, not instead of it: app-server logs warnings on
      // stderr during perfectly successful runs, and treating that as failure
      // would hide the measurement.
      console.log(`\n--- app-server stderr (tail) ---\n${stderr.slice(-1200)}`);
    }
  }
}
