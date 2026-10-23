import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const sameHash = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
/** Referral codes: no 0/O or 1/I/L, so they can be read out. */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const referralCode = () => Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
export const normaliseEmail = (email) => email.trim().toLowerCase();
/** One person behind several aliases: Gmail ignores dots and anything after +; other providers commonly ignore +. */
export function emailKey(email) {
    const [local = '', domain = ''] = normaliseEmail(email).split('@');
    const base = local.split('+')[0];
    const gmail = domain === 'gmail.com' || domain === 'googlemail.com';
    return `${gmail ? base.replace(/\./g, '') : base}@${gmail ? 'gmail.com' : domain}`;
}
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** A sign-in code lasts this long; this many wrong guesses end it. */
const CODE_MINUTES = 15, CODE_ATTEMPTS = 5;
/** A drive that fails to load within this long of starting gives its session back; at most this many a day. */
const REFUND_WINDOW_MS = 15 * 60_000, REFUNDS_PER_DAY = 3;
export class Service {
    config;
    store;
    mail;
    ids;
    stripe;
    constructor(config, store, mail, ids, stripe) {
        this.config = config;
        this.store = store;
        this.mail = mail;
        this.ids = ids;
        this.stripe = stripe;
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
        await this.store.appendLedger({ product: 'simulator', accountId: account.id, type: 'referral_free_drive', sessionsDelta: 1, amountPence: 0, currency: 'gbp',
            actor: 'system', reason: `Free drive: invited by ${referrer.referralCode}`, idempotencyKey: `referral-free:${account.id}` });
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
            id: a.id, email: a.email, balance: a.balance, starterBought: !!a.starterBought, referralCode: a.referralCode,
            invited: await this.store.countReferred(a.id), rewarded: ledger.filter(e => e.type === 'referral_bonus').length,
            history: ledger.slice(-20).reverse().map(e => ({ type: e.type, sessions: e.sessionsDelta, amountPence: e.amountPence, reason: e.reason, at: e.createdAt.toISOString() })),
            admin: !!a.email && this.config.adminEmails.includes(a.email)
        };
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
    // ---- Drives: each one started uses one session ----
    async startDrive(accountId, kind, scenario) {
        const drive = await this.store.createDrive({ accountId, kind: kind.slice(0, 40), scenario: scenario.slice(0, 80), startedAt: new Date(), status: 'started' });
        const r = await this.store.appendLedger({ product: 'simulator', accountId, type: 'consumed', sessionsDelta: -1, amountPence: 0, currency: 'gbp', actor: 'customer',
            reason: `${kind}: ${scenario}`, idempotencyKey: `drive:${drive.id}` }, { requireBalance: true });
        if (r !== 'ok') {
            await this.store.updateDrive(drive.id, { status: 'failed' });
            return { ok: false, reason: 'no-sessions' };
        }
        return { ok: true, drive, balance: (await this.store.findAccount({ id: accountId })).balance };
    }
    /** The app reports how the drive went; one that failed to load gives its session back. */
    async driveStatus(accountId, driveId, status) {
        const d = await this.store.getDrive(driveId);
        if (!d || d.accountId !== accountId)
            return false;
        if (status === 'failed' && d.status === 'started' && !d.refunded && Date.now() - d.startedAt.getTime() <= REFUND_WINDOW_MS) {
            const today = await this.store.countDrives({ accountId, since: new Date(Date.now() - 24 * 3600_000), refunded: true });
            if (today >= REFUNDS_PER_DAY) {
                await this.store.flag('drive-refunds', { account: accountId, drive: driveId });
                await this.store.updateDrive(driveId, { status });
                return true;
            }
            const r = await this.store.appendLedger({ product: 'simulator', accountId, type: 'drive_refund', sessionsDelta: 1, amountPence: 0, currency: 'gbp', actor: 'system',
                reason: 'The drive did not load', idempotencyKey: `drive-refund:${driveId}` });
            await this.store.updateDrive(driveId, { status, refunded: r === 'ok' || r === 'duplicate' });
            return true;
        }
        if (d.status !== 'completed')
            await this.store.updateDrive(driveId, { status });
        return true;
    }
    // ---- Payments (Stripe Payment Links) ----
    /** The packs on sale in this mode, as the app shows them. */
    packs() {
        return this.config.packs.map(p => ({ id: p.id, label: p.label, price: p.price, sessions: p.sessions, starter: !!p.starter, url: p.links[this.config.stripeMode] || null }));
    }
    async packForLink(linkId) {
        if (!linkId || !this.stripe)
            return { pack: null, sessions: null };
        const link = await this.stripe.paymentLink(linkId);
        if (!link)
            return { pack: null, sessions: null };
        const pack = this.config.packs.find(p => p.links.test === link.url || p.links.live === link.url) ?? null;
        const fromMeta = Number(link.metadata['sessions']);
        return { pack, sessions: pack?.sessions ?? (Number.isInteger(fromMeta) && fromMeta > 0 ? fromMeta : null) };
    }
    async stripeWebhook(raw, signature) {
        let event;
        try {
            event = this.stripe.constructEvent(raw, signature);
        }
        catch {
            return 'bad-signature';
        }
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
                const purchase = pi ? (await this.store.ledger({ paymentIntent: pi })).find(e => e.type === 'purchase') : null;
                if (!purchase) {
                    await this.store.flag('refund-unmatched', { event: event.id, paymentIntent: pi });
                    return;
                }
                const full = o['refunded'] === true || o['amount_refunded'] === o['amount'];
                if (!full) {
                    await this.store.flag('partial-refund', { event: event.id, account: purchase.accountId, paymentIntent: pi });
                    return;
                }
                await this.store.appendLedger({ product: 'simulator', accountId: purchase.accountId, type: 'refund', sessionsDelta: -purchase.sessionsDelta,
                    amountPence: -Number(o['amount_refunded'] ?? purchase.amountPence), currency: String(o['currency'] ?? 'gbp'), actor: 'stripe',
                    stripe: { event: event.id, paymentIntent: pi, charge: String(o['id']) }, reason: 'Payment refunded', idempotencyKey: `refund:${String(o['id'])}` });
                // A referral reward that this payment earned stays, for a person to decide (the referrer did nothing wrong).
                const a = await this.store.findAccount({ id: purchase.accountId });
                if (a?.referredBy)
                    await this.store.flag('refund-after-referral-reward', { account: a.id, referrer: a.referredBy, paymentIntent: pi });
                return;
            }
            case 'charge.dispute.created':
                await this.store.flag('dispute', { event: event.id, charge: o['charge'], amount: o['amount'], reason: o['reason'] });
                return;
        }
    }
    async credit(event, o) {
        const sessionId = String(o['id']);
        const ref = typeof o['client_reference_id'] === 'string' ? o['client_reference_id'] : null;
        const details = o['customer_details'];
        const account = (ref ? await this.store.findAccount({ id: ref }) : null)
            ?? (details?.email ? await this.store.findAccount({ email: normaliseEmail(details.email) }) : null);
        const linkId = typeof o['payment_link'] === 'string' ? o['payment_link'] : null;
        const { pack, sessions } = await this.packForLink(linkId);
        if (!account || !sessions) {
            await this.store.flag(account ? 'payment-unknown-pack' : 'payment-no-account', { event: event.id, checkoutSession: sessionId, paymentLink: linkId, email: details?.email ?? null, ref });
            return;
        }
        const amount = Number(o['amount_total'] ?? 0);
        const pi = typeof o['payment_intent'] === 'string' ? o['payment_intent'] : undefined;
        const r = await this.store.appendLedger({ product: 'simulator', accountId: account.id, type: amount > 0 ? 'purchase' : 'promo', sessionsDelta: sessions, amountPence: amount,
            currency: String(o['currency'] ?? 'gbp'), actor: 'stripe', stripe: { event: event.id, checkoutSession: sessionId, ...(pi ? { paymentIntent: pi } : {}), ...(linkId ? { paymentLink: linkId } : {}) },
            reason: `${pack?.label ?? 'Sessions'} (${sessions})`, idempotencyKey: `checkout:${sessionId}` });
        if (r !== 'ok')
            return;
        if (pack?.starter)
            await this.store.updateAccount(account.id, { starterBought: true });
        // The first payment with money: the person who invited them gets their free session.
        if (amount > 0 && !account.firstPaidAt) {
            await this.store.updateAccount(account.id, { firstPaidAt: new Date() });
            if (account.referredBy)
                await this.store.appendLedger({ product: 'simulator', accountId: account.referredBy, type: 'referral_bonus', sessionsDelta: 1, amountPence: 0, currency: 'gbp',
                    actor: 'system', reason: 'Free session: someone you invited bought sessions', idempotencyKey: `referral-bonus:${account.id}` });
        }
    }
}
