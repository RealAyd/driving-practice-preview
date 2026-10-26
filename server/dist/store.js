import { randomUUID } from 'node:crypto';
import { MemorySupportStore } from './supportStore.js';
export const DRIVE_OUTCOMES = ['completed', 'collision', 'left-route', 'time-limit', 'abandoned'];
export class MemoryStore {
    support = new MemorySupportStore();
    accounts = new Map();
    entries = [];
    drives = new Map();
    codes = new Map();
    rates = new Map();
    flagged = [];
    trials = new Map();
    visits = [];
    async createTrial() { const t = { id: randomUUID(), remaining: { lesson: 1, test: 1, free: 1 }, createdAt: new Date() }; this.trials.set(t.id, t); return { ...t, remaining: { ...t.remaining } }; }
    async getTrial(id) { const t = this.trials.get(id); return t ? { ...t, remaining: { ...t.remaining } } : null; }
    async moveTrial(id, mode, delta) {
        const t = this.trials.get(id);
        if (!t || t.remaining[mode] + delta < 0)
            return false;
        t.remaining[mode] += delta;
        return true;
    }
    async findAccount(q) {
        const [k, v] = Object.entries(q)[0];
        const a = [...this.accounts.values()].find(x => x[k] === v);
        return a ? { ...a, allowances: { ...a.allowances } } : null;
    }
    async createAccount(a) {
        if (a.email && [...this.accounts.values()].some(x => x.email === a.email))
            return null;
        const acc = { ...a, id: randomUUID(), balance: 0, createdAt: new Date() };
        this.accounts.set(acc.id, acc);
        return { ...acc };
    }
    async updateAccount(id, set) {
        const a = this.accounts.get(id);
        if (a)
            Object.assign(a, set);
    }
    async countReferred(referrerId) { return [...this.accounts.values()].filter(a => a.referredBy === referrerId).length; }
    async claimStarter(accountId, checkoutSession) {
        const a = this.accounts.get(accountId);
        if (!a)
            return 'lost';
        if (a.starterCheckout)
            return a.starterCheckout === checkoutSession ? 'same' : 'lost';
        a.starterCheckout = checkoutSession;
        a.starterBought = true;
        return 'won';
    }
    async appendLedger(e, opts = {}) {
        if (this.entries.some(x => x.idempotencyKey === e.idempotencyKey))
            return 'duplicate';
        const a = this.accounts.get(e.accountId);
        if (!a)
            throw new Error('no such account');
        const have = e.pot ? a.allowances?.[e.pot] ?? 0 : a.balance;
        if (opts.requireBalance && have + e.sessionsDelta < 0)
            return 'insufficient';
        this.entries.push({ ...e, id: randomUUID(), createdAt: new Date() });
        if (e.pot)
            a.allowances = { ...a.allowances, [e.pot]: have + e.sessionsDelta };
        else
            a.balance += e.sessionsDelta;
        return 'ok';
    }
    async ledger(q) {
        return this.entries.filter(e => (!q.accountId || e.accountId === q.accountId) && (!q.paymentIntent || e.stripe?.paymentIntent === q.paymentIntent) && (!q.type || e.type === q.type)
            && (!q.types || q.types.includes(e.type)) && (!q.since || e.createdAt >= q.since) && (!q.until || e.createdAt < q.until)).map(e => ({ ...e }));
    }
    async createDrive(d) {
        const drive = { ...d, id: randomUUID() };
        this.drives.set(drive.id, drive);
        return { ...drive };
    }
    async getDrive(id) { const d = this.drives.get(id); return d ? { ...d } : null; }
    async updateDrive(id, set) { const d = this.drives.get(id); if (d)
        Object.assign(d, set); }
    async countDrives(q) {
        return [...this.drives.values()].filter(d => d.accountId === q.accountId && d.startedAt >= q.since && (q.refunded === undefined || !!d.refunded === q.refunded)).length;
    }
    async saveLoginCode(c) {
        const code = { ...c, id: randomUUID() };
        this.codes.set(code.id, code);
        return { ...code };
    }
    async findLoginCode(q) {
        const all = [...this.codes.values()].filter(c => 'tokenHash' in q ? c.tokenHash === q.tokenHash : c.email === q.email);
        const latest = all.sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime())[0];
        return latest ? { ...latest } : null;
    }
    async updateLoginCode(id, set) { const c = this.codes.get(id); if (c)
        Object.assign(c, set); }
    async rateHit(key, windowMs, max) {
        const now = Date.now(), r = this.rates.get(key);
        if (!r || r.until <= now) {
            this.rates.set(key, { until: now + windowMs, n: 1 });
            return true;
        }
        if (r.n >= max)
            return false;
        r.n++;
        return true;
    }
    async flag(kind, data) { this.flagged.push({ id: randomUUID(), kind, data, createdAt: new Date() }); }
    async flags(q = {}) {
        const state = q.state ?? 'all';
        return this.flagged.filter(f => state === 'all' || (state === 'open') === !f.resolvedAt).reverse().slice(0, 200).map(f => ({ ...f }));
    }
    async resolveFlag(id, by, note) {
        const f = this.flagged.find(x => x.id === id);
        if (!f || f.resolvedAt)
            return false;
        Object.assign(f, { resolvedAt: new Date(), resolvedBy: by, note });
        return true;
    }
    newest() { return [...this.accounts.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()); }
    async listAccounts(q) {
        const t = q.search?.trim().toLowerCase();
        return this.newest().filter(a => !t || a.email?.includes(t) || a.referralCode.toLowerCase() === t || a.id === t).slice(0, q.limit).map(a => ({ ...a, allowances: { ...a.allowances } }));
    }
    async findAccounts(ids) { return ids.flatMap(id => { const a = this.accounts.get(id); return a ? [{ ...a }] : []; }); }
    async countAccounts(q) {
        return [...this.accounts.values()].filter(a => (!q.since || a.createdAt >= q.since) && (!q.paid || !!a.firstPaidAt) && (!q.referred || !!a.referredBy)).length;
    }
    async heldTotals() {
        let sessions = 0, allowances = 0;
        for (const a of this.accounts.values()) {
            sessions += a.balance;
            allowances += Object.values(a.allowances ?? {}).reduce((n, v) => n + (v ?? 0), 0);
        }
        return { sessions, allowances };
    }
    async listDrives(q) {
        return [...this.drives.values()].filter(d => (!q.accountId || d.accountId === q.accountId) && (!q.since || d.startedAt >= q.since))
            .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime()).slice(0, q.limit).map(d => ({ ...d }));
    }
    async referrers() {
        const by = new Map();
        for (const a of this.accounts.values()) {
            if (!a.referredBy)
                continue;
            const r = by.get(a.referredBy) ?? { referrerId: a.referredBy, joined: 0, paid: 0 };
            r.joined++;
            if (a.firstPaidAt)
                r.paid++;
            by.set(a.referredBy, r);
        }
        return [...by.values()].sort((a, b) => b.joined - a.joined);
    }
    async saveVisitEvents(events) { this.visits.push(...events.map(e => ({ ...e }))); }
    async visitEvents(since, limit) { return this.visits.filter(e => e.at >= since).sort((a, b) => a.at.getTime() - b.at.getTime()).slice(0, limit); }
    async driveCounts(since) {
        const n = countDrives();
        for (const d of this.drives.values())
            if (d.startedAt >= since && d.status !== 'unpaid')
                addDrive(n, d, 1);
        return n;
    }
}
export const countDrives = () => ({ lesson: 0, test: 0, free: 0, failed: 0, total: 0, completed: { lesson: 0, test: 0, free: 0 }, ended: {} });
export function addDrive(n, d, count) {
    n.total += count;
    n[d.mode] += count;
    if (d.status === 'failed')
        n.failed += count;
    if (d.status === 'completed')
        n.completed[d.mode] += count;
    if (d.status === 'ended')
        n.ended[d.outcome ?? 'abandoned'] = (n.ended[d.outcome ?? 'abandoned'] ?? 0) + count;
}
