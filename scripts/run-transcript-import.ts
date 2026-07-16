// Import VSCode Copilot transcript files into AEA SQLite database.
//
// Transcripts contain the richest behavior signals (tool.execution_complete
// with success/fail), which are used by BehaviorLabelExtractor to generate
// real user-behavior-based labels instead of heuristic labels.
//
// Usage: npm run demo:transcripts

import fs from 'node:fs';
import path from 'node:path';
import { TranscriptParser } from '../src/realtime/TranscriptParser.js';
import { openDatabase } from '../src/store/schema.js';
import { EventStore } from '../src/store/EventStore.js';
import { FeaturePipeline } from '../src/store/FeaturePipeline.js';
import { FeatureStore } from '../src/store/FeatureStore.js';
import { FeatureRegistry } from '../src/store/FeatureRegistry.js';

const WORKSPACE_STORAGE = '/Users/saga/Library/Application Support/Code/User/workspaceStorage';
const DB_PATH = process.env.AEA_TRANSCRIPTS_DB ?? './data/aea-transcripts.db';

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Copilot Transcript Import');
  console.log('═══════════════════════════════════════════════════════════\n');

  const parser = new TranscriptParser();
  const sessions = parser.parseDirectory(WORKSPACE_STORAGE);

  console.log(`Found ${sessions.length} transcript session(s)\n`);

  if (sessions.length === 0) {
    console.log('No transcripts found. Exiting.');
    return;
  }

  // Open AEA database
  const db = openDatabase(DB_PATH);
  const eventStore = new EventStore(db);
  const registry = new FeatureRegistry(db);
  const featureStore = new FeatureStore(db);
  const pipeline = new FeaturePipeline(featureStore, eventStore, registry);

  let totalEvents = 0;
  let totalAccept = 0;
  let totalRetry = 0;
  let totalToolCalls = 0;
  let totalChat = 0;

  for (const session of sessions) {
    const events = session.events;
    console.log(`  Session ${session.sessionId.slice(0, 8)}: ${events.length} events`);
    console.log(`    copilotVersion: ${session.copilotVersion ?? 'n/a'}`);
    console.log(`    duration: ${((session.endTime - session.startTime) / 1000).toFixed(1)}s`);

    // Count behavior signals
    let accept = 0, retry = 0, toolCalls = 0, chat = 0;
    for (const e of events) {
      if (e.eventType === 'accept') accept++;
      if (e.eventType === 'retry') retry++;
      if (e.eventType === 'tool_call') toolCalls++;
      if (e.eventType === 'chat') chat++;
    }

    totalAccept += accept;
    totalRetry += retry;
    totalToolCalls += toolCalls;
    totalChat += chat;
    totalEvents += events.length;

    console.log(`    behavior: accept=${accept} retry=${retry} toolCalls=${toolCalls} chat=${chat}`);

    // Insert events into EventStore
    eventStore.insertBatch(events);

    // Compute features for this session
    try {
      pipeline.computeSession(session.sessionId);
    } catch (err) {
      console.error(`    feature computation failed: ${err}`);
    }
  }

  db.close();

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  Import Report');
  console.log('═══════════════════════════════════════════════════════════\n');
  console.log(`Sessions: ${sessions.length}`);
  console.log(`Total events: ${totalEvents}`);
  console.log(`Behavior signals:`);
  console.log(`  accept: ${totalAccept}`);
  console.log(`  retry: ${totalRetry}`);
  console.log(`  tool_call: ${totalToolCalls}`);
  console.log(`  chat: ${totalChat}`);
  console.log(`\nDatabase: ${DB_PATH}`);
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
