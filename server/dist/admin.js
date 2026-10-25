import { isAdminEmail } from './service.js';
/** What counts as money in or out on the Payments tab. */
const MONEY_TYPES = ['purchase', 'promo', 'refund', 'starter_duplicate'];
const POTS = ['lesson', 'test', 'free'];
const DAY = 86400_000;
/** At most this many sessions added or taken in one adjustment. */
export const MAX_ADJUST = 50;
const allowancesOf = (a) => Object.fromEntries(POTS.map(p => [p, a.allowances?.[p] ?? 0]));
const summary = (a) => ({ id: a.id, email: a.email, createdAt: a.createdAt.toISOString(), balance: a.balance, allowances: allowancesOf(a),
    firstPaidAt: a.firstPaidAt?.toISOString() ?? null, starterBought: !!a.starterBought, referralCode: a.referralCode, referred: !!a.referredBy });
const entryOut = (e) => ({ id: e.id, type: e.type, sessionsDelta: e.sessionsDelta, pot: e.pot ?? null, amountPence: e.amountPence, currency: e.currency,
    reason: e.reason, actor: e.actor, by: e.by ?? null, stripe: e.stripe ?? null, accountId: e.accountId, createdAt: e.createdAt.toISOString() });
/** A spreadsheet cell: quoted, and text that a spreadsheet would run as a formula is made plain. */
export function csvCell(v) {
    let s = v == null ? '' : String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s))
        s = `'${s}`;
    return /[",\n\r]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}
/**
 * The admin hub: read-only views of accounts, the ledger, drives, flags and referrals, plus the two things an admin
 * can change: a session adjustment (a new ledger entry, never an edit) and marking a flag resolved. Who is an admin
 * is decided by ADMIN_EMAILS against the account's verified email.
 */
export class Admin {
    config;
    store;
    constructor(config, store) {
        this.config = config;
        this.store = store;
    }
    /** The admin's email, or null if this account is not an admin. */
    async adminEmail(accountId) {
        const a = await this.store.findAccount({ id: accountId });
        return a?.email && isAdminEmail(this.config, a.email) ? a.email : null;
    }
    async overview(now = new Date()) {
        const d7 = new Date(now.getTime() - 7 * DAY), d30 = new Date(now.getTime() - 30 * DAY);
        const [total, new7, new30, paying, referred, held, flags, drives, money, referralBonuses] = await Promise.all([
            this.store.countAccounts({}), this.store.countAccounts({ since: d7 }), this.store.countAccounts({ since: d30 }),
            this.store.countAccounts({ paid: true }), this.store.countAccounts({ referred: true }), this.store.heldTotals(),
            this.store.flags({ state: 'open' }), this.store.driveCounts(d30), this.store.ledger({ types: ['purchase', 'refund'] }), this.store.ledger({ type: 'referral_bonus' })
        ]);
        const purchases = money.filter(e => e.type === 'purchase'), recent = purchases.filter(e => e.createdAt >= d30);
        const gross = purchases.reduce((n, e) => n + e.amountPence, 0), refunded = -money.filter(e => e.type === 'refund').reduce((n, e) => n + e.amountPence, 0);
        return {
            at: now.toISOString(), currency: 'gbp',
            accounts: { total, new7, new30, paying, referred },
            money: { grossPence: gross, refundedPence: refunded, netPence: gross - refunded, payments: purchases.length, gross30Pence: recent.reduce((n, e) => n + e.amountPence, 0), payments30: recent.length },
            drives: { started30: drives.total, lesson30: drives.lesson, test30: drives.test, free30: drives.free, failed30: drives.failed },
            sessionsHeld: held, flags: { open: flags.length }, referrals: { rewarded: referralBonuses.length }
        };
    }
    async customers(search) {
        return { customers: (await this.store.listAccounts({ search: search.slice(0, 254), limit: 50 })).map(summary) };
    }
    async customer(id) {
        const a = await this.store.findAccount({ id });
        if (!a)
            return null;
        const [ledger, drives, invited, referrer] = await Promise.all([this.store.ledger({ accountId: id }), this.store.listDrives({ accountId: id, limit: 50 }),
            this.store.countReferred(id), a.referredBy ? this.store.findAccount({ id: a.referredBy }) : null]);
        return {
            account: { ...summary(a), invited, referrer: referrer ? { id: referrer.id, email: referrer.email, code: referrer.referralCode } : null },
            ledger: ledger.map(entryOut),
            drives: drives.filter(d => d.status !== 'unpaid').map(d => ({ id: d.id, scenario: d.scenario, kind: d.kind, mode: d.mode, status: d.status, paidFrom: d.paidFrom, refunded: !!d.refunded, startedAt: d.startedAt.toISOString() }))
        };
    }
    /**
     * Adds (or with a negative number takes away) sessions: general ones, or one Starter Pass pot. A removal never
     * takes a balance below zero. `requestId` makes a repeated submission (a double click, a retried request) record once.
     */
    async adjust(by, accountId, input) {
        const n = input.sessions, pot = input.pot, reason = typeof input.reason === 'string' ? input.reason.trim() : '';
        if (typeof n !== 'number' || !Number.isInteger(n) || n === 0 || Math.abs(n) > MAX_ADJUST)
            return { error: 'sessions' };
        if (pot !== null && pot !== undefined && !POTS.includes(pot))
            return { error: 'pot' };
        if (reason.length < 3 || reason.length > 200)
            return { error: 'reason' };
        const requestId = typeof input.requestId === 'string' && /^[\w-]{8,64}$/.test(input.requestId) ? input.requestId : null;
        if (!requestId)
            return { error: 'request' };
        if (!await this.store.findAccount({ id: accountId }))
            return { error: 'not-found' };
        const r = await this.store.appendLedger({ product: 'simulator', accountId, type: 'adjustment', sessionsDelta: n, ...(pot ? { pot: pot } : {}), amountPence: 0, currency: 'gbp',
            actor: 'admin', by, reason, idempotencyKey: `adjustment:${requestId}` }, { requireBalance: n < 0 });
        if (r === 'insufficient')
            return { error: 'insufficient' };
        const a = (await this.store.findAccount({ id: accountId }));
        return { result: r, balance: a.balance, allowances: allowancesOf(a) };
    }
    /** Money in and out between two dates (inclusive, UK calendar days are close enough to UTC for this view). */
    async payments(fromDay, toDay, now = new Date()) {
        const day = (s) => s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) ? new Date(`${s}T00:00:00Z`) : null;
        const until = new Date((day(toDay) ?? new Date(now.toISOString().slice(0, 10) + 'T00:00:00Z')).getTime() + DAY);
        const since = day(fromDay) ?? new Date(until.getTime() - 31 * DAY);
        const entries = await this.store.ledger({ types: MONEY_TYPES, since, until });
        const emails = new Map((await this.store.findAccounts([...new Set(entries.map(e => e.accountId))])).map(a => [a.id, a.email]));
        const purchases = entries.filter(e => e.type === 'purchase');
        return {
            since: since.toISOString(), until: until.toISOString(),
            totals: { payments: purchases.length, grossPence: purchases.reduce((n, e) => n + e.amountPence, 0), refundedPence: -entries.filter(e => e.type === 'refund').reduce((n, e) => n + e.amountPence, 0) },
            entries: entries.map(e => ({ ...entryOut(e), email: emails.get(e.accountId) ?? null }))
        };
    }
    paymentsCsv(p) {
        const head = ['date', 'account_id', 'email', 'type', 'reason', 'amount_gbp', 'currency', 'sessions', 'pot', 'payment_intent', 'checkout_session', 'charge', 'stripe_event'];
        const rows = p.entries.map(e => [e.createdAt, e.accountId, e.email, e.type, e.reason, Number((e.amountPence / 100).toFixed(2)), e.currency, e.sessionsDelta, e.pot,
            e.stripe?.paymentIntent, e.stripe?.checkoutSession, e.stripe?.charge, e.stripe?.event]);
        return [head, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
    }
    async flags(state) {
        const s = state === 'resolved' || state === 'all' ? state : 'open';
        return { flags: (await this.store.flags({ state: s })).map(f => ({ id: f.id, kind: f.kind, data: f.data, createdAt: f.createdAt.toISOString(),
                resolvedAt: f.resolvedAt?.toISOString() ?? null, resolvedBy: f.resolvedBy ?? null, note: f.note ?? null })) };
    }
    async resolveFlag(by, id, note) {
        const text = typeof note === 'string' ? note.trim().slice(0, 300) : '';
        return this.store.resolveFlag(id, by, text);
    }
    async referrals() {
        const counts = await this.store.referrers();
        const [accounts, bonuses, refused] = await Promise.all([this.store.findAccounts(counts.map(c => c.referrerId)), this.store.ledger({ type: 'referral_bonus' }),
            this.store.flags({ state: 'all' })]);
        const byId = new Map(accounts.map(a => [a.id, a]));
        const rewards = new Map();
        for (const b of bonuses)
            rewards.set(b.accountId, (rewards.get(b.accountId) ?? 0) + b.sessionsDelta);
        return {
            referrers: counts.map(c => ({ id: c.referrerId, email: byId.get(c.referrerId)?.email ?? null, code: byId.get(c.referrerId)?.referralCode ?? '', joined: c.joined, paid: c.paid, rewards: rewards.get(c.referrerId) ?? 0 })),
            refused: refused.filter(f => f.kind === 'referral-refused').length
        };
    }
}
