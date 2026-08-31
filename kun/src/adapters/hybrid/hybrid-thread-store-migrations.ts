import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import { addColumnIfMissing } from './hybrid-thread-support.js'

export function migrateHybridThreadSchema(db: BetterSqliteDatabase): void {
  addColumnIfMissing(db, 'threads', 'todos_json TEXT')
  addColumnIfMissing(db, 'threads', 'extension_metadata_json TEXT')
  addColumnIfMissing(db, 'threads', 'model_request_capture_enabled INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing(db, 'threads', "approval_reviewer TEXT NOT NULL DEFAULT 'user'")
  migrateHybridUsageBackfillState(db)
  migrateHybridUsageIndexes(db)
  addColumnIfMissing(db, 'threads', 'agent_surface TEXT')
  addColumnIfMissing(db, 'usage_events', 'provider_id TEXT')
}

export function migrateHybridUsageIndexes(db: BetterSqliteDatabase): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS usage_events_thread_timestamp_seq_idx
      ON usage_events(thread_id, timestamp DESC, seq DESC)
  `)
}

export function migrateHybridUsageBackfillState(db: BetterSqliteDatabase): void {
  const columns = db.prepare('PRAGMA table_info(threads)').all() as Array<{ name: string }>
  const names = new Set(columns.map((column) => column.name))
  const missingCompletion = !names.has('usage_backfilled')
  const missingHighWater = !names.has('usage_backfill_high_water')
  if (!missingCompletion && !missingHighWater) return
  db.transaction(() => {
    if (missingCompletion) {
      db.exec('ALTER TABLE threads ADD COLUMN usage_backfilled INTEGER NOT NULL DEFAULT 0')
    }
    if (missingHighWater) {
      db.exec('ALTER TABLE threads ADD COLUMN usage_backfill_high_water INTEGER NOT NULL DEFAULT 0')
      // Earlier versions could mark partially written usage as complete.
      // Reopen all rows exactly once when this recovery state is introduced.
      db.exec('UPDATE threads SET usage_backfilled = 0, usage_backfill_high_water = 0')
    }
  })()
}
