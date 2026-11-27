import { createHmac, timingSafeEqual } from 'node:crypto';
/**
 * The Practical backend, as the simulator's server sees it. PROPOSED: follows the draft contract
 * (RealAyd/Driving-Practice, handover/practical-web-shared-account-migration,
 * docs/RELEASE2-SIMULATOR-PRACTICAL-API-CONTRACT.md), not yet agreed or built on Practical's side. Only the mock below
 * implements it; the feature cannot be turned on outside local fakes until a live client exists (config.ts).
 */
/** Practical's account ids (its ACCOUNT_ID pattern). */
export const PRACTICAL_ID = /^[A-Za-z0-9_\-:.]{1,128}$/;
/**
 * Practical says this account is not linked (the learner withdrew consent there): the link here ends too. Only an
 * authenticated "Not linked" answer, never a Practical that is off or unreachable (that is not confirmed, and asks).
 */
export class NotLinkedError extends Error {
    constructor() { super('Practical: not linked'); }
}
/** Fewer requests than this for a centre are not shown: a handful could point to who asked. */
export const MIN_DEMAND = 3;
/** How old Practical's answer may be (ms), and how far ahead of the simulator's clock it may say it was made. */
export const FRESH_MS = 60_000, CLOCK_SKEW_MS = 5_000;
/** Practical's answer, checked field by field: null when anything is missing, of another kind or out of range. */
export function parseEntitlement(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const o = raw, x = o['expiry'];
    const type = o['type'], status = o['status'], checkedAt = o['checkedAt'];
    if (type !== 'learner_premium' && type !== 'instructor' && type !== 'none')
        return null;
    if (status !== 'active' && status !== 'inactive' && status !== 'unknown')
        return null;
    if (typeof checkedAt !== 'string' || !isoDate(checkedAt))
        return null;
    if (!x || typeof x !== 'object')
        return null;
    let expiry;
    if (x['kind'] === 'never')
        expiry = { kind: 'never' };
    else if (x['kind'] === 'unknown')
        expiry = { kind: 'unknown' };
    else if (x['kind'] === 'at' && typeof x['at'] === 'string' && isoDate(x['at']))
        expiry = { kind: 'at', at: x['at'] };
    else
        return null;
    return { type, status, expiry, checkedAt };
}
const isoDate = (s) => /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$/.test(s) && !Number.isNaN(Date.parse(s));
/**
 * Learner Premium, confirmed: a learner Premium, active, worked out just now, ending at a time still ahead or verified
 * never to end. An instructor's access, an unknown status or end, an expired one or a stale answer: never.
 */
export function premiumConfirmed(e, now = new Date()) {
    if (e.type !== 'learner_premium' || e.status !== 'active')
        return false;
    const age = now.getTime() - Date.parse(e.checkedAt);
    if (age > FRESH_MS || age < -CLOCK_SKEW_MS)
        return false;
    if (e.expiry.kind === 'never')
        return true;
    return e.expiry.kind === 'at' && Date.parse(e.expiry.at) > now.getTime();
}
/** How long a signed notice from Practical stays acceptable (ms): older ones are refused. */
export const NOTICE_WINDOW_MS = 5 * 60_000;
/**
 * A notice from Practical (Premium changed for an account): `{eventId, practicalAccountId}`, signed with the shared
 * secret over `<timestamp>.<raw body>` (HMAC-SHA256, hex; X-DP-Timestamp, X-DP-Signature). Null: unsigned, wrong
 * signature, outside the window or out of shape. Replays inside the window are stopped by eventId (premium.ts).
 * A notice grants nothing: it only starts a fresh check.
 */
export function verifyNotice(body, timestamp, signature, secret, now = Date.now()) {
    if (!secret || !timestamp || !signature || !/^\d{10,13}$/.test(timestamp) || !/^[0-9a-f]{64}$/.test(signature))
        return null;
    const at = timestamp.length <= 10 ? Number(timestamp) * 1000 : Number(timestamp);
    if (Math.abs(now - at) > NOTICE_WINDOW_MS)
        return null;
    const want = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest();
    const got = Buffer.from(signature, 'hex');
    if (got.length !== want.length || !timingSafeEqual(got, want))
        return null;
    try {
        const o = JSON.parse(body);
        const id = (v) => typeof v === 'string' && /^[\w-]{1,100}$/.test(v);
        return id(o.eventId) && typeof o.practicalAccountId === 'string' && PRACTICAL_ID.test(o.practicalAccountId) ? { eventId: o.eventId, practicalAccountId: o.practicalAccountId } : null;
    }
    catch {
        return null;
    }
}
/**
 * Only the fields named in CentreDemand, of the right kinds; anything else Practical sends is dropped. Dates are cut to
 * the day (UTC), centres with fewer than MIN_DEMAND requests are left out (Practical should already do both), and the
 * most requested come first.
 */
export function cleanDemand(rows) {
    const out = [];
    for (const r of rows) {
        if (!r || typeof r !== 'object')
            continue;
        const o = r;
        const text = (v, n) => typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null;
        const centre = text(o['centre'], 120), area = text(o['area'], 12), first = text(o['firstAt'], 40), last = text(o['lastAt'], 40);
        const requests = typeof o['requests'] === 'number' && Number.isInteger(o['requests']) && o['requests'] > 0 ? o['requests'] : null;
        if (centre && area && first && last && requests && requests >= MIN_DEMAND && !Number.isNaN(Date.parse(first)) && !Number.isNaN(Date.parse(last)))
            out.push({ centre, area, requests, firstAt: new Date(first).toISOString().slice(0, 10), lastAt: new Date(last).toISOString().slice(0, 10) });
    }
    return out.sort((a, b) => b.requests - a.requests || a.centre.localeCompare(b.centre));
}
/**
 * The mock's stand-in for Practical's resolver: learner Premium while any one learner grant is active and has not
 * ended, whatever happened to the others (a refund revokes only its own source). A grant whose end is unknown proves
 * nothing; with no other evidence the answer is status unknown.
 */
export function mockResolve(grants, now) {
    const checkedAt = now.toISOString();
    const live = (g) => g.state === 'active' && (g.expiry.kind === 'never' || g.expiry.kind === 'at' && Date.parse(g.expiry.at) > now.getTime());
    const learner = grants.filter(g => g.type === 'learner_premium' && live(g));
    if (learner.some(g => g.expiry.kind === 'never'))
        return { type: 'learner_premium', status: 'active', expiry: { kind: 'never' }, checkedAt };
    if (learner.length) {
        const at = learner.map(g => g.expiry.at).sort().at(-1);
        return { type: 'learner_premium', status: 'active', expiry: { kind: 'at', at }, checkedAt };
    }
    if (grants.some(g => g.type === 'learner_premium' && g.state === 'active' && g.expiry.kind === 'unknown'))
        return { type: 'learner_premium', status: 'unknown', expiry: { kind: 'unknown' }, checkedAt };
    if (grants.some(g => g.type === 'instructor' && live(g)))
        return { type: 'instructor', status: 'active', expiry: { kind: 'unknown' }, checkedAt };
    return { type: 'none', status: 'inactive', expiry: { kind: 'unknown' }, checkedAt };
}
/** The kinds of Practical account the mock's consent page offers. */
export const MOCK_KINDS = ['monthly', 'lifetime', 'expired-plus-manual', 'instructor', 'none', 'unreachable'];
/** Local fakes and tests: a Practical whose accounts, grants and answers are set by hand. */
export class MockPracticalApi {
    now;
    /** code → the Practical account it signs in. */
    codes = new Map();
    /** account → its grants (resolved as Practical would), or 'error' (unreachable), or a raw answer as given. */
    accounts = new Map();
    demand = [];
    calls = 0;
    constructor(now = () => new Date()) {
        this.now = now;
    }
    /** Local fakes: the mock's own consent page (http.ts, dev fakes only). */
    authorizeUrl(p) {
        const q = new URLSearchParams({ state: p.state, code_challenge: p.codeChallenge, code_challenge_method: 'S256', redirect_uri: p.redirectUri });
        return `/api/practical/mock/authorize?${q}`;
    }
    /** Local fakes: a Practical account of one of these kinds, signed in by a new one-time code (for the consent page). */
    consent(kind) {
        const id = `mock-${kind}-${Math.random().toString(36).slice(2, 10)}`, code = `code-${Math.random().toString(36).slice(2, 14)}`;
        const day = 86400_000, at = (d) => ({ kind: 'at', at: new Date(this.now().getTime() + d * day).toISOString() });
        const grants = {
            monthly: [{ source: 'stripe_web', type: 'learner_premium', state: 'active', expiry: at(30) }],
            lifetime: [{ source: 'admin_manual', type: 'learner_premium', state: 'active', expiry: { kind: 'never' } }],
            'expired-plus-manual': [{ source: 'revenuecat', type: 'learner_premium', state: 'active', expiry: at(-3) }, { source: 'admin_manual', type: 'learner_premium', state: 'active', expiry: { kind: 'never' } }],
            instructor: [{ source: 'stripe_web', type: 'instructor', state: 'active', expiry: at(30) }],
            none: [],
            unreachable: 'error',
        };
        this.accounts.set(id, grants[kind]);
        this.codes.set(code, { practicalAccountId: id });
        return code;
    }
    async exchangeCode(code, verifier) {
        const c = this.codes.get(code);
        if (!c || (c.verifier && c.verifier !== verifier))
            throw new Error('invalid code');
        this.codes.delete(code);
        return { practicalAccountId: c.practicalAccountId };
    }
    async entitlement(practicalAccountId) {
        this.calls++;
        const a = this.accounts.get(practicalAccountId);
        if (a === 'error')
            throw new Error('Practical unreachable');
        if (a && !Array.isArray(a))
            return a.raw;
        return mockResolve(a ?? [], this.now());
    }
    async centreDemand() { return this.demand; }
}
