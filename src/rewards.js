'use strict';

const { db, credit, getSetting } = require('./db');

/**
 * Mark a pending offer completion as completed: pay the user, pay the
 * referral commission, and bump the offer's completion counter.
 * `t` is a transaction executor. Returns false if it was no longer pending.
 */
async function approveCompletionInTx(t, completion) {
  const r = await t.run("UPDATE offer_completions SET status = 'completed', updated_at = ? WHERE id = ? AND status = 'pending'",
    Date.now(), completion.id);
  if (r.changes !== 1) return false;
  await credit(t, completion.user_id, completion.reward, 'offer', `${completion.provider}: ${completion.offer_title}`);
  if (completion.offer_id) await t.run('UPDATE offers SET completions = completions + 1 WHERE id = ?', completion.offer_id);

  const user = await t.get('SELECT username, referred_by FROM users WHERE id = ?', completion.user_id);
  const pct = Number(await getSetting('referral_percent', t)) || 0;
  if (user && user.referred_by && pct > 0) {
    const commission = Math.floor((completion.reward * pct) / 100);
    if (commission > 0) await credit(t, user.referred_by, commission, 'referral', `${pct}% commission from ${user.username}`);
  }
  return true;
}

function approveCompletion(id) {
  return db.tx(async (t) => {
    const c = await t.get('SELECT * FROM offer_completions WHERE id = ?', id);
    if (!c) throw new Error('Completion not found.');
    if (!(await approveCompletionInTx(t, c))) throw new Error('Completion is not pending.');
  });
}

function rejectCompletion(id, note = '') {
  return db.tx(async (t) => {
    const c = await t.get('SELECT * FROM offer_completions WHERE id = ?', id);
    if (!c) throw new Error('Completion not found.');
    const r = await t.run("UPDATE offer_completions SET status = 'rejected', note = ?, updated_at = ? WHERE id = ? AND status = ?",
      note, Date.now(), id, c.status);
    if (r.changes !== 1 || c.status === 'rejected') return;
    // Chargeback: claw back what was paid.
    if (c.status === 'completed') await credit(t, c.user_id, -c.reward, 'chargeback', `Reversed: ${c.offer_title}`);
  });
}

module.exports = { approveCompletion, approveCompletionInTx, rejectCompletion };
