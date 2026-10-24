import { randomUUID } from 'node:crypto';
import { Binary } from 'mongodb';
const out = (d) => {
    if (!d)
        return null;
    const { _id, ...rest } = d;
    return { ...rest, id: _id };
};
/** Support in the hosted database: tickets, ticket_messages, attachments, notification_outbox, counters. */
export class MongoSupportStore {
    db;
    constructor(db) {
        this.db = db;
    }
    get tickets() { return this.db.collection('tickets'); }
    get msgs() { return this.db.collection('ticket_messages'); }
    get files() { return this.db.collection('attachments'); }
    get outbox() { return this.db.collection('notification_outbox'); }
    get counters() { return this.db.collection('counters'); }
    async indexes() {
        await this.tickets.createIndex({ accountId: 1, updatedAt: -1 }, { sparse: true });
        await this.tickets.createIndex({ state: 1, updatedAt: -1 });
        await this.tickets.createIndex({ nextReminderAt: 1 }, { sparse: true });
        await this.msgs.createIndex({ ticketId: 1, createdAt: 1 });
        // Uploads never put on a message are removed by the database.
        await this.files.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
        await this.outbox.createIndex({ status: 1, nextAttemptAt: 1 });
        await this.outbox.createIndex({ ticketId: 1 }, { sparse: true });
    }
    async nextTicketNumber() {
        const r = await this.counters.findOneAndUpdate({ _id: 'ticket' }, { $inc: { n: 1 } }, { upsert: true, returnDocument: 'after' });
        return r.n;
    }
    async createTicket(t) {
        const doc = { ...t, _id: randomUUID() };
        await this.tickets.insertOne(doc);
        return out(doc);
    }
    async getTicket(id) { return out(await this.tickets.findOne({ _id: id })); }
    async updateTicket(id, set, unset = []) {
        await this.tickets.updateOne({ _id: id }, { $set: set, ...(unset.length ? { $unset: Object.fromEntries(unset.map(k => [k, ''])) } : {}) });
    }
    async listTickets(q) {
        const filter = { ...(q.accountId ? { accountId: q.accountId } : {}), ...(q.states ? { state: { $in: [...q.states] } } : {}) };
        return (await this.tickets.find(filter).sort({ updatedAt: -1 }).limit(q.limit).toArray()).map(d => out(d));
    }
    async countTickets(q) {
        return this.tickets.countDocuments({ ...(q.states ? { state: { $in: [...q.states] } } : {}), ...(q.overdue === undefined ? {} : { overdue: q.overdue }) });
    }
    async claimDueReminder(now, next) {
        return out(await this.tickets.findOneAndUpdate({ nextReminderAt: { $lte: now } }, { $set: { nextReminderAt: next, overdue: true }, $inc: { reminders: 1 } }, { returnDocument: 'after' }));
    }
    async addMessage(m) {
        const doc = { ...m, _id: randomUUID(), createdAt: new Date() };
        await this.msgs.insertOne(doc);
        return out(doc);
    }
    async messages(ticketId) {
        return (await this.msgs.find({ ticketId }).sort({ createdAt: 1 }).toArray()).map(d => out(d));
    }
    async saveAttachment(a) {
        const id = randomUUID(), createdAt = new Date();
        await this.files.insertOne({ ...a, _id: id, createdAt, data: new Binary(a.data) });
        return { ...a, id, createdAt };
    }
    async getAttachment(id) {
        const d = await this.files.findOne({ _id: id });
        if (!d || (d.expiresAt && d.expiresAt <= new Date()))
            return null;
        const { _id, data, ...rest } = d;
        return { ...rest, id: _id, data: Buffer.from(data.buffer) };
    }
    async claimAttachment(id, claimHash, ticketId) {
        const r = await this.files.updateOne({ _id: id, claimHash, ticketId: { $exists: false }, expiresAt: { $gt: new Date() } }, { $set: { ticketId }, $unset: { expiresAt: '' } });
        return r.modifiedCount === 1;
    }
    async enqueue(item, at = new Date()) {
        const doc = { ...item, _id: randomUUID(), createdAt: new Date(), status: 'pending', attempts: 0, nextAttemptAt: at };
        await this.outbox.insertOne(doc);
        return out(doc);
    }
    async claimOutbox(now, leaseUntil) {
        return out(await this.outbox.findOneAndUpdate({ status: 'pending', nextAttemptAt: { $lte: now } }, { $set: { nextAttemptAt: leaseUntil }, $inc: { attempts: 1 } }, { sort: { nextAttemptAt: 1 }, returnDocument: 'after' }));
    }
    async updateOutbox(id, set) { await this.outbox.updateOne({ _id: id }, { $set: set }); }
    async listOutbox(q) {
        const filter = { ...(q.status ? { status: q.status } : {}), ...(q.ticketId ? { ticketId: q.ticketId } : {}) };
        return (await this.outbox.find(filter).sort({ createdAt: -1 }).limit(q.limit).toArray()).map(d => out(d));
    }
    async getOutbox(id) { return out(await this.outbox.findOne({ _id: id })); }
}
