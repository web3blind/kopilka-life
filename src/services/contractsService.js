const { getDb } = require('../db');
const { localDateInTimeZone, weekRangeForTimeZone } = require('../utils/timezone');
const CLOSE_POINTS = { completed: 10, not_completed_donated: 3, too_hard: 0, cancelled: 0 };
function userTimeZone(userId) { return getDb().prepare('SELECT timezone FROM users WHERE id = ?').get(userId)?.timezone || 'Asia/Novosibirsk'; }
function getCurrentContract(userId) { return getDb().prepare("SELECT * FROM weekly_contracts WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1").get(userId) || null; }
function getLatestContract(userId) { return getDb().prepare('SELECT * FROM weekly_contracts WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(userId) || null; }
function createContract(userId, input) {
  if (getCurrentContract(userId)) throw new Error('Уже есть активный договор заботы');
  if (!input.title || !input.targetValue) throw new Error('Заполни название и критерий договора');
  const { weekStart, weekEnd } = weekRangeForTimeZone(userTimeZone(userId));
  const info = getDb().prepare('INSERT INTO weekly_contracts (user_id, title, target_value, week_start, week_end, stake_amount, stake_currency, reward_description, fund_description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(userId, input.title.slice(0, 120), input.targetValue.slice(0, 300), weekStart, weekEnd, String(input.stakeAmount || '').slice(0, 40), String(input.stakeCurrency || 'RUB').slice(0, 20), String(input.rewardDescription || '').slice(0, 300), String(input.fundDescription || '').slice(0, 300));
  return getDb().prepare('SELECT * FROM weekly_contracts WHERE id = ?').get(info.lastInsertRowid);
}
function closeContract(userId, contractId, status, resultNote = '') {
  if (!Object.prototype.hasOwnProperty.call(CLOSE_POINTS, status)) throw new Error('Неизвестный итог договора');
  const db = getDb();
  const contract = db.prepare("SELECT * FROM weekly_contracts WHERE id = ? AND user_id = ? AND status = 'active'").get(contractId, userId);
  if (!contract) throw new Error('Активный договор не найден');
  const points = CLOSE_POINTS[status];
  const entryDate = localDateInTimeZone(new Date(), userTimeZone(userId));
  db.transaction(() => { db.prepare('UPDATE weekly_contracts SET status = ?, result_note = ?, closed_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?').run(status, resultNote.slice(0, 500), contractId, userId); if (points > 0) db.prepare("INSERT INTO entries (user_id, type, title, note, life_points, entry_date) VALUES (?, 'weekly_contract', ?, ?, ?, ?)").run(userId, status === 'completed' ? 'Выполненный недельный договор' : 'Честный итог договора', resultNote.slice(0, 500), points, entryDate); })();
  return db.prepare('SELECT * FROM weekly_contracts WHERE id = ?').get(contractId);
}
module.exports = { getCurrentContract, getLatestContract, createContract, closeContract };
