import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { profileOf } from './profile.js';
import { centreName, centreOf, cleanName, shown, tally, weekStart } from './board.js';
import { freshTrial } from './store.js';
import { Support } from './support.js';
/** A pass's price as the app says it: "£4.99", "£14.99 a month". */
export function priceText(p) {
    const symbol = p.currency.toLowerCase() === 'gbp' ? '£' : `${p.currency.toUpperCase()} `;
    return `${symbol}${(p.amountPence / 100).toFixed(2)}${p.interval ? ` a ${p.interval}` : ''}`;
}
/** Whether a pack can be bought now: it has a link in this mode, is not retired, and its sale has not ended (UK days). */
export function onSale(p, mode, now = new Date()) {
    if (p.retired || !p.links[mode])
        return false;
    return !p.saleEnds || now.getTime() <= new Date(`${p.saleEnds}T23:59:59Z`).getTime();
}
/** The end of an unlimited pass bought (or renewed) now, on top of any time already held. */
export function passUntil(held, unlimited, now = new Date()) {
    const from = new Date(Math.max(now.getTime(), held?.getTime() ?? 0));
    // (A renewing pass gets a day's grace, so a renewal that arrives a little late does not interrupt it.)
    if (unlimited.monthly) {
        const d = new Date(from);
        d.setUTCMonth(d.getUTCMonth() + 1);
        return new Date(d.getTime() + 86400_000);
    }
    return new Date(from.getTime() + (unlimited.days ?? 7) * 86400_000 + (unlimited.renews ? 86400_000 : 0));
}
/** What a drive is, from its scenario id (the browser's own description of it is not trusted). */
export function modeOf(scenario) {
    return scenario.endsWith('-mock-test') ? 'test' : scenario.endsWith('-lesson') ? 'lesson' : 'free';
}
const SCENARIO = /^[a-z0-9][a-z0-9-]{0,79}$/;
const POTS = ['lesson', 'test', 'free'];
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const sameHash = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
/** Referral codes: no 0/O or 1/I/L, so they can be read out. */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
/** Invite a friend: each of you gets this many sessions (the friend on joining, the inviter once the friend completes a drive). */
export const REFERRAL_SESSIONS = 2;
/** The most an inviter earns from invites in any 30 days. */
export const REFERRAL_CAP_30_DAYS = 10;
const referralCode = () => Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
export const normaliseEmail = (email) => email.trim().toLowerCase();
/** One person behind several aliases: Gmail ignores dots and anything after +; other providers commonly ignore +. */
export function emailKey(email) {
    const [local = '', domain = ''] = normaliseEmail(email).split('@');
    const base = local.split('+')[0];
    const gmail = domain === 'gmail.com' || domain === 'googlemail.com';
    return `${gmail ? base.replace(/\./g, '') : base}@${gmail ? 'gmail.com' : domain}`;
}
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Whether a verified email is one of ADMIN_EMAILS, by alias (a Gmail address with dots or a +tag still counts). */
export const isAdminEmail = (config, email) => !!email && config.adminEmails.some(a => emailKey(a) === emailKey(email));
/** A sign-in code lasts this long; this many wrong guesses end it. */
const CODE_MINUTES = 15, CODE_ATTEMPTS = 5;
/** Partial refunds below this, in all on one payment, leave the sessions as they are without review (£5). */
const SMALL_PARTIAL_REFUND_PENCE = 500;
/** A drive that fails to load within this long of starting gives its session back; at most this many a day. */
const REFUND_WINDOW_MS = 15 * 60_000, REFUNDS_PER_DAY = 3;
/** New free tries from one address in a day (a device's try is in its cookie; this stops clearing it for more). Many
 * phones share one address (mobile networks, a school or office Wi-Fi), so it is well above one household's. */
export const TRIALS_PER_IP_PER_DAY = 30;
/** A lesson id as the app names them; at most this many kept. */
const LESSON_ID = /^[a-z0-9-]{1,40}$/, MAX_LESSONS = 100;
export class Service {
    config;
    store;
    mail;
    ids;
    stripe;
    /** Support requests (tickets, the response timer, the notification outbox). */
    support;
    constructor(config, store, mail, ids, stripe, pusher = null) {
        this.config = config;
        this.store = store;
        this.mail = mail;
        this.ids = ids;
        this.stripe = stripe;
        this.support = new Support(config, store, mail, pusher);
    }
    // ---- Accounts and referrals ----
    /**
     * Signs in with a verified identity, creating the account the first time. A new account that arrived through a
     * referral link gets its free drive (once per person, by email alias).
     */
    async signIn(provider, id, ref) {
        const email = id.email && id.emailVerified ? normaliseEmail(id.email) : null;
        const bySub = provider === 'google' ? await this.store.findAccount({ googleSub: id.sub }) : provider === 'apple' ? await this.store.findAccount({ appleSub: id.sub }) : null;
        if (bySub)
            return bySub;
        const byEmail = email ? await this.store.findAccount({ email }) : null;
        if (byEmail) {
            // The same person with another way in: linked by the verified email.
            if (provider === 'google')
                await this.store.updateAccount(byEmail.id, { googleSub: id.sub });
            if (provider === 'apple')
                await this.store.updateAccount(byEmail.id, { appleSub: id.sub });
            return (await this.store.findAccount({ id: byEmail.id }));
        }
        if (!email && provider !== 'apple')
            throw new Error('A verified email is needed');
        const key = email ? emailKey(email) : null;
        // Someone who had an account under another alias does not count as new for the free drive.
        const known = key ? await this.store.findAccount({ emailKey: key }) : null;
        let created = null;
        for (let tries = 0; !created && tries < 5; tries++) {
            created = await this.store.createAccount({ email, emailKey: key, referralCode: referralCode(),
                ...(provider === 'google' ? { googleSub: id.sub } : provider === 'apple' ? { appleSub: id.sub } : {}) });
            // (A clash is the email, signed up a moment ago by another request, or a referral code: look again.)
            if (!created && email) {
                const again = await this.store.findAccount({ email });
                if (again)
                    return again;
            }
        }
        if (!created)
            throw new Error('Could not create the account');
        if (ref)
            await this.applyReferral(created, ref.trim().toUpperCase(), !!known);
        return (await this.store.findAccount({ id: created.id }));
    }
    async applyReferral(account, code, knownPerson) {
        const referrer = await this.store.findAccount({ referralCode: code });
        if (!referrer || referrer.id === account.id)
            return;
        if (knownPerson || (referrer.emailKey && referrer.emailKey === account.emailKey)) {
            await this.store.flag('referral-refused', { account: account.id, referrer: referrer.id, why: knownPerson ? 'already had an account (email alias)' : 'own link' });
            return;
        }
        await this.store.updateAccount(account.id, { referredBy: referrer.id });
        await this.store.appendLedger({ product: 'simulator', accountId: account.id, type: 'referral_free_drive', sessionsDelta: REFERRAL_SESSIONS, amountPence: 0, currency: 'gbp',
            actor: 'system', reason: `Free drives: invited by ${referrer.referralCode}`, idempotencyKey: `referral-free:${account.id}` });
        // Many sign-ups on one code in a day are for a person to look at (not refused).
        if (!await this.store.rateHit(`referrals:${referrer.id}`, 24 * 3600_000, 10))
            await this.store.flag('referral-volume', { referrer: referrer.id, code });
    }
    async me(accountId) {
        const a = await this.store.findAccount({ id: accountId });
        if (!a)
            return null;
        const ledger = await this.store.ledger({ accountId });
        return {
            // (The id goes on the Payment Link as client_reference_id, so the webhook knows whose payment it is.)
            id: a.id, email: a.email, balance: a.balance, allowances: Object.fromEntries(POTS.map(p => [p, a.allowances?.[p] ?? 0])), starterBought: !!a.starterBought, referralCode: a.referralCode,
            invited: await this.store.countReferred(a.id), rewarded: ledger.filter(e => e.type === 'referral_bonus').reduce((n, e) => n + e.sessionsDelta, 0),
            history: ledger.slice(-20).reverse().map(e => ({ type: e.type, sessions: e.sessionsDelta, amountPence: e.amountPence, reason: e.reason, at: e.createdAt.toISOString() })),
            admin: isAdminEmail(this.config, a.email),
            unlimitedUntil: a.unlimitedUntil && a.unlimitedUntil.getTime() > Date.now() ? a.unlimitedUntil.toISOString() : null,
            lessonsDone: a.lessonsDone ?? []
        };
    }
    /** Adds lessons finished (on any device) to the account's; returns them all. */
    async saveProgress(accountId, lessons) {
        const a = await this.store.findAccount({ id: accountId });
        if (!a)
            return [];
        const all = [...new Set([...(a.lessonsDone ?? []), ...lessons.filter(l => LESSON_ID.test(l))])].slice(0, MAX_LESSONS);
        if (all.length !== (a.lessonsDone ?? []).length)
            await this.store.updateAccount(accountId, { lessonsDone: all });
        return all;
    }
    // ---- Email sign-in: a 6-digit code (typed into the app) and a link (opens in the browser) ----
    async requestEmailCode(rawEmail, ip, ref) {
        const email = normaliseEmail(rawEmail);
        if (!EMAIL.test(email) || email.length > 254)
            return 'invalid';
        if (!await this.store.rateHit(`email:${email}`, 3600_000, 5) || !await this.store.rateHit(`ip:${ip}`, 3600_000, 30))
            return 'slow-down';
        const code = String(randomInt(1_000_000)).padStart(6, '0'), token = randomBytes(32).toString('base64url');
        await this.store.saveLoginCode({ email, tokenHash: sha256(token), codeHash: sha256(`${email}:${code}`), expiresAt: new Date(Date.now() + CODE_MINUTES * 60_000), attempts: 0, ...(ref ? { ref } : {}) });
        const link = `${this.config.appBaseUrl}/api/auth/email/verify?token=${token}`;
        await this.mail.send({ to: email, subject: `Your Driving Practice sign-in code: ${code}`,
            text: `Your sign-in code is ${code}\n\nType it into Driving Practice, or open this link on the same device:\n${link}\n\nIt works once, for ${CODE_MINUTES} minutes. If you did not ask for it, ignore this email.`,
            html: `<p>Your sign-in code is</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>Type it into Driving Practice, or <a href="${link}">sign in with this link</a> on the same device.</p><p style="color:#666">It works once, for ${CODE_MINUTES} minutes. If you did not ask for it, ignore this email.</p>` });
        return 'sent';
    }
    async verifyEmailCode(rawEmail, code) {
        const email = normaliseEmail(rawEmail);
        const c = await this.store.findLoginCode({ email });
        if (!c || c.usedAt || c.expiresAt < new Date() || c.attempts >= CODE_ATTEMPTS)
            return null;
        if (!sameHash(c.codeHash, sha256(`${email}:${code.trim()}`))) {
            await this.store.updateLoginCode(c.id, { attempts: c.attempts + 1 });
            return null;
        }
        await this.store.updateLoginCode(c.id, { usedAt: new Date() });
        return this.signIn('email', { sub: email, email, emailVerified: true }, c.ref);
    }
    async verifyEmailToken(token) {
        const c = await this.store.findLoginCode({ tokenHash: sha256(token) });
        if (!c || c.usedAt || c.expiresAt < new Date())
            return null;
        await this.store.updateLoginCode(c.id, { usedAt: new Date() });
        return this.signIn('email', { sub: c.email, email: c.email, emailVerified: true }, c.ref);
    }
    async signInWith(provider, credential, ref) {
        const id = provider === 'google' ? await this.ids.google(credential) : await this.ids.apple(credential);
        return this.signIn(provider, id, ref);
    }
    // ---- Drives: a session is used when a drive is completed (not when it starts) ----
    /**
     * A drive starts with a session to use (general sessions, or any Starter Pass drive left on an older account);
     * nothing is taken until it is completed (completeDrive).
     */
    async startDrive(accountId, kind, scenario) {
        if (!SCENARIO.test(scenario))
            return { ok: false, reason: 'no-sessions' };
        const mode = modeOf(scenario);
        const account = await this.store.findAccount({ id: accountId });
        if (!account)
            return { ok: false, reason: 'no-sessions' };
        // The admins (ADMIN_EMAILS) drive without using sessions: recorded as a drive, nothing taken.
        const admin = isAdminEmail(this.config, account.email);
        // An unlimited pass: every drive, nothing used.
        if (!admin && account.unlimitedUntil && account.unlimitedUntil.getTime() > Date.now()) {
            const drive = await this.store.createDrive({ accountId, owner: accountId, kind: kind.slice(0, 40), scenario, mode, paidFrom: 'pass', startedAt: new Date(), status: 'started' });
            return { ok: true, drive, balance: account.balance };
        }
        if (!admin && account.balance <= 0 && !POTS.some(p => (account.allowances?.[p] ?? 0) > 0))
            return { ok: false, reason: 'no-sessions' };
        const drive = await this.store.createDrive({ accountId, owner: accountId, kind: kind.slice(0, 40), scenario, mode, paidFrom: admin ? 'admin' : 'sessions',
            ...(admin ? {} : { due: true }), startedAt: new Date(), status: 'started' });
        return { ok: true, drive, balance: account.balance };
    }
    /**
     * A completed drive uses its session (once): a Starter Pass drive of its kind left on an older account first, then a
     * general session, then any Starter Pass drive. If another drive completed meanwhile used the last one, the balance
     * goes below zero (drives stop until topped up) and a person is told.
     */
    async completeDrive(d) {
        if (!d.due)
            return;
        const take = (pot, requireBalance) => this.store.appendLedger({ product: 'simulator', accountId: d.accountId, type: 'consumed', sessionsDelta: -1,
            ...(pot ? { pot } : {}), amountPence: 0, currency: 'gbp', actor: 'customer', reason: `${d.kind}: ${d.scenario}`, idempotencyKey: `drive:${d.id}` }, { requireBalance });
        if (d.paidFrom === 'trial') {
            await this.store.moveTrial(d.accountId.slice(6), d.mode, -1);
            await this.store.updateDrive(d.id, { due: false });
            return;
        }
        let paidFrom = null;
        for (const pot of [d.mode, undefined, ...POTS.filter(p => p !== d.mode)]) {
            const r = await take(pot, true);
            if (r === 'duplicate')
                return;
            if (r === 'ok') {
                paidFrom = pot ?? 'sessions';
                break;
            }
        }
        if (!paidFrom) {
            if (await take(undefined, false) === 'ok')
                await this.store.flag('completed-without-session', { account: d.accountId, drive: d.id });
            paidFrom = 'sessions';
        }
        await this.store.updateDrive(d.id, { paidFrom, due: false });
        await this.rewardInviter(d.accountId);
    }
    /** A friend who joined with an invite link has completed a drive: whoever invited them gets their sessions (once per friend, up to the cap). */
    async rewardInviter(accountId) {
        const friend = await this.store.findAccount({ id: accountId });
        if (!friend?.referredBy)
            return;
        const key = `referral-bonus:${friend.id}`;
        const earned = await this.store.ledger({ accountId: friend.referredBy, type: 'referral_bonus' });
        if (earned.some(e => e.idempotencyKey === key))
            return;
        const recent = earned.filter(e => e.createdAt.getTime() > Date.now() - 30 * 86400_000).reduce((n, e) => n + e.sessionsDelta, 0);
        // (Over the cap: nothing now; the friend's next completed drive tries again.)
        if (recent + REFERRAL_SESSIONS > REFERRAL_CAP_30_DAYS)
            return;
        await this.store.appendLedger({ product: 'simulator', accountId: friend.referredBy, type: 'referral_bonus', sessionsDelta: REFERRAL_SESSIONS, amountPence: 0, currency: 'gbp',
            actor: 'system', reason: 'Free drives: a friend you invited completed a drive', idempotencyKey: key });
    }
    /**
     * Recently completed drives, for the home screen's "Recently practised": what was practised (its scenario id and kind)
     * and how long ago, nothing about who. The admins' own drives are left out. Newest first, at most `limit`, last 7 days.
     */
    async recent(limit = 8) {
        const now = Date.now();
        const drives = await this.store.listDrives({ since: new Date(now - 7 * 86400_000), limit: 500 });
        return drives.filter(d => d.status === 'completed' && d.endedAt && d.paidFrom !== 'admin')
            .sort((a, b) => b.endedAt.getTime() - a.endedAt.getTime()).slice(0, limit)
            .map(d => ({ scenario: d.scenario, mode: d.mode, secondsAgo: Math.max(0, Math.round((now - d.endedAt.getTime()) / 1000)) }));
    }
    // ---- The free try (no sign-up): TRIAL_EACH lessons, mock tests and free drives per device ----
    /** What is left of a device's free try (all of it before the first drive). */
    async trialLeft(trialId) {
        const t = trialId ? await this.store.getTrial(trialId) : null;
        return t ? { ...t.remaining } : freshTrial();
    }
    /**
     * A drive on the device's free try: the try is made on the first drive (rate-limited by address), then each kind
     * can be completed TRIAL_EACH times (one is used when a drive is completed). Returns the try's id (for the device's
     * cookie) with the outcome.
     */
    async startTrialDrive(trialId, ip, kind, scenario, owner) {
        if (!SCENARIO.test(scenario))
            return { trialId, start: { ok: false, reason: 'trial-used' } };
        let trial = trialId ? await this.store.getTrial(trialId) : null;
        if (!trial) {
            if (!await this.store.rateHit(`trial-ip:${ip}`, 24 * 3600_000, TRIALS_PER_IP_PER_DAY))
                return { trialId: null, start: { ok: false, reason: 'slow-down' } };
            trial = await this.store.createTrial();
        }
        const mode = modeOf(scenario);
        if ((trial.remaining[mode] ?? 0) <= 0)
            return { trialId: trial.id, start: { ok: false, reason: 'trial-used' } };
        const drive = await this.store.createDrive({ accountId: `trial:${trial.id}`, ...(owner ? { owner } : {}), kind: kind.slice(0, 40), scenario, mode, paidFrom: 'trial', due: true, startedAt: new Date(), status: 'started' });
        return { trialId: trial.id, start: { ok: true, drive, balance: 0 } };
    }
    /** The app reports how the drive went: a completed one uses its session; one that failed to load used nothing. */
    async driveStatus(accountId, driveId, status, outcome, result) {
        const d = await this.store.getDrive(driveId);
        if (!d || d.accountId !== accountId || d.status === 'unpaid')
            return false;
        if (status === 'completed' && d.status !== 'completed')
            await this.completeDrive(d);
        // (A drive paid at its start, before sessions were used on completion: one that fails to load gives it back.)
        if (status === 'failed' && !d.due && d.status === 'started' && d.paidFrom !== 'admin' && d.paidFrom !== 'pass' && !d.refunded && Date.now() - d.startedAt.getTime() <= REFUND_WINDOW_MS) {
            // A free try's drive goes back to the try (once).
            if (d.paidFrom === 'trial') {
                await this.store.updateDrive(driveId, { status, refunded: true });
                await this.store.moveTrial(accountId.slice(6), d.mode, 1);
                return true;
            }
            const today = await this.store.countDrives({ accountId, since: new Date(Date.now() - 24 * 3600_000), refunded: true });
            if (today >= REFUNDS_PER_DAY) {
                await this.store.flag('drive-refunds', { account: accountId, drive: driveId });
                await this.store.updateDrive(driveId, { status });
                return true;
            }
            const r = await this.store.appendLedger({ product: 'simulator', accountId, type: 'drive_refund', sessionsDelta: 1, ...(d.paidFrom !== 'sessions' ? { pot: d.paidFrom } : {}),
                amountPence: 0, currency: 'gbp', actor: 'system', reason: 'The drive did not load', idempotencyKey: `drive-refund:${driveId}` });
            await this.store.updateDrive(driveId, { status, refunded: r === 'ok' || r === 'duplicate' });
            return true;
        }
        // Finished drives stay finished (a late 'loaded' does not undo one; a completed one is never made 'ended').
        if (d.status === 'completed' || (d.status === 'ended' && status !== 'completed'))
            return true;
        if (status === 'completed' || status === 'ended')
            await this.store.updateDrive(driveId, { status, endedAt: new Date(),
                outcome: status === 'completed' ? 'completed' : outcome && outcome !== 'completed' ? outcome : 'abandoned', ...(result ? { result } : {}) });
        else
            await this.store.updateDrive(driveId, { status });
        return true;
    }
    /** The signed-in learner's profile (profile.ts), from their last 500 drives. */
    async profile(accountId) {
        return profileOf(await this.store.listDrives({ owner: accountId, limit: 500 }));
    }
    // ---- Leaderboards (board.ts) ----
    /** The learner chooses whether and how they show: their own or a made-up name, and a driving school if they like. */
    async setBoard(accountId, raw) {
        const a = await this.store.findAccount({ id: accountId });
        if (!a)
            return { error: 'name' };
        const show = raw['show'] === true, name = cleanName(raw['name']);
        if (show && !name)
            return { error: 'name' };
        const schoolRaw = typeof raw['school'] === 'string' ? raw['school'].trim() : '';
        const school = schoolRaw ? cleanName(schoolRaw, 2, 40) : null;
        if (schoolRaw && !school)
            return { error: 'school' };
        const board = { show, name: name ?? a.board?.name ?? '', ...(school ? { school } : {}), ...(a.board?.hidden ? { hidden: true } : {}) };
        await this.store.updateAccount(accountId, { board });
        return { ok: true, board };
    }
    /** One centre's board for one week: the top ten, where the learner is, and last week's leader. */
    async board(accountId, centreKey) {
        const now = new Date(), from = weekStart(now), lastFrom = weekStart(new Date(from.getTime() - 86400_000));
        const mine = await this.store.listDrives({ owner: accountId, limit: 50 });
        const centre = centreKey ?? (mine.find(d => d.result?.test) ? centreOf(mine.find(d => d.result?.test).scenario) : null);
        const a = await this.store.findAccount({ id: accountId });
        const settings = a?.board ?? { show: false, name: '' };
        if (!centre)
            return { centre: null, settings, top: [], me: null, leader: null, week: { from: from.toISOString() } };
        const drives = await this.store.listDrives({ since: lastFrom, limit: 20000 });
        const thisWeek = tally(drives.filter(d => d.endedAt && d.endedAt >= from), centre);
        const lastWeek = tally(drives.filter(d => d.endedAt && d.endedAt >= lastFrom && d.endedAt < from), centre);
        const people = new Map((await this.store.findAccounts([...new Set([...thisWeek.slice(0, 10), ...lastWeek.slice(0, 1)].map(r => r.owner))])).map(x => [x.id, x]));
        const meAt = thisWeek.findIndex(r => r.owner === accountId);
        return { centre, name: centreName(centre), week: { from: from.toISOString() }, settings,
            top: thisWeek.slice(0, 10).map((r, i) => ({ rank: i + 1, ...shown(people.get(r.owner)), points: r.points, tests: r.tests, passes: r.passes, me: r.owner === accountId })),
            me: meAt < 0 ? null : { rank: meAt + 1, points: thisWeek[meAt].points, of: thisWeek.length },
            leader: lastWeek[0] ? { ...shown(people.get(lastWeek[0].owner)), points: lastWeek[0].points } : null };
    }
    /** Admin: each centre's leader for a week (last week unless `weekOf` says), with whether their prize was given. */
    async leaders(weekOf) {
        const from = weekStart(weekOf ?? new Date(Date.now() - 7 * 86400_000)), to = new Date(from.getTime() + 7 * 86400_000 + 3 * 3600_000);
        const drives = (await this.store.listDrives({ since: new Date(from.getTime() - 86400_000), limit: 20000 })).filter(d => d.endedAt && d.endedAt >= from && weekStart(d.endedAt) <= from && d.endedAt < to);
        const centres = [...new Set(drives.map(d => centreOf(d.scenario)))];
        const awarded = new Set((await this.store.ledger({ type: 'promo' })).map(e => e.idempotencyKey));
        const out = [];
        for (const centre of centres) {
            const rows = tally(drives, centre).slice(0, 3);
            if (!rows.length)
                continue;
            const people = new Map((await this.store.findAccounts(rows.map(r => r.owner))).map(x => [x.id, x]));
            out.push({ centre, name: centreName(centre), week: from.toISOString(), awarded: awarded.has(`leader:${from.toISOString()}:${centre}`),
                top: rows.map(r => ({ account: r.owner, email: people.get(r.owner)?.email ?? null, ...shown(people.get(r.owner)), points: r.points, tests: r.tests, passes: r.passes,
                    referredBy: people.get(r.owner)?.referredBy ?? null })) });
        }
        return { week: from.toISOString(), centres: out.sort((a, b) => b.top[0].points - a.top[0].points) };
    }
    /** Admin: give a centre's leader of the week their prize (7 unlimited days), and the friend who invited them too; once. */
    async awardLeader(by, centre, week) {
        const from = new Date(week);
        if (Number.isNaN(from.getTime()))
            return { error: 'not-found' };
        const list = await this.leaders(from);
        const c = list.centres.find(x => x.centre === centre);
        const winner = c?.top[0];
        if (!c || !winner)
            return { error: 'not-found' };
        const key = `leader:${list.week}:${centre}`;
        const grant = async (accountId, reason, idempotencyKey) => {
            const r = await this.store.appendLedger({ product: 'simulator', accountId, type: 'promo', sessionsDelta: 0, amountPence: 0, currency: 'gbp', actor: 'admin', by, reason, idempotencyKey });
            if (r !== 'ok')
                return false;
            const a = await this.store.findAccount({ id: accountId });
            await this.store.updateAccount(accountId, { unlimitedUntil: passUntil(a?.unlimitedUntil, { days: 7 }) });
            return true;
        };
        if (!await grant(winner.account, `Leader of the week: ${c.name} (7 days unlimited)`, key))
            return { error: 'already' };
        let referrer = null;
        if (winner.referredBy && await grant(winner.referredBy, `A friend you invited was leader of the week: ${c.name} (7 days unlimited)`, `${key}:ref`))
            referrer = winner.referredBy;
        return { ok: true, winner: winner.account, referrer };
    }
    /** Admin: hide (or show again) a learner's chosen name on the boards. */
    async hideOnBoard(accountId, hidden) {
        const a = await this.store.findAccount({ id: accountId });
        if (!a)
            return false;
        await this.store.updateAccount(accountId, { board: { ...(a.board ?? { show: false, name: '' }), hidden } });
        return true;
    }
    // ---- Payments (Stripe Payment Links) ----
    /** The packs on sale in this mode, as the app shows them. */
    packs() {
        // (Prices come from Stripe, looked up at most hourly in the background; a pack's own price until then.)
        if (Date.now() - this.pricesAt > 3600_000)
            void this.refreshPrices();
        return this.config.packs.filter(p => !p.retired).map(p => ({ id: p.id, label: p.label, price: this.prices.get(p.links[this.config.stripeMode]) ?? p.price,
            description: p.description ?? '', sessions: p.sessions, allowances: p.allowances ?? {}, starter: !!p.starter,
            ...(p.unlimited ? { unlimited: p.unlimited } : {}), ...(p.saleEnds ? { saleEnds: p.saleEnds } : {}), ...(p.deal ? { deal: p.deal } : {}), ...(p.sticker ? { sticker: p.sticker } : {}), onSale: onSale(p, this.config.stripeMode),
            // Staging (sign-in first) shows the passes sold live, to see them as they will look; they are bought on the live site.
            ...(this.config.signInFirst && !onSale(p, this.config.stripeMode) && onSale(p, 'live') ? { preview: true } : {}) }));
    }
    prices = new Map();
    pricesAt = 0;
    async refreshPrices() {
        this.pricesAt = Date.now();
        if (!this.stripe?.linkPrices)
            return;
        try {
            for (const p of await this.stripe.linkPrices())
                this.prices.set(p.url, priceText(p));
        }
        catch (e) {
            console.error(`Stripe prices could not be read: ${e instanceof Error ? e.message.slice(0, 200) : 'error'}`);
        }
    }
    /**
     * The address to pay for a pack: its Payment Link with this account as the client reference (the webhook credits
     * that account). The Starter Pass is not offered to an account that has it.
     */
    async checkoutUrl(accountId, packId) {
        const pack = this.config.packs.find(p => p.id === packId);
        if (!pack)
            return { error: 'unknown-pack' };
        const link = pack.links[this.config.stripeMode];
        if (!link || !onSale(pack, this.config.stripeMode))
            return { error: 'not-on-sale' };
        const a = await this.store.findAccount({ id: accountId });
        if (!a)
            return { error: 'unknown-pack' };
        if (pack.starter && a.starterBought)
            return { error: 'starter-bought' };
        const url = new URL(link);
        url.searchParams.set('client_reference_id', a.id);
        if (a.email)
            url.searchParams.set('prefilled_email', a.email);
        return { url: url.toString() };
    }
    /** The pack a paid Payment Link sells: the link is looked up with Stripe and matched to the server's own packs. */
    async packForLink(linkId, amountPence) {
        if (!linkId || !this.stripe)
            return null;
        let link;
        try {
            link = await this.stripe.paymentLink(linkId);
        }
        catch (e) {
            // Stripe could not be asked (most often: the key cannot read Payment Links). Said in the log; the pack is then
            // the one whose price is exactly what was paid (a discounted payment cannot be told apart: flagged instead).
            console.error(`Stripe Payment Link lookup failed (${linkId}): ${e instanceof Error ? e.message.slice(0, 200) : 'error'}. Check the key can read Payment Links.`);
            const byPrice = this.config.packs.filter(p => Math.round(Number(p.price.replace(/[^\d.]/g, '')) * 100) === amountPence);
            return byPrice.length === 1 ? byPrice[0] : null;
        }
        if (!link)
            return null;
        const known = this.config.packs.find(p => p.links[this.config.stripeMode] === link.url);
        if (known)
            return known;
        // Not listed: its metadata `sessions` (general sessions only; never a Starter Pass).
        const fromMeta = Number(link.metadata['sessions']);
        return Number.isInteger(fromMeta) && fromMeta > 0 && fromMeta <= 100 ? { id: `link-${linkId}`, label: 'Sessions', price: '', sessions: fromMeta, links: { test: '', live: '' } } : null;
    }
    /** Since this server started: webhook deliveries accepted and refused (for the admin hub). */
    webhookStats = { received: 0, lastReceivedAt: null, refused: 0, lastRefusedAt: null };
    async stripeWebhook(raw, signature) {
        let event;
        // (Logged without anything secret: whether deliveries arrive, and whether they are signed with this endpoint's secret.)
        try {
            event = this.stripe.constructEvent(raw, signature);
        }
        catch {
            this.webhookStats.refused++;
            this.webhookStats.lastRefusedAt = new Date();
            console.log(`Stripe webhook refused: the signature does not match STRIPE_WEBHOOK_SECRET (${raw.length} bytes)`);
            return 'bad-signature';
        }
        this.webhookStats.received++;
        this.webhookStats.lastReceivedAt = new Date();
        console.log(`Stripe webhook: ${event.type} ${event.id}`);
        await this.handleStripeEvent(event);
        return 'ok';
    }
    async handleStripeEvent(event) {
        const o = event.data.object;
        switch (event.type) {
            case 'checkout.session.completed':
            case 'checkout.session.async_payment_succeeded': {
                // Paid, or nothing to pay (a 100% promotion code); card payments arrive as 'paid' here. Others wait for
                // async_payment_succeeded.
                const status = o['payment_status'];
                if (status !== 'paid' && status !== 'no_payment_required')
                    return;
                await this.credit(event, o);
                return;
            }
            case 'charge.refunded': {
                const pi = typeof o['payment_intent'] === 'string' ? o['payment_intent'] : null;
                const entries = pi ? await this.store.ledger({ paymentIntent: pi }) : [];
                const purchase = entries.find(e => e.type === 'purchase');
                if (!purchase) {
                    await this.store.flag('refund-unmatched', { event: event.id, paymentIntent: pi });
                    return;
                }
                // A second Starter Pass refunded by this service: nothing was granted, so only the money is recorded.
                if (entries.some(e => e.type === 'starter_duplicate')) {
                    await this.store.appendLedger({ product: 'simulator', accountId: purchase.accountId, type: 'refund', sessionsDelta: 0, amountPence: -Number(o['amount_refunded'] ?? 0),
                        currency: String(o['currency'] ?? 'gbp'), actor: 'stripe', stripe: { event: event.id, paymentIntent: pi, charge: String(o['id']) },
                        reason: 'Second Starter Pass refunded', idempotencyKey: `refund:${String(o['id'])}` });
                    return;
                }
                const full = o['refunded'] === true || o['amount_refunded'] === o['amount'];
                const charge = String(o['id']), currency = String(o['currency'] ?? 'gbp');
                // Stripe gives the total refunded so far on this payment: the money already recorded for it is taken off.
                const refundedTotal = Number(o['amount_refunded'] ?? (full ? purchase.amountPence : 0));
                const recorded = -entries.filter(e => e.type === 'refund' && e.stripe?.charge === charge).reduce((n, e) => n + e.amountPence, 0);
                if (!full) {
                    // A partial refund (a goodwill gesture, a promotion code that was missed): the money is recorded and the
                    // sessions stay. Under £5 in all on this payment that is all; from £5 a person decides about the sessions.
                    if (refundedTotal <= recorded)
                        return;
                    const small = refundedTotal < SMALL_PARTIAL_REFUND_PENCE;
                    await this.store.appendLedger({ product: 'simulator', accountId: purchase.accountId, type: 'refund', sessionsDelta: 0, amountPence: -(refundedTotal - recorded), currency,
                        actor: 'stripe', stripe: { event: event.id, paymentIntent: pi, charge }, reason: small ? 'Partial refund (sessions kept)' : 'Partial refund (sessions under review)',
                        idempotencyKey: `refund:${charge}:${refundedTotal}` });
                    if (!small)
                        await this.store.flag('partial-refund', { event: event.id, account: purchase.accountId, paymentIntent: pi, amountRefunded: refundedTotal });
                    return;
                }
                // General sessions come back even if spent (the balance can go below zero: drives stop until topped up).
                await this.store.appendLedger({ product: 'simulator', accountId: purchase.accountId, type: 'refund', sessionsDelta: -purchase.sessionsDelta,
                    amountPence: -Math.max(0, refundedTotal - recorded), currency, actor: 'stripe',
                    stripe: { event: event.id, paymentIntent: pi, charge }, reason: 'Payment refunded', idempotencyKey: `refund:${charge}` });
                // Starter allowances: each unused one is taken back; one already used stays used (flagged for a person).
                for (const grant of entries.filter(e => e.type === 'allowance' && e.sessionsDelta > 0)) {
                    const r = await this.store.appendLedger({ product: 'simulator', accountId: purchase.accountId, type: 'refund', sessionsDelta: -grant.sessionsDelta, pot: grant.pot,
                        amountPence: 0, currency: String(o['currency'] ?? 'gbp'), actor: 'stripe', stripe: { event: event.id, paymentIntent: pi, charge },
                        reason: 'Payment refunded', idempotencyKey: `refund:${charge}:${grant.pot}` }, { requireBalance: true });
                    if (r === 'insufficient')
                        await this.store.flag('refund-after-use', { account: purchase.accountId, paymentIntent: pi, pot: grant.pot });
                }
                // An unlimited pass refunded in full: it ends now.
                if (this.config.packs.some(p => p.unlimited && purchase.reason.startsWith(p.label)))
                    await this.store.updateAccount(purchase.accountId, { unlimitedUntil: new Date() });
                // A referral reward that this payment earned stays with the referrer (they did nothing wrong).
                return;
            }
            case 'invoice.paid': {
                // A renewing pass renewed (the first payment is the checkout's): unlimited to the end of the period now paid for.
                if (o['billing_reason'] === 'subscription_create')
                    return;
                const parent = o['parent'];
                const sub = typeof o['subscription'] === 'string' ? o['subscription'] : parent?.subscription_details?.subscription;
                const account = sub ? await this.store.findAccount({ subscription: sub }) : null;
                if (!account) {
                    await this.store.flag('renewal-no-account', { event: event.id, invoice: o['id'], subscription: sub ?? null });
                    return;
                }
                const packId = account.subscriptions?.find(s => s.id === sub)?.pack;
                const pack = this.config.packs.find(p => p.id === packId);
                const pi = typeof o['payment_intent'] === 'string' ? o['payment_intent'] : undefined;
                const r = await this.store.appendLedger({ product: 'simulator', accountId: account.id, type: 'purchase', sessionsDelta: 0, amountPence: Number(o['amount_paid'] ?? 0),
                    currency: String(o['currency'] ?? 'gbp'), actor: 'stripe', stripe: { event: event.id, ...(pi ? { paymentIntent: pi } : {}) }, reason: `${pack?.label ?? 'Pass'} renewed`,
                    idempotencyKey: `invoice:${String(o['id'])}` });
                if (r !== 'ok')
                    return;
                // The period paid for, from the invoice (weekly or monthly alike); the pack's own length if Stripe does not say.
                const lines = o['lines'];
                const end = Number(lines?.data?.[0]?.period?.end ?? 0) * 1000;
                const until = end > Date.now() ? new Date(Math.max(end + 86400_000, account.unlimitedUntil?.getTime() ?? 0)) : passUntil(account.unlimitedUntil, pack?.unlimited ?? { monthly: true });
                await this.store.updateAccount(account.id, { unlimitedUntil: until });
                return;
            }
            case 'charge.dispute.created':
                await this.store.flag('dispute', { event: event.id, charge: o['charge'], amount: o['amount'], reason: o['reason'] });
                return;
        }
    }
    /**
     * Back from paying: Stripe is asked for this account's completed checkouts of the last two days, and any the
     * webhook has not credited yet are credited now (the same steps, keyed on the checkout, so nothing is ever credited
     * twice whichever comes first). Crediting then does not depend on the webhook arriving.
     */
    async reconcile(accountId) {
        const a = await this.store.findAccount({ id: accountId });
        if (!a)
            return { error: 'not-found' };
        if (!this.stripe)
            return { error: 'unavailable' };
        if (!await this.store.rateHit(`reconcile:${accountId}`, 600_000, 30))
            return { error: 'slow-down' };
        let sessions;
        try {
            sessions = await this.stripe.recentCheckouts(new Date(Date.now() - 48 * 3600_000));
        }
        catch (e) {
            console.error(`Stripe checkout lookup failed: ${e instanceof Error ? e.message.slice(0, 200) : 'error'}. Check the key can read Checkout Sessions.`);
            return { error: 'unavailable' };
        }
        const credited = new Set((await this.store.ledger({ accountId })).map(e => e.stripe?.checkoutSession).filter(Boolean));
        const email = a.email;
        let n = 0;
        for (const o of sessions) {
            const ref = typeof o['client_reference_id'] === 'string' ? o['client_reference_id'] : null;
            const payer = o['customer_details']?.email;
            // Its own (by the reference the server put on the link), or paid without one from this account's email.
            const mine = ref ? ref === a.id : !!email && !!payer && normaliseEmail(payer) === email;
            const paid = o['payment_status'] === 'paid' || o['payment_status'] === 'no_payment_required';
            if (!mine || !paid || credited.has(String(o['id'])))
                continue;
            await this.credit({ id: 'reconcile', type: 'checkout.session.completed', data: { object: o } }, o);
            n++;
        }
        if (n)
            console.log(`Stripe reconcile: ${n} checkout(s) credited that the webhook had not delivered`);
        return { credited: n };
    }
    /**
     * A paid checkout: every step is idempotent (keys on the checkout), so a webhook delivered twice, or two deliveries
     * at the same moment, grant once, and a delivery that stopped part-way finishes on the retry.
     */
    async credit(event, o) {
        const sessionId = String(o['id']);
        const ref = typeof o['client_reference_id'] === 'string' ? o['client_reference_id'] : null;
        const details = o['customer_details'];
        const account = (ref ? await this.store.findAccount({ id: ref }) : null)
            ?? (details?.email ? await this.store.findAccount({ email: normaliseEmail(details.email) }) : null);
        const linkId = typeof o['payment_link'] === 'string' ? o['payment_link'] : null;
        const pack = await this.packForLink(linkId, Number(o['amount_total'] ?? 0));
        if (!account || !pack) {
            await this.store.flag(account ? 'payment-unknown-pack' : 'payment-no-account', { event: event.id, checkoutSession: sessionId, paymentLink: linkId, email: details?.email ?? null, ref });
            return;
        }
        const amount = Number(o['amount_total'] ?? 0), currency = String(o['currency'] ?? 'gbp');
        const pi = typeof o['payment_intent'] === 'string' ? o['payment_intent'] : undefined;
        const stripe = { event: event.id, checkoutSession: sessionId, ...(pi ? { paymentIntent: pi } : {}), ...(linkId ? { paymentLink: linkId } : {}) };
        // A Starter Pass is once per account: a second one grants nothing (its payment is refunded).
        const lost = pack.starter && await this.store.claimStarter(account.id, sessionId) === 'lost';
        // The payment itself (the money, and the pack's sessions).
        const recorded = await this.store.appendLedger({ product: 'simulator', accountId: account.id, type: amount > 0 ? 'purchase' : 'promo', sessionsDelta: lost ? 0 : pack.sessions, amountPence: amount,
            currency, actor: 'stripe', stripe, reason: pack.label, idempotencyKey: `checkout:${sessionId}` });
        if (lost) {
            await this.duplicateStarter(account.id, sessionId, pi, amount, currency);
            return;
        }
        // An unlimited pass: time on the account (once per checkout, whichever of the webhook or the return from paying is first).
        if (pack.unlimited && recorded === 'ok') {
            const sub = typeof o['subscription'] === 'string' ? o['subscription'] : undefined;
            await this.store.updateAccount(account.id, { unlimitedUntil: passUntil(account.unlimitedUntil, pack.unlimited),
                ...(sub ? { subscriptions: [...(account.subscriptions ?? []).filter(s => s.id !== sub), { id: sub, pack: pack.id }] } : {}) });
        }
        if (pack.starter) {
            for (const pot of POTS) {
                const n = pack.allowances?.[pot] ?? 0;
                if (n > 0)
                    await this.store.appendLedger({ product: 'simulator', accountId: account.id, type: 'allowance', sessionsDelta: n, pot, amountPence: 0, currency, actor: 'stripe', stripe,
                        reason: `${pack.label}: ${pot === 'test' ? 'mock test' : pot === 'free' ? 'free drive' : 'lesson'}`, idempotencyKey: `checkout:${sessionId}:${pot}` });
            }
        }
        if (amount > 0 && !account.firstPaidAt)
            await this.store.updateAccount(account.id, { firstPaidAt: new Date() });
    }
    /**
     * A second Starter Pass (the Payment Link is public, so it can be paid twice): nothing is granted and the payment
     * is refunded in full straight away. If Stripe refuses the refund it is flagged for a person to refund by hand.
     */
    async duplicateStarter(accountId, sessionId, pi, amount, currency) {
        const first = await this.store.appendLedger({ product: 'simulator', accountId, type: 'starter_duplicate', sessionsDelta: 0, amountPence: 0, currency, actor: 'system',
            ...(pi ? { stripe: { checkoutSession: sessionId, paymentIntent: pi } } : {}),
            reason: amount > 0 ? 'Starter Pass already bought: this payment is refunded' : 'Starter Pass already bought: not granted again', idempotencyKey: `starter-duplicate:${sessionId}` });
        if (first !== 'ok' || amount <= 0 || !pi)
            return;
        const refunded = await this.stripe.refund(pi, 'Starter Pass already bought on this account').catch(() => false);
        if (!refunded)
            await this.store.flag('starter-duplicate-refund-needed', { account: accountId, checkoutSession: sessionId, paymentIntent: pi, amountPence: amount });
    }
}
