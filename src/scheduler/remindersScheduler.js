const { scheduleRemindersForEnabledUsers, sendDueReminders } = require('../services/remindersService');
let timer = null;
function startRemindersScheduler(intervalMs = 60000) { if (timer) return timer; async function tick() { try { scheduleRemindersForEnabledUsers(); await sendDueReminders(); } catch (error) { console.error('Scheduler error:', error.message); } } timer = setInterval(tick, intervalMs); timer.unref?.(); tick(); return timer; }
function stopRemindersScheduler() { if (timer) clearInterval(timer); timer = null; }
module.exports = { startRemindersScheduler, stopRemindersScheduler };
