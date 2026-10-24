import { randomUUID } from 'node:crypto';
import { MongoClient, MongoServerError } from 'mongodb';
import { MongoSupportStore } from './mongoSupportStore.js';
const out = (d) => {
    if (!d)
        return null;
    const { _id, ...rest } = d;
    return { ...rest, id: _id };
};
const duplicate = (e) => e instanceof MongoServerError && e.code === 11000;
/** Text typed into the admin search, matched literally. */
const literal = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The hosted store: one database (e.g. dp_sim_staging), its own collections and indexes. */
export class MongoStore {
    db;
    support;
    constructor(db) {
        this.db = db;
        this.support = new MongoSupportStore(db);
    }
    static async connect(uri) {
        const client = new MongoClient(uri);
        await client.connect();
        const store = new MongoStore(client.db());
        await store.indexes();
        await store.support.indexes();
        return store;
    }
    get accounts() { return this.db.collection('accounts'); }
    get entries() { return this.db.collection('ledger_entries'); }
    get drives() { return this.db.collection('drives'); }
    get codes() { return this.db.collection('login_codes'); }
    get rates() { return this.db.collection('rate_limits'); }
    get flagged() { return this.db.collection('flags'); }
    async indexes() {
        // Sparse: an Apple account without an email, or accounts without a provider, do not collide.
        await this.accounts.createIndex({ email: 1 }, { unique: true, sparse: true });
        await this.accounts.createIndex({ emailKey: 1 });
        await this.accounts.createIndex({ googleSub: 1 }, { unique: true, sparse: true });
        await this.accounts.createIndex({ appleSub: 1 }, { unique: true, sparse: true });
        await this.accounts.createIndex({ referralCode: 1 }, { unique: true });
        await this.accounts.createIndex({ referredBy: 1 }, { sparse: true });
        await this.entries.createIndex({ idempotencyKey: 1 }, { unique: true });
        await this.entries.createIndex({ accountId: 1, createdAt: 1 });
        await this.entries.createIndex({ 'stripe.paymentIntent': 1 }, { sparse: true });
        await this.entries.createIndex({ type: 1, createdAt: 1 });
        await this.accounts.createIndex({ createdAt: -1 });
        await this.drives.createIndex({ startedAt: -1 });
        await this.flagged.createIndex({ resolvedAt: 1, createdAt: -1 });
        await this.drives.createIndex({ accountId: 1, startedAt: -1 });
        await this.codes.createIndex({ tokenHash: 1 });
        await this.codes.createIndex({ email: 1, expiresAt: -1 });
        // Expired sign-in codes and rate-limit windows are removed by the database.
        await this.codes.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 24 * 3600 });
        await this.rates.createIndex({ until: 1 }, { expireAfterSeconds: 0 });
    }
    async findAccount(q) {
        const [k, v] = Object.entries(q)[0];
        return out(await this.accounts.findOne(k === 'id' ? { _id: v } : { [k]: v }));
    }
    async createAccount(a) {
        const doc = { ...a, _id: randomUUID(), balance: 0, createdAt: new Date() };
        // Absent (not null) fields keep sparse unique indexes sparse.
        if (doc.email === null)
            delete doc.email;
        try {
            await this.accounts.insertOne(doc);
        }
        catch (e) {
            if (duplicate(e))
                return null;
            throw e;
        }
        return out(doc);
    }
    async updateAccount(id, set) {
        await this.accounts.updateOne({ _id: id }, { $set: set });
    }
    async countReferred(referrerId) { return this.accounts.countDocuments({ referredBy: referrerId }); }
    async claimStarter(accountId, checkoutSession) {
        const won = await this.accounts.updateOne({ _id: accountId, starterCheckout: { $exists: false } }, { $set: { starterCheckout: checkoutSession, starterBought: true } });
        if (won.modifiedCount === 1)
            return 'won';
        const a = await this.accounts.findOne({ _id: accountId }, { projection: { starterCheckout: 1 } });
        return a?.starterCheckout === checkoutSession ? 'same' : 'lost';
    }
    async appendLedger(e, opts = {}) {
        const doc = { ...e, _id: randomUUID(), createdAt: new Date() };
        const field = e.pot ? `allowances.${e.pot}` : 'balance';
        if (opts.requireBalance && e.sessionsDelta < 0) {
            // Take the sessions first (only if there are enough: one atomic update, so two drives started at once cannot
            // both have the last one), then record why; undone if this was recorded already.
            const taken = await this.accounts.updateOne({ _id: e.accountId, [field]: { $gte: -e.sessionsDelta } }, { $inc: { [field]: e.sessionsDelta } });
            if (taken.modifiedCount === 0)
                return 'insufficient';
            try {
                await this.entries.insertOne(doc);
            }
            catch (err) {
                await this.accounts.updateOne({ _id: e.accountId }, { $inc: { [field]: -e.sessionsDelta } });
                if (duplicate(err))
                    return 'duplicate';
                throw err;
            }
            return 'ok';
        }
        // The unique idempotency key first: a webhook delivered twice (even at the same moment) moves the balance once.
        try {
            await this.entries.insertOne(doc);
        }
        catch (err) {
            if (duplicate(err))
                return 'duplicate';
            throw err;
        }
        await this.accounts.updateOne({ _id: e.accountId }, { $inc: { [field]: e.sessionsDelta } });
        return 'ok';
    }
    async ledger(q) {
        const filter = {};
        if (q.accountId)
            filter['accountId'] = q.accountId;
        if (q.paymentIntent)
            filter['stripe.paymentIntent'] = q.paymentIntent;
        if (q.type)
            filter['type'] = q.type;
        else if (q.types)
            filter['type'] = { $in: q.types };
        if (q.since || q.until)
            filter['createdAt'] = { ...(q.since ? { $gte: q.since } : {}), ...(q.until ? { $lt: q.until } : {}) };
        return (await this.entries.find(filter).sort({ createdAt: 1 }).toArray()).map(d => out(d));
    }
    async createDrive(d) {
        const doc = { ...d, _id: randomUUID() };
        await this.drives.insertOne(doc);
        return out(doc);
    }
    async getDrive(id) { return out(await this.drives.findOne({ _id: id })); }
    async updateDrive(id, set) { await this.drives.updateOne({ _id: id }, { $set: set }); }
    async countDrives(q) {
        return this.drives.countDocuments({ accountId: q.accountId, startedAt: { $gte: q.since }, ...(q.refunded === undefined ? {} : q.refunded ? { refunded: true } : { refunded: { $ne: true } }) });
    }
    async saveLoginCode(c) {
        const doc = { ...c, _id: randomUUID() };
        await this.codes.insertOne(doc);
        return out(doc);
    }
    async findLoginCode(q) {
        return out(await this.codes.findOne(q, { sort: { expiresAt: -1 } }));
    }
    async updateLoginCode(id, set) { await this.codes.updateOne({ _id: id }, { $set: set }); }
    async rateHit(key, windowMs, max) {
        const now = new Date();
        const r = await this.rates.findOneAndUpdate({ _id: key, until: { $gt: now } }, { $inc: { n: 1 } }, { returnDocument: 'after' });
        if (r)
            return r.n <= max;
        try {
            await this.rates.updateOne({ _id: key }, { $set: { until: new Date(now.getTime() + windowMs), n: 1 } }, { upsert: true });
        }
        catch (e) {
            if (!duplicate(e))
                throw e;
        }
        return true;
    }
    async flag(kind, data) {
        await this.flagged.insertOne({ _id: randomUUID(), kind, data, createdAt: new Date() });
    }
    async flags(q = {}) {
        const state = q.state ?? 'all';
        const filter = state === 'open' ? { resolvedAt: { $exists: false } } : state === 'resolved' ? { resolvedAt: { $exists: true } } : {};
        return (await this.flagged.find(filter).sort({ createdAt: -1 }).limit(200).toArray()).map(d => out(d));
    }
    async resolveFlag(id, by, note) {
        const r = await this.flagged.updateOne({ _id: id, resolvedAt: { $exists: false } }, { $set: { resolvedAt: new Date(), resolvedBy: by, note } });
        return r.modifiedCount === 1;
    }
    async listAccounts(q) {
        const t = q.search?.trim().toLowerCase();
        const filter = t ? { $or: [{ email: { $regex: literal(t) } }, { referralCode: t.toUpperCase() }, { _id: t }] } : {};
        return (await this.accounts.find(filter).sort({ createdAt: -1 }).limit(q.limit).toArray()).map(d => out(d));
    }
    async findAccounts(ids) {
        return ids.length ? (await this.accounts.find({ _id: { $in: ids } }).toArray()).map(d => out(d)) : [];
    }
    async countAccounts(q) {
        return this.accounts.countDocuments({ ...(q.since ? { createdAt: { $gte: q.since } } : {}), ...(q.paid ? { firstPaidAt: { $exists: true } } : {}), ...(q.referred ? { referredBy: { $exists: true } } : {}) });
    }
    async heldTotals() {
        const [t] = await this.accounts.aggregate([{ $group: { _id: null, sessions: { $sum: '$balance' },
                    allowances: { $sum: { $add: [{ $ifNull: ['$allowances.lesson', 0] }, { $ifNull: ['$allowances.test', 0] }, { $ifNull: ['$allowances.free', 0] }] } } } }]).toArray();
        return { sessions: t?.sessions ?? 0, allowances: t?.allowances ?? 0 };
    }
    async listDrives(q) {
        const filter = { ...(q.accountId ? { accountId: q.accountId } : {}), ...(q.since ? { startedAt: { $gte: q.since } } : {}) };
        return (await this.drives.find(filter).sort({ startedAt: -1 }).limit(q.limit).toArray()).map(d => out(d));
    }
    async referrers() {
        return this.accounts.aggregate([{ $match: { referredBy: { $exists: true } } },
            { $group: { _id: '$referredBy', joined: { $sum: 1 }, paid: { $sum: { $cond: [{ $ifNull: ['$firstPaidAt', false] }, 1, 0] } } } },
            { $sort: { joined: -1 } }, { $limit: 500 }, { $project: { _id: 0, referrerId: '$_id', joined: 1, paid: 1 } }]).toArray();
    }
    async driveCounts(since) {
        const rows = await this.drives.aggregate([{ $match: { startedAt: { $gte: since }, status: { $ne: 'unpaid' } } },
            { $group: { _id: { mode: '$mode', status: '$status' }, n: { $sum: 1 } } }]).toArray();
        const n = { lesson: 0, test: 0, free: 0, failed: 0, total: 0 };
        for (const r of rows) {
            n.total += r.n;
            n[r._id.mode] += r.n;
            if (r._id.status === 'failed')
                n.failed += r.n;
        }
        return n;
    }
}
