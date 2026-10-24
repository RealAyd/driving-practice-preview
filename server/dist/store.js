import { randomUUID } from 'node:crypto';
export class MemoryStore {
    accounts = new Map();
    entries = [];
    drives = new Map();
    codes = new Map();
    rates = new Map();
    flagged = [];
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
        return this.entries.filter(e => (!q.accountId || e.accountId === q.accountId) && (!q.paymentIntent || e.stripe?.paymentIntent === q.paymentIntent) && (!q.type || e.type === q.type));
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
    async flags() { return [...this.flagged]; }
}
