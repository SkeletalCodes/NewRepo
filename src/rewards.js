'use strict';

const { db, tx, credit, getSetting } = require('./db');

/**
 * Mark a pending offer completion as completed: pay the user, pay the
 * referral commission, and bump the offer's completion counter.
 * Must be called inside a transaction.
 */
function approveCompletionInTx(completion) {
  if (completion.status !== 'pending') throw new Error('Completion is not pending.');
  const now = Date.now();
  db.prepare("UPDATE offer_completions SET status = 'completed', updated_at = ? WHERE id = ?").run(now, completion.id);
  credit(completion.user_id, completion.reward, 'offer', `${completion.provider}: ${completion.offer_title}`);
  if (completion.offer_id) db.prepare('UPDATE offers SET completions = completions + 1 WHERE id = ?').run(completion.offer_id);

  const user = db.prepare('SELECT username, referred_by FROM users WHERE id = ?').get(completion.user_id);
  const pct = Number(getSetting('referral_percent')) || 0;
  if (user && user.referred_by && pct > 0) {
    const commission = Math.floor((completion.reward * pct) / 100);
    if (commission > 0) credit(user.referred_by, commission, 'referral', `${pct}% commission from ${user.username}`);
  }
}

function approveCompletion(id) {
  return tx(() => {
    const c = db.prepare('SELECT * FROM offer_completions WHERE id = ?').get(id);
    if (!c) throw new Error('Completion not found.');
    approveCompletionInTx(c);
  });
}

function rejectCompletion(id, note = '') {
  return tx(() => {
    const c = db.prepare('SELECT * FROM offer_completions WHERE id = ?').get(id);
    if (!c) throw new Error('Completion not found.');
    if (c.status === 'rejected') return;
    if (c.status === 'completed') {
      // Chargeback: claw back what was paid.
      credit(c.user_id, -c.reward, 'chargeback', `Reversed: ${c.offer_title}`);
    }
    db.prepare("UPDATE offer_completions SET status = 'rejected', note = ?, updated_at = ? WHERE id = ?")
      .run(note, Date.now(), id);
  });
}

module.exports = { approveCompletion, approveCompletionInTx, rejectCompletion };
