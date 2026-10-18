const { getDb } = require('../db');
const { localDateInTimeZone, weekRangeForTimeZone } = require('../utils/timezone');
const { normalizeLocale, t } = require('../i18n');
const { sanitizeText } = require('../utils/sanitize');
const CLOSE_POINTS = { completed: 10, not_completed_donated: 3, too_hard: 0, cancelled: 0 };
function contractText(value, maxLength, lengthError) {
  if (value == null) return '';
  if (typeof value !== 'string') throw new Error('error.contractTextType');
  // Validate raw input too: markup/whitespace must not hide an oversized value.
  if (value.length > maxLength) throw new Error(lengthError);
  const clean = sanitizeText(value, { maxLength: 0 });
  // Link neutralization can expand text. Reject rather than truncate that result.
  if (clean.length > maxLength) throw new Error(lengthError);
  return clean;
}
function contractStake(value) {
  if (value == null) return '';
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('error.contractStakeInvalid');
  const raw = String(value);
  if (raw.length > 40) throw new Error('error.contractStakeTooLong');
  const clean = raw.trim();
  // This is a symbolic intention, not money: preserve decimal precision as text.
  if (clean && !/^\d+(?:[.,]\d+)?$/.test(clean)) throw new Error('error.contractStakeInvalid');
  return clean.replace(',', '.');
}
function userTimeZone(userId) { return getDb().prepare('SELECT timezone FROM users WHERE id = ?').get(userId)?.timezone || 'Asia/Novosibirsk'; }
function userLocale(userId) { return normalizeLocale(getDb().prepare('SELECT locale FROM users WHERE id = ?').get(userId)?.locale); }
function getCurrentContract(userId) {
  const contract = getDb().prepare("SELECT * FROM weekly_contracts WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1").get(userId) || null;
  if (!contract) return null;
  const today = localDateInTimeZone(new Date(), userTimeZone(userId));
  return { ...contract, isLastDay: today >= contract.week_end, isOver: today > contract.week_end };
}
function getLatestContract(userId) { return getDb().prepare('SELECT * FROM weekly_contracts WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(userId) || null; }
function createContract(userId, input) {
  if (getCurrentContract(userId)) throw new Error('error.contractExists');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('error.contractInputType');
  const cleanTitle = contractText(input.title, 120, 'error.contractTitleTooLong');
  const cleanTarget = contractText(input.targetValue, 300, 'error.contractTargetTooLong');
  const cleanStake = contractStake(input.stakeAmount);
  const cleanReward = contractText(input.rewardDescription, 300, 'error.contractRewardTooLong');
  const cleanFund = contractText(input.fundDescription, 300, 'error.contractFundTooLong');
  const cleanCurrency = contractText(input.stakeCurrency, 20, 'error.contractCurrencyTooLong') || 'RUB';
  if (!cleanTitle || !cleanTarget) throw new Error('error.contractFields');
  const timeZone = userTimeZone(userId);
  const now = new Date();
  const today = localDateInTimeZone(now, timeZone);
  let { weekStart, weekEnd } = weekRangeForTimeZone(timeZone, now);
  if (today >= weekEnd) {
    ({ weekStart, weekEnd } = weekRangeForTimeZone(timeZone, new Date(now.getTime() + 24 * 60 * 60 * 1000)));
  }
  const info = getDb().prepare('INSERT INTO weekly_contracts (user_id, title, target_value, week_start, week_end, stake_amount, stake_currency, reward_description, fund_description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(userId, cleanTitle, cleanTarget, weekStart, weekEnd, cleanStake, cleanCurrency, cleanReward, cleanFund);
  const contract = getDb().prepare('SELECT * FROM weekly_contracts WHERE id = ?').get(info.lastInsertRowid);
  return { ...contract, isLastDay: false, isOver: false };
}
function closeContract(userId, contractId, status, resultNote = '') {
  if (!Object.prototype.hasOwnProperty.call(CLOSE_POINTS, status)) throw new Error('error.contractStatus');
  const db = getDb();
  const contract = db.prepare("SELECT * FROM weekly_contracts WHERE id = ? AND user_id = ? AND status = 'active'").get(contractId, userId);
  if (!contract) throw new Error('error.contractNotFound');
  const points = CLOSE_POINTS[status];
  const entryDate = localDateInTimeZone(new Date(), userTimeZone(userId));
  const lang = userLocale(userId);
  const cleanResult = contractText(resultNote, 500, 'error.contractResultTooLong');
  db.transaction(() => {
    db.prepare('UPDATE weekly_contracts SET status = ?, result_note = ?, closed_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?').run(status, cleanResult, contractId, userId);
    if (points > 0) db.prepare("INSERT INTO entries (user_id, type, title, note, life_points, entry_date) VALUES (?, 'weekly_contract', ?, ?, ?, ?)").run(userId, status === 'completed' ? t(lang, 'contractEntry.completed') : t(lang, 'contractEntry.honest'), cleanResult, points, entryDate);
  })();
  return db.prepare('SELECT * FROM weekly_contracts WHERE id = ?').get(contractId);
}
module.exports = { getCurrentContract, getLatestContract, createContract, closeContract };
