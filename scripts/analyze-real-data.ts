// Analyze real data from all AEA databases — show session details, features, and labels.
import { openDatabase } from '../src/store/schema.js';
import { EventStore } from '../src/store/EventStore.js';
import { extractModelSizeFeaturesFromEvents } from '../src/ml/features.js';
import { extractBehaviorLabel } from '../src/ml/BehaviorLabelExtractor.js';
import { heuristicLabel } from '../src/ml/realDataset.js';
import { extractTemporalFeatures } from '../src/ml/TemporalFeatures.js';

const DB_SOURCES = [
  './data/aea-transcripts.db',
  './data/aea-real-copilot.db',
  './data/aea-session-store.db',
];

function fmt(n: number): string {
  if (n === 0) return '0';
  if (n < 1) return n.toFixed(3);
  return n.toFixed(1);
}

console.log('═══════════════════════════════════════════════════════════');
console.log('  Real Data Analysis Report');
console.log('═══════════════════════════════════════════════════════════\n');

const allSessions: Array<{
  db: string;
  sessionId: string;
  events: number;
  duration: number;
  features: NonNullable<ReturnType<typeof extractModelSizeFeaturesFromEvents>>;
  behavior: ReturnType<typeof extractBehaviorLabel>;
  heuristic: string;
  temporal: ReturnType<typeof extractTemporalFeatures>;
}> = [];

for (const dbPath of DB_SOURCES) {
  const fs = require('node:fs');
  if (!fs.existsSync(dbPath)) continue;

  console.log(`\n── ${dbPath} ──`);
  const db = openDatabase(dbPath);
  const eventStore = new EventStore(db);
  const sessionIds = eventStore.getSessionIds();
  console.log(`  Sessions: ${sessionIds.length}`);

  for (const sid of sessionIds) {
    const events = eventStore.getBySession(sid);
    if (events.length < 3) continue;

    const features = extractModelSizeFeaturesFromEvents(events);
    if (!features) continue;

    const behavior = extractBehaviorLabel(events, features);
    const heuristic = heuristicLabel(features);
    const temporal = extractTemporalFeatures(events, []);

    const duration = features.elapsedMs;
    console.log(`\n  Session ${sid.slice(0, 12)}:`);
    console.log(`    events: ${events.length}, duration: ${(duration / 1000).toFixed(1)}s`);
    console.log(`    tokens: prompt=${features.promptTokens} completion=${features.completionTokens} context=${features.contextTokens}`);
    console.log(`    actions: toolCalls=${features.toolCalls} readFiles=${features.readFiles} edits=${features.edits} retries=${features.retries}`);
    console.log(`    files: read=${features.uniqueFilesRead} edited=${features.uniqueFilesEdited}`);
    console.log(`    derived: contextUtil=${fmt(features.contextUtilization)} readToEdit=${fmt(features.readToEditRatio)} retryRate=${fmt(features.retryRate)} hasLoop=${features.hasLoop}`);
    console.log(`    temporal: hour=${temporal.hourOfDay} weekend=${temporal.isWeekend} chatMs=${(temporal.chatDurationMs / 1000).toFixed(1)}s toolMs=${(temporal.toolDurationMs / 1000).toFixed(1)}s idleMs=${(temporal.idleMs / 1000).toFixed(1)}s`);
    console.log(`    behavior: accept=${behavior.acceptCount} retry=${behavior.retryCount} reject=${behavior.rejectCount} toolSuccess=${behavior.toolSuccesses}/${behavior.toolSuccesses + behavior.toolFailures} reward=${fmt(behavior.rewardNormalized)}`);
    console.log(`    label: behavior=${behavior.label}(${behavior.labelSource}) heuristic=${heuristic}`);

    allSessions.push({
      db: dbPath,
      sessionId: sid,
      events: events.length,
      duration,
      features,
      behavior,
      heuristic,
      temporal,
    });
  }

  db.close();
}

// Summary statistics
console.log('\n═══════════════════════════════════════════════════════════');
console.log('  Cross-Source Summary');
console.log('═══════════════════════════════════════════════════════════\n');

console.log(`Total sessions across all sources: ${allSessions.length}`);

const behaviorSessions = allSessions.filter(s => s.behavior.labelSource === 'behavior');
const heuristicSessions = allSessions.filter(s => s.behavior.labelSource === 'heuristic');
console.log(`Label sources: behavior=${behaviorSessions.length}, heuristic=${heuristicSessions.length}`);

const labelDist = new Map<string, number>();
for (const s of allSessions) {
  labelDist.set(s.behavior.label, (labelDist.get(s.behavior.label) ?? 0) + 1);
}
console.log(`Label distribution: ${JSON.stringify(Object.fromEntries(labelDist))}`);

// Feature ranges
console.log('\nFeature ranges:');
const featKeys = ['promptTokens', 'completionTokens', 'toolCalls', 'edits', 'retries', 'contextUtilization', 'retryRate', 'readToEditRatio'] as const;
for (const key of featKeys) {
  const vals = allSessions.map(s => s.features[key]).filter(v => v !== undefined);
  if (vals.length > 0) {
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    console.log(`  ${key}: min=${fmt(min)} max=${fmt(max)} avg=${fmt(avg)}`);
  }
}

// Behavior vs heuristic agreement
console.log('\nLabel agreement (behavior vs heuristic):');
let agree = 0, disagree = 0;
for (const s of allSessions) {
  if (s.behavior.label === s.heuristic) agree++;
  else disagree++;
}
console.log(`  agree=${agree} disagree=${disagree}`);

// Show disagreements
for (const s of allSessions) {
  if (s.behavior.label !== s.heuristic) {
    console.log(`  ${s.sessionId.slice(0, 12)}: behavior=${s.behavior.label} (reward=${fmt(s.behavior.rewardNormalized)}, accept=${s.behavior.acceptCount}, retry=${s.behavior.retryCount}) vs heuristic=${s.heuristic} (tokens=${s.features.promptTokens}, tools=${s.features.toolCalls}, edits=${s.features.edits})`);
  }
}
