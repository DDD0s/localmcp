// Fixture for the autostart supervisor test. Each run exits with the next code
// from LOCALMCP_EXIT_SEQUENCE and records the run count in LOCALMCP_EXIT_COUNTER.
import { readFileSync, writeFileSync } from 'node:fs';

const sequence = (process.env.LOCALMCP_EXIT_SEQUENCE || '0').split(',').map(Number);
const counter = process.env.LOCALMCP_EXIT_COUNTER;
let run = 0;
try { run = Number(readFileSync(counter, 'utf8')) || 0; } catch { /* first run */ }
writeFileSync(counter, String(run + 1));
console.log(`fixture run ${run + 1}`);
process.exit(sequence[Math.min(run, sequence.length - 1)]);
