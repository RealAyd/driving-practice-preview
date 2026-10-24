import { randomUUID } from 'node:crypto';
export const OPEN_STATES = ['awaiting_admin', 'in_progress', 'awaiting_customer', 'reopened'];
const copy = (o) => ({ ...o });
export class MemorySupportStore {
    n = 0;
    tickets = new Map();
    msgs = [];
    files = new Map();
    outbox = [];
    async nextTicketNumber() { return ++this.n; }
    async createTicket(t) { const ticket = { ...t, id: randomUUID() }; this.tickets.set(ticket.id, ticket); return copy(ticket); }
    async getTicket(id) { const t = this.tickets.get(id); return t ? copy(t) : null; }
    async updateTicket(id, set, unset = []) {
        const t = this.tickets.get(id);
        if (!t)
            return;
        Object.assign(t, set);
        for (const k of unset)
            delete t[k];
    }
    async listTickets(q) {
        return [...this.tickets.values()].filter(t => (!q.accountId || t.accountId === q.accountId) && (!q.states || q.states.includes(t.state)))
            .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).slice(0, q.limit).map(copy);
    }
    async countTickets(q) {
        return [...this.tickets.values()].filter(t => (!q.states || q.states.includes(t.state)) && (q.overdue === undefined || t.overdue === q.overdue)).length;
    }
    async claimDueReminder(now, next) {
        const t = [...this.tickets.values()].find(x => x.nextReminderAt && x.nextReminderAt <= now);
        if (!t)
            return null;
        Object.assign(t, { nextReminderAt: next, overdue: true, reminders: t.reminders + 1 });
        return copy(t);
    }
    async addMessage(m) { const msg = { ...m, id: randomUUID(), createdAt: new Date() }; this.msgs.push(msg); return copy(msg); }
    async messages(ticketId) { return this.msgs.filter(m => m.ticketId === ticketId).map(copy); }
    async saveAttachment(a) { const f = { ...a, id: randomUUID(), createdAt: new Date() }; this.files.set(f.id, f); return copy(f); }
    async getAttachment(id) { const f = this.files.get(id); return f && (!f.expiresAt || f.expiresAt > new Date()) ? copy(f) : null; }
    async claimAttachment(id, claimHash, ticketId) {
        const f = this.files.get(id);
        if (!f || f.ticketId || f.claimHash !== claimHash || (f.expiresAt && f.expiresAt <= new Date()))
            return false;
        f.ticketId = ticketId;
        delete f.expiresAt;
        return true;
    }
    async enqueue(item, at = new Date()) {
        const o = { ...item, id: randomUUID(), createdAt: new Date(), status: 'pending', attempts: 0, nextAttemptAt: at };
        this.outbox.push(o);
        return copy(o);
    }
    async claimOutbox(now, leaseUntil) {
        const o = this.outbox.find(x => x.status === 'pending' && x.nextAttemptAt <= now);
        if (!o)
            return null;
        o.nextAttemptAt = leaseUntil;
        o.attempts++;
        return copy(o);
    }
    async updateOutbox(id, set) { const o = this.outbox.find(x => x.id === id); if (o)
        Object.assign(o, set); }
    async listOutbox(q) {
        return this.outbox.filter(o => (!q.status || o.status === q.status) && (!q.ticketId || o.ticketId === q.ticketId)).reverse().slice(0, q.limit).map(copy);
    }
    async getOutbox(id) { const o = this.outbox.find(x => x.id === id); return o ? copy(o) : null; }
}
