import { createHash, randomBytes } from 'node:crypto';
import { NOTICE_WINDOW_MS, NotLinkedError, cleanDemand, parseEntitlement, premiumConfirmed, verifyNotice } from './practical.js';
/**
 * Practical Premium in the simulator (Release 2, off unless PRACTICAL_PREMIUM=1): a learner's active Premium opens
 * unlimited sessions while Practical says it is active, checked afresh at each launch. It is never a credit, a pass or
 * a copied flag: balances, Starter allowances, unlimitedUntil, subscriptions and the ledger are not touched here.
 * A check that fails grants nothing: there is no grace period and no stored check opens a later drive.
 */
/** How long linking may take between leaving for Practical's sign-in and coming back (ms). */
export const LINK_STATE_MS = 10 * 60_000;
/** How long Practical has to answer a check before it counts as not confirmed (ms). */
export const CHECK_TIMEOUT_MS = 5_000;
const sha = (s) => createHash('sha256').update(s).digest('hex');
const b64url = (b) => b.toString('base64url');
export class Premium {
    store;
    api;
    options;
    now;
    constructor(store, api, options, now = () => new Date()) {
        this.store = store;
        this.api = api;
        this.options = options;
        this.now = now;
    }
    /** Linking, begun by the signed-in learner: a one-time state and the PKCE challenge to send to Practical's sign-in. */
    async startLink(accountId, redirectUri = '/') {
        const state = b64url(randomBytes(32)), verifier = b64url(randomBytes(48));
        await this.store.saveState({ stateHash: sha(state), accountId, verifier, expiresAt: new Date(this.now().getTime() + LINK_STATE_MS) });
        const codeChallenge = b64url(createHash('sha256').update(verifier).digest());
        return { state, codeChallenge, codeChallengeMethod: 'S256', authorizeUrl: this.api.authorizeUrl({ state, codeChallenge, redirectUri }) };
    }
    /** What the app needs to show: the scenarios open first to Premium (none once the owner opens them to everyone). */
    get premiumFirstList() { return this.options.generalAvailability ? [] : this.options.premiumFirst; }
    /**
     * For the admin hub: links now; the last `days` days of checks; and Premium drives as recorded (`drives`, the main
     * store's count of drives paid from Premium): a confirmed check is not a drive (a launch can stop after it).
     */
    async report(drives, days = 30) {
        const since = new Date(this.now().getTime() - days * 86400_000);
        return { linked: await this.store.linkCount(), days, checks: await this.store.checkCounts(since), drives: await drives(since) };
    }
    /**
     * Back from Practical's sign-in: the state (once, for this same account, in time) and the code, exchanged server to
     * server for the verified Practical account. No email is matched: this is the only way accounts are linked.
     */
    async finishLink(accountId, state, code) {
        const s = await this.store.takeState(sha(state), this.now());
        if (!s || s.accountId !== accountId)
            return { ok: false, reason: 'state' };
        let practicalAccountId;
        try {
            ({ practicalAccountId } = await this.api.exchangeCode(code, s.verifier));
        }
        catch {
            return { ok: false, reason: 'code' };
        }
        const at = this.now();
        if (await this.store.link({ accountId, practicalAccountId, linkedAt: at, consentAt: at }) === 'taken')
            return { ok: false, reason: 'taken' };
        return { ok: true, practicalAccountId };
    }
    /** Unlinked: Premium ends for this account at once; nothing bought is touched. */
    unlink(accountId) { return this.store.unlink(accountId); }
    /**
     * Asks Practical now, records the answer, and says what it allows. 'confirmed': an active learner Premium (premiumConfirmed).
     * 'inactive': Practical said plainly there is none (no Premium, an instructor's access, ended). 'unconfirmed': it
     * could not say: unreachable, too slow, an answer out of shape or stale, or a status or end it does not know. Only
     * 'confirmed' opens anything, and only for this launch.
     */
    async check(accountId, reason) {
        const link = await this.store.findLink({ accountId });
        if (!link)
            return { state: 'unlinked' };
        const at = this.now(), base = { accountId, practicalAccountId: link.practicalAccountId, at, reason };
        const failed = async (error) => {
            const c = await this.store.recordCheck({ ...base, result: 'error', type: null, status: null, expiry: null, expiresAt: null, error });
            return { state: 'unconfirmed', checkId: c.id };
        };
        let raw;
        try {
            raw = await Promise.race([this.api.entitlement(link.practicalAccountId),
                new Promise((_, fail) => { setTimeout(() => fail(new Error('timeout')), CHECK_TIMEOUT_MS).unref?.(); })]);
        }
        catch (err) {
            // (Consent withdrawn at Practical: the link ends here too, recorded; the learner can link again.)
            if (err instanceof NotLinkedError) {
                await this.store.recordCheck({ ...base, result: 'inactive', type: null, status: null, expiry: null, expiresAt: null, error: 'withdrawn' });
                await this.store.unlink(accountId);
                return { state: 'unlinked' };
            }
            return failed(String(err instanceof Error ? err.message : err).slice(0, 120));
        }
        const e = parseEntitlement(raw);
        if (!e)
            return failed('malformed');
        const ok = premiumConfirmed(e, at);
        // (Plainly none: no Premium, an instructor's access, or one that has ended. Anything Practical could not vouch for,
        // or an answer not made just now, is not "none": the learner is asked before a session is used.)
        const ended = e.status === 'inactive' || e.type !== 'learner_premium' || e.expiry.kind === 'at' && Date.parse(e.expiry.at) <= at.getTime();
        const fresh = Math.abs(at.getTime() - Date.parse(e.checkedAt)) <= 60_000;
        const result = ok ? 'confirmed' : ended && fresh ? 'inactive' : 'error';
        const c = await this.store.recordCheck({ ...base, result, type: e.type, status: e.status, expiry: e.expiry.kind,
            expiresAt: e.expiry.kind === 'at' ? new Date(e.expiry.at) : null, ...(result === 'error' ? { error: fresh ? 'unverified' : 'stale' } : {}) });
        return ok ? { state: 'confirmed', checkId: c.id } : result === 'inactive' ? { state: 'inactive', checkId: c.id } : { state: 'unconfirmed', checkId: c.id };
    }
    /** Whether a scenario is one that opens first to verified learner Premium (until the owner opens it to everyone). */
    premiumFirst(scenario) {
        return !this.options.generalAvailability && this.options.premiumFirst.includes(scenario);
    }
    /** A notice from Practical: verified, then a fresh check for the account it names. It grants nothing by itself. */
    async notice(body, timestamp, signature) {
        const n = verifyNotice(body, timestamp, signature, this.options.noticeSecret, this.now().getTime());
        if (!n)
            return 'refused';
        // (Each event once: a replay inside the signature's window is answered, and does nothing.)
        if (!await this.store.claimEvent(n.eventId, new Date(this.now().getTime() + 2 * NOTICE_WINDOW_MS)))
            return 'repeat';
        const link = await this.store.findLink({ practicalAccountId: n.practicalAccountId });
        if (!link)
            return 'unknown-account';
        await this.check(link.accountId, 'notice');
        return 'checked';
    }
    /** The learner's own view: linked or not, and what Practical says now. */
    async status(accountId) {
        const r = await this.check(accountId, 'status');
        return r.state === 'unlinked' ? { linked: false, premium: null } : { linked: true, premium: r.state };
    }
    /** New test-centre requests, as Practical sends them, cut to what the simulator may see. */
    async centreDemand() {
        try {
            return cleanDemand(await this.api.centreDemand());
        }
        catch {
            return null;
        }
    }
}
