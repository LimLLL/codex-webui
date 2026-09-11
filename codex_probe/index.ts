/**
 * Probe CLI.
 *
 * Usage:
 *   pnpm probe --list
 *   pnpm probe <name>
 */
import { runProbe, type Probe } from './run';
import { settingsUpdate } from './probes/settings-update';
import { itemPersistence } from './probes/item-persistence';
import { itemOrdering } from './probes/item-ordering';
import { livePolicy } from './probes/live-policy';
import { turnItemFinality } from './probes/turn-item-finality';
import { fileApprovalContextProbe } from './probes/file-approval-context';
import { serverRequestDisposition } from './probes/server-request-disposition';
import { serverRequestIdentity } from './probes/server-request-identity';
import { observableServiceTier } from './probes/observable-service-tier';
import { authTokenRefresh } from './probes/auth-token-refresh';

const PROBES: Probe[] = [
  settingsUpdate,
  itemPersistence,
  itemOrdering,
  turnItemFinality,
  livePolicy,
  fileApprovalContextProbe,
  serverRequestDisposition,
  serverRequestIdentity,
  observableServiceTier,
  authTokenRefresh,
];

function list(): void {
  const width = Math.max(...PROBES.map((probe) => probe.name.length));
  console.log('Available probes:\n');
  for (const probe of PROBES) {
    const cost = probe.needsModel ? ' [spends tokens]' : '';
    console.log(`  ${probe.name.padEnd(width)}  ${probe.question}${cost}`);
  }
  console.log('\nRun one with: pnpm probe <name>');
}

async function main(): Promise<void> {
  const name = process.argv[2];
  if (!name || name === '--list' || name === '-l') {
    list();
    return;
  }
  const probe = PROBES.find((candidate) => candidate.name === name);
  if (!probe) {
    console.error(`Unknown probe: ${name}\n`);
    list();
    process.exitCode = 1;
    return;
  }
  await runProbe(probe);
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
