import { randomUUID } from 'node:crypto';
import { MongoServerError } from 'mongodb';
export class MemoryPremiumStore {
    links = [];
    states = new Map();
    log = [];
    async link(l) {
        if (this.links.some(x => x.accountId === l.accountId || x.practicalAccountId === l.practicalAccountId))
            return 'taken';
        this.links.push({ ...l });
        return 'ok';
    }
    async findLink(q) {
        const l = 'accountId' in q ? this.links.find(x => x.accountId === q.accountId) : this.links.find(x => x.practicalAccountId === q.practicalAccountId);
        return l ? { ...l } : null;
    }
    async unlink(accountId) { const i = this.links.findIndex(x => x.accountId === accountId); if (i < 0)
        return false; this.links.splice(i, 1); return true; }
    async saveState(s) { this.states.set(s.stateHash, { ...s }); }
    async takeState(stateHash, now) {
        const s = this.states.get(stateHash);
        this.states.delete(stateHash);
        return s && s.expiresAt.getTime() > now.getTime() ? s : null;
    }
    async recordCheck(c) { const x = { ...c, id: randomUUID() }; this.log.push(x); return { ...x }; }
    async checks(accountId, limit = 20) { return this.log.filter(c => c.accountId === accountId).slice(-limit).reverse(); }
    events = new Map();
    async claimEvent(eventId, until) { if (this.events.has(eventId))
        return false; this.events.set(eventId, until); return true; }
    async checkCounts(since) {
        const n = { confirmed: 0, inactive: 0, error: 0 };
        for (const c of this.log)
            if (c.at.getTime() >= since.getTime())
                n[c.result]++;
        return n;
    }
    async linkCount() { return this.links.length; }
}
export class MongoPremiumStore {
    db;
    constructor(db) {
        this.db = db;
    }
    get links() { return this.db.collection('practical_links'); }
    get states() { return this.db.collection('practical_link_states'); }
    get log() { return this.db.collection('entitlement_checks'); }
    get events() { return this.db.collection('practical_notice_events'); }
    async indexes() {
        // One Practical account to one simulator account, both ways.
        await this.links.createIndex({ practicalAccountId: 1 }, { unique: true });
        await this.states.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
        await this.log.createIndex({ accountId: 1, at: -1 });
        await this.log.createIndex({ at: -1 });
        await this.events.createIndex({ until: 1 }, { expireAfterSeconds: 0 });
    }
    async link(l) {
        try {
            await this.links.insertOne({ _id: l.accountId, accountId: l.accountId, practicalAccountId: l.practicalAccountId, linkedAt: l.linkedAt, consentAt: l.consentAt });
            return 'ok';
        }
        catch (e) {
            if (e instanceof MongoServerError && e.code === 11000)
                return 'taken';
            throw e;
        }
    }
    async findLink(q) {
        const d = await this.links.findOne('accountId' in q ? { _id: q.accountId } : { practicalAccountId: q.practicalAccountId });
        return d ? { accountId: d._id, practicalAccountId: d.practicalAccountId, linkedAt: d.linkedAt, consentAt: d.consentAt } : null;
    }
    async unlink(accountId) { return (await this.links.deleteOne({ _id: accountId })).deletedCount === 1; }
    async saveState(s) { await this.states.insertOne({ _id: s.stateHash, ...s }); }
    async takeState(stateHash, now) {
        const d = await this.states.findOneAndDelete({ _id: stateHash });
        return d && d.expiresAt.getTime() > now.getTime() ? { stateHash: d.stateHash, accountId: d.accountId, verifier: d.verifier, expiresAt: d.expiresAt } : null;
    }
    async recordCheck(c) { const id = randomUUID(); await this.log.insertOne({ _id: id, ...c }); return { ...c, id }; }
    async checks(accountId, limit = 20) {
        return (await this.log.find({ accountId }, { sort: { at: -1 }, limit }).toArray()).map(({ _id, ...rest }) => ({ ...rest, id: _id }));
    }
    async claimEvent(eventId, until) {
        try {
            await this.events.insertOne({ _id: eventId, until });
            return true;
        }
        catch (e) {
            if (e instanceof MongoServerError && e.code === 11000)
                return false;
            throw e;
        }
    }
    async checkCounts(since) {
        const n = { confirmed: 0, inactive: 0, error: 0 };
        for (const r of await this.log.aggregate([{ $match: { at: { $gte: since } } }, { $group: { _id: '$result', n: { $sum: 1 } } }]).toArray())
            n[r._id] = r.n;
        return n;
    }
    async linkCount() { return this.links.countDocuments({}); }
}
