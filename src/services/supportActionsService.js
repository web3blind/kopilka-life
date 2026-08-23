const { getDb } = require('../db');

const BADGE_TITLE = { ru: 'Светлячок поддержки', en: 'Support firefly' };
const SURFACES = new Set(['vk', 'telegram', 'web']);

function normalizeSurface(surface = 'web') {
  const value = String(surface || '').toLowerCase().slice(0, 20);
  return SURFACES.has(value) ? value : 'web';
}

function isActiveWhere(now = new Date()) {
  const iso = now.toISOString().replace('T', ' ').slice(0, 19);
  return {
    sql: "active = 1 AND (starts_at IS NULL OR starts_at <= ?) AND (ends_at IS NULL OR ends_at >= ?)",
    params: [iso, iso]
  };
}

function normalizeLocale(locale = 'ru') {
  return String(locale || '').toLowerCase().startsWith('en') ? 'en' : 'ru';
}

function pickLocalized(row, field, locale) {
  if (locale === 'en' && row[`${field}_en`]) return row[`${field}_en`];
  return row[field] || '';
}

function badgeForUser(userId, locale = 'ru') {
  const lang = normalizeLocale(locale);
  const db = getDb();
  const row = db.prepare(`
    SELECT COALESCE(SUM(a.reward_points), 0) AS points
    FROM user_support_actions ua
    JOIN support_actions a ON a.id = ua.action_id
    WHERE ua.user_id = ? AND ua.credited_at IS NOT NULL
  `).get(userId);
  const points = Number(row?.points || 0);
  return { title: BADGE_TITLE[lang], points, level: supportLevel(points) };
}

function supportLevel(points) {
  if (points >= 10) return 4;
  if (points >= 6) return 3;
  if (points >= 3) return 2;
  if (points >= 1) return 1;
  return 0;
}

function projectAction(row, locale = 'ru') {
  const lang = normalizeLocale(locale);
  const opened = Boolean(row.opened_at || row.credited_at);
  const status = row.status || (opened ? 'opened' : 'available');
  return {
    id: row.id,
    slug: row.slug,
    title: pickLocalized(row, 'title', lang),
    description: pickLocalized(row, 'description', lang),
    buttonLabel: pickLocalized(row, 'button_label', lang),
    url: row.url,
    platform: row.platform,
    kind: row.kind,
    rewardPoints: Number(row.reward_points || 0),
    rewardLabel: lang === 'en' ? `+${Number(row.reward_points || 0)} Support firefly` : `+${Number(row.reward_points || 0)} Светлячок`,
    isPartner: Boolean(row.is_partner),
    isAd: Boolean(row.is_ad),
    disclosureText: pickLocalized(row, 'disclosure_text', lang),
    status,
    openedAt: row.opened_at || null,
    creditedAt: row.credited_at || null,
    createdAt: row.created_at
  };
}

function listSupportActions(userId, surface = 'web', locale = 'ru') {
  const db = getDb();
  const active = isActiveWhere();
  const targetSurface = normalizeSurface(surface);
  const rows = db.prepare(`
    SELECT a.*, ua.status, ua.opened_at, ua.credited_at
    FROM support_actions a
    LEFT JOIN user_support_actions ua ON ua.action_id = a.id AND ua.user_id = ?
    WHERE ${active.sql}
      AND a.platform IN ('common', ?)
    ORDER BY a.created_at DESC, a.sort_order DESC, a.id DESC
  `).all(userId, ...active.params, targetSurface);
  const actions = rows.map((row) => projectAction(row, locale));
  return {
    badge: badgeForUser(userId, locale),
    summary: {
      availableCount: actions.length,
      newCount: actions.filter((action) => action.status === 'available').length
    },
    surface: targetSurface,
    actions
  };
}

function getActiveAction(actionId) {
  const active = isActiveWhere();
  return getDb().prepare(`SELECT * FROM support_actions WHERE id = ? AND ${active.sql}`).get(Number(actionId), ...active.params) || null;
}

function openSupportAction(userId, actionId, source = '', locale = 'ru') {
  const db = getDb();
  const action = getActiveAction(actionId);
  if (!action) throw new Error('support action not found');
  if (!['open_url', 'partner_visit'].includes(action.kind)) throw new Error('support action cannot be opened');
  db.transaction(() => {
    const existing = db.prepare('SELECT * FROM user_support_actions WHERE user_id = ? AND action_id = ?').get(userId, action.id);
    if (!existing) {
      db.prepare(`
        INSERT INTO user_support_actions (user_id, action_id, status, opened_at, credited_at, source)
        VALUES (?, ?, 'opened', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
      `).run(userId, action.id, String(source || '').slice(0, 40));
      return;
    }
    if (!existing.opened_at || !existing.credited_at || existing.status !== 'opened') {
      db.prepare(`
        UPDATE user_support_actions
        SET status = 'opened',
            opened_at = COALESCE(opened_at, CURRENT_TIMESTAMP),
            credited_at = COALESCE(credited_at, CURRENT_TIMESTAMP),
            source = COALESCE(source, ?),
            updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND action_id = ?
      `).run(String(source || '').slice(0, 40), userId, action.id);
    }
  })();
  const row = db.prepare(`
    SELECT a.*, ua.status, ua.opened_at, ua.credited_at
    FROM support_actions a
    LEFT JOIN user_support_actions ua ON ua.action_id = a.id AND ua.user_id = ?
    WHERE a.id = ?
  `).get(userId, action.id);
  return { openUrl: action.url, action: projectAction(row, locale), badge: badgeForUser(userId, locale), summary: listSupportActions(userId, source, locale).summary };
}

module.exports = { listSupportActions, openSupportAction, badgeForUser, normalizeSurface };
