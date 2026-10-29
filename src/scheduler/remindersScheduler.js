const { scheduleRemindersForEnabledUsers, sendDueReminders, recoverInterruptedReminders } = require('../services/remindersService');
let timer = null;
let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    scheduleRemindersForEnabledUsers();
    await sendDueReminders();
  } catch (error) {
    console.error('Scheduler error:', error.message);
  } finally {
    // Partner delivery/retention must still run when another channel fails.
    try { await require('../services/partnerService').processPartnerOutbox(); }
    catch (_) { console.error('Partner outbox tick failed'); }
    running = false;
  }
}
function startRemindersScheduler(intervalMs = 60000) {
  if (timer) return timer;
  if (!running) recoverInterruptedReminders();
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();
  return timer;
}
function stopRemindersScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
  // An in-flight tick still owns the guard, including across stop/start.
}
module.exports = { startRemindersScheduler, stopRemindersScheduler };
