// Shared preservation rules for both explicit account-merge engines.
const same = (a, b) => a === b || (a == null && b == null);
function recordBlockers(db, primaryId, sourceId) {
  const blocking = [];
  if (db.prepare("SELECT 1 FROM ai_weekly_summaries WHERE user_id IN (?,?) AND status='processing' AND deadline_at>? AND started_at>? LIMIT 1").get(primaryId,sourceId,Date.now(),Date.now()-65000)) blocking.push('ai_weekly_processing');
  const pairs = (table, key) => db.prepare(`SELECT a.* FROM ${table} a JOIN ${table} b ON a.${key} = b.${key} WHERE a.user_id = ? AND b.user_id = ?`).all(primaryId, sourceId);
  // The entries table has no UNIQUE date/type constraint: every event carries its own LIFE.
  const reminders = db.prepare(`SELECT a.*, b.id AS source_row_id FROM reminders a JOIN reminders b
    ON a.type = b.type AND a.due_at = b.due_at WHERE a.user_id = ? AND b.user_id = ?`).all(primaryId, sourceId);
  for (const row of reminders) {
    const source = db.prepare('SELECT * FROM reminders WHERE id = ?').get(row.source_row_id);
    if (!['status', 'sent_at', 'retry_after', 'attempts'].every(field => same(row[field], source[field]))) blocking.push('reminder_conflict');
  }
  for (const row of pairs('user_artifacts', 'artifact_id')) {
    const source = db.prepare('SELECT * FROM user_artifacts WHERE user_id = ? AND artifact_id = ?').get(sourceId, row.artifact_id);
    if (row.trigger_entry_id != null && source.trigger_entry_id != null && row.trigger_entry_id !== source.trigger_entry_id) blocking.push('artifact_conflict');
  }
  for (const row of pairs('user_support_actions', 'action_id')) {
    const source = db.prepare('SELECT * FROM user_support_actions WHERE user_id = ? AND action_id = ?').get(sourceId, row.action_id);
    if (row.metadata_json != null && source.metadata_json != null && row.metadata_json !== source.metadata_json) blocking.push('support_metadata_conflict');
    if (row.source != null && source.source != null && row.source !== source.source) blocking.push('support_source_conflict');
  }
  return [...new Set(blocking)];
}
function moveRecords(db, primaryId, sourceId) {
  // Repeat at the write boundary even when a caller already built a merge preview.
  // A crashed/expired request must not block account recovery forever. Fence it
  // inside the merge transaction so a late provider response cannot overwrite it.
  db.prepare("UPDATE ai_weekly_summaries SET status='uncertain',error_code='PROVIDER_UNCERTAIN' WHERE user_id IN (?,?) AND status='processing' AND (deadline_at<=? OR started_at<=?)").run(primaryId,sourceId,Date.now(),Date.now()-65000);
  if (db.prepare("SELECT 1 FROM ai_weekly_summaries WHERE user_id IN (?,?) AND status='processing' LIMIT 1").get(primaryId,sourceId)) throw new Error('ai_weekly_processing');
  db.prepare('UPDATE ai_weekly_summaries SET user_id=? WHERE user_id=?').run(primaryId,sourceId);
  // A browser belongs to a signed-in device, not an identity being merged.
  // Both sessions are revised on merge; require explicit re-enablement.
  db.prepare('DELETE FROM push_subscriptions WHERE user_id IN (?, ?)').run(primaryId, sourceId);
  db.prepare('UPDATE entries SET user_id = ? WHERE user_id = ?').run(primaryId, sourceId);
  db.prepare('UPDATE weekly_contracts SET user_id = ? WHERE user_id = ?').run(primaryId, sourceId);
  for (const row of db.prepare('SELECT * FROM reminders WHERE user_id = ?').all(sourceId)) {
    const target = db.prepare('SELECT * FROM reminders WHERE user_id = ? AND type = ? AND due_at = ?').get(primaryId, row.type, row.due_at);
    if (target) {
      // Only identical delivery state may coalesce; keep the oldest creation time.
      db.prepare('UPDATE reminders SET created_at = MIN(created_at, ?) WHERE id = ?').run(row.created_at, target.id);
      db.prepare('DELETE FROM reminders WHERE id = ?').run(row.id);
    } else db.prepare('UPDATE reminders SET user_id = ? WHERE id = ?').run(primaryId, row.id);
  }
  for (const row of db.prepare('SELECT * FROM user_artifacts WHERE user_id = ?').all(sourceId)) {
    const target = db.prepare('SELECT * FROM user_artifacts WHERE user_id = ? AND artifact_id = ?').get(primaryId, row.artifact_id);
    if (target) {
      db.prepare('UPDATE user_artifacts SET awarded_at = MIN(awarded_at, ?), trigger_entry_id = COALESCE(trigger_entry_id, ?) WHERE user_id = ? AND artifact_id = ?')
        .run(row.awarded_at, row.trigger_entry_id, primaryId, row.artifact_id);
      db.prepare('DELETE FROM user_artifacts WHERE user_id = ? AND artifact_id = ?').run(sourceId, row.artifact_id);
    } else db.prepare('UPDATE user_artifacts SET user_id = ? WHERE user_id = ? AND artifact_id = ?').run(primaryId, sourceId, row.artifact_id);
  }
  for (const row of db.prepare('SELECT * FROM user_support_actions WHERE user_id = ?').all(sourceId)) {
    const target = db.prepare('SELECT * FROM user_support_actions WHERE user_id = ? AND action_id = ?').get(primaryId, row.action_id);
    if (target) {
      const first = (a, b) => a && b ? (a < b ? a : b) : a || b;
      const dates = ['opened_at', 'claimed_at', 'verified_at', 'credited_at'];
      const merged = Object.fromEntries(dates.map(key => [key, first(target[key], row[key])]));
      const status = merged.verified_at ? (target.verified_at ? target.status : row.status) :
        merged.credited_at ? (target.credited_at ? target.status : row.status) :
        merged.claimed_at ? (target.claimed_at ? target.status : row.status) :
        merged.opened_at ? (target.opened_at ? target.status : row.status) : target.status;
      db.prepare(`UPDATE user_support_actions SET status = ?, opened_at = ?, claimed_at = ?, verified_at = ?, credited_at = ?, source = ?, metadata_json = ?, created_at = MIN(created_at, ?), updated_at = MAX(updated_at, ?) WHERE user_id = ? AND action_id = ?`)
        .run(status, ...dates.map(key => merged[key]), target.source || row.source, target.metadata_json || row.metadata_json, row.created_at, row.updated_at, primaryId, row.action_id);
      db.prepare('DELETE FROM user_support_actions WHERE user_id = ? AND action_id = ?').run(sourceId, row.action_id);
    } else db.prepare('UPDATE user_support_actions SET user_id = ? WHERE user_id = ? AND action_id = ?').run(primaryId, sourceId, row.action_id);
  }
}
function moveReferrals(db, primary, source) {
  db.prepare('UPDATE users SET referrer_id = ? WHERE referrer_id = ?').run(primary.id, source.id);
  db.prepare('UPDATE users SET referrer_id = NULL WHERE id = ? AND referrer_id = id').run(primary.id);
  if (!primary.referrer_id && source.referrer_id && source.referrer_id !== primary.id && source.referrer_id !== source.id)
    db.prepare('UPDATE users SET referrer_id = ? WHERE id = ?').run(source.referrer_id, primary.id);
  // Never issue an entry here. An already paid invite stays paid after consolidation.
  db.prepare('UPDATE users SET referrer_bonus_granted = ? WHERE id = ?').run(primary.referrer_bonus_granted || source.referrer_bonus_granted ? 1 : 0, primary.id);
  db.prepare('UPDATE merged_ref_codes SET user_id = ? WHERE user_id = ?').run(primary.id, source.id);
  if (source.ref_code) db.prepare('INSERT INTO merged_ref_codes (ref_code,user_id) VALUES (?,?)').run(source.ref_code, primary.id);
  db.prepare('UPDATE users SET session_revision = session_revision + 1 WHERE id IN (?,?)').run(primary.id, source.id);
}
module.exports = { recordBlockers, moveRecords, moveReferrals };
