// 'land': the page opened (sent by index.html before the app has loaded); 'open': the app loaded and showing.
export const VISIT_EVENT_TYPES = ['land', 'open', 'screen', 'click', 'drive', 'ping', 'leave', 'signin'];
/** At most this many events in one post, and one post a few seconds apart from a session. */
export const MAX_EVENTS_PER_POST = 60;
const ID = /^[A-Za-z0-9_-]{8,40}$/;
const WORD = /^[\w .:/#+&'()-]{1,80}$/;
const DAY = 86400_000;
const text = (v, max = 80) => typeof v === 'string' && v.length <= max && WORD.test(v) ? v : undefined;
/** Events as the app posted them: anything malformed is dropped, never stored. */
export function parseVisitEvents(body, now, accountId, country) {
    const visitor = body['visitor'], session = body['session'], list = body['events'];
    if (typeof visitor !== 'string' || !ID.test(visitor) || typeof session !== 'string' || !ID.test(session) || !Array.isArray(list))
        return [];
    const out = [];
    for (const raw of list.slice(0, MAX_EVENTS_PER_POST)) {
        if (!raw || typeof raw !== 'object')
            continue;
        const e = raw, type = VISIT_EVENT_TYPES.find(t => t === e['type']);
        if (!type)
            continue;
        // When it happened: how long ago the app says (its clock may be wrong), within the last day.
        const ago = typeof e['ago'] === 'number' && e['ago'] >= 0 && e['ago'] < DAY ? e['ago'] : 0;
        const data = {};
        if (e['data'] && typeof e['data'] === 'object')
            for (const [k, v] of Object.entries(e['data']).slice(0, 16)) {
                if (!/^[a-z][a-zA-Z0-9]{0,20}$/.test(k))
                    continue;
                if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))
                    data[k] = v;
                else {
                    const t = text(v, 120);
                    if (t !== undefined)
                        data[k] = t;
                }
            }
        const target = text(e['target']);
        out.push({ visitor, session, at: new Date(now.getTime() - ago), type, screen: text(e['screen'], 40) ?? 'unknown',
            ...(target ? { target } : {}), ...(Object.keys(data).length ? { data } : {}), ...(accountId ? { accountId } : {}), ...(country && /^[A-Z]{2}$/.test(country) ? { country } : {}) });
    }
    return out;
}
/** Where a session came from, as one name: a campaign's source, the site that linked, the home screen, or direct. */
export function sourceOf(open) {
    const d = open?.data ?? {};
    if (typeof d['src'] === 'string')
        return String(d['src']).toLowerCase();
    if (d['ref'])
        return 'invite link';
    // Opened in a social app's own browser (Instagram, TikTok…), which often gives no referrer.
    if (typeof d['inApp'] === 'string')
        return String(d['inApp']);
    if (typeof d['referrer'] === 'string') {
        const host = String(d['referrer']).replace(/^www\./, '');
        if (/(^|\.)google\./.test(host))
            return 'google';
        if (/(^|\.)(bing|duckduckgo|yahoo|ecosia)\./.test(host))
            return host.split('.')[0];
        if (/(^|\.)(facebook|fb|instagram|tiktok|twitter|x|t|youtube|reddit|whatsapp|snapchat|linkedin|pinterest)\.(com|co|me)$/.test(host))
            return host.split('.').at(-2);
        return host;
    }
    return d['standalone'] ? 'home screen' : 'direct';
}
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
const top = (m, by, n) => [...m.entries()].sort((a, b) => by(b[1]) - by(a[1])).slice(0, n);
/** The Visitors tab: the last `days` days of events (oldest first or not), summed up. */
export function summariseVisits(events, now, days) {
    const since = now.getTime() - days * DAY;
    const sessions = new Map();
    for (const e of [...events].sort((a, b) => a.at.getTime() - b.at.getTime())) {
        const t = e.at.getTime();
        if (t < since)
            continue;
        let s = sessions.get(e.session);
        if (!s) {
            s = { id: e.session, visitor: e.visitor, start: t, end: t, screens: [], clicks: 0, started: 0, completed: 0, signedIn: false, signin: false };
            sessions.set(e.session, s);
        }
        s.end = Math.max(s.end, t);
        if (e.accountId)
            s.signedIn = true;
        if (e.type === 'open' && !s.loaded) {
            s.open = e;
            s.loaded = true;
        }
        if (e.type === 'land' && !s.open)
            s.open = e;
        if ((e.type === 'screen' || e.type === 'open' || e.type === 'land') && s.screens.at(-1)?.screen !== e.screen)
            s.screens.push({ screen: e.screen, at: t });
        if (e.type === 'click')
            s.clicks++;
        if (e.type === 'signin')
            s.signin = true;
        if (e.type === 'drive' && e.data?.['phase'] === 'start')
            s.started++;
        if (e.type === 'drive' && e.data?.['phase'] === 'end' && e.data['outcome'] === 'completed')
            s.completed++;
    }
    const all = [...sessions.values()];
    const seconds = (s) => Math.round((s.end - s.start) / 1000);
    // A visitor's first time: the session whose opening says the device had not been seen before.
    const firstTime = new Map();
    for (const s of all)
        if (s.open?.data?.['newVisitor'] && !firstTime.has(s.visitor))
            firstTime.set(s.visitor, s.start);
    // People a day: everyone, new ones, from the home screen (the installed app), signed in; sessions and minutes.
    const byDay = new Map();
    for (let t = since; t <= now.getTime(); t += DAY)
        byDay.set(dayOf(t), { visitors: new Set(), fresh: new Set(), home: new Set(), signedIn: new Set(), sessions: 0, seconds: 0 });
    for (const s of all) {
        const d = byDay.get(dayOf(s.start));
        if (!d)
            continue;
        d.visitors.add(s.visitor);
        d.sessions++;
        d.seconds += seconds(s);
        if (s.open?.data?.['newVisitor'])
            d.fresh.add(s.visitor);
        if (s.open?.data?.['standalone'])
            d.home.add(s.visitor);
        if (s.signedIn)
            d.signedIn.add(s.visitor);
    }
    // Where they come from, and how those sessions went.
    const bySource = new Map();
    for (const s of all) {
        const k = sourceOf(s.open), r = bySource.get(k) ?? { sessions: 0, visitors: new Set(), seconds: 0, started: 0, completed: 0, signin: 0 };
        r.sessions++;
        r.visitors.add(s.visitor);
        r.seconds += seconds(s);
        if (s.started)
            r.started++;
        if (s.completed)
            r.completed++;
        if (s.signin)
            r.signin++;
        bySource.set(k, r);
    }
    const campaigns = new Map();
    for (const s of all) {
        const c = s.open?.data?.['campaign'];
        if (typeof c === 'string')
            campaigns.set(`${sourceOf(s.open)} · ${c}`, (campaigns.get(`${sourceOf(s.open)} · ${c}`) ?? 0) + 1);
    }
    // Where they go: views of each screen, time on it, and the sessions that ended there (where people leave).
    const byScreen = new Map();
    for (const s of all)
        s.screens.forEach((v, i) => {
            const r = byScreen.get(v.screen) ?? { views: 0, visitors: new Set(), seconds: 0, exits: 0 };
            r.views++;
            r.visitors.add(s.visitor);
            r.seconds += ((s.screens[i + 1]?.at ?? s.end) - v.at) / 1000;
            if (i === s.screens.length - 1)
                r.exits++;
            byScreen.set(v.screen, r);
        });
    // The way from one screen to the next (the paths people take).
    const paths = new Map();
    for (const s of all)
        for (let i = 1; i < s.screens.length; i++) {
            const k = `${s.screens[i - 1].screen} → ${s.screens[i].screen}`;
            paths.set(k, (paths.get(k) ?? 0) + 1);
        }
    // What they press.
    const clicks = new Map();
    for (const e of events) {
        if (e.type !== 'click' || e.at.getTime() < since)
            continue;
        const k = `${e.screen} · ${e.target ?? '?'}`, r = clicks.get(k) ?? { n: 0, visitors: new Set() };
        r.n++;
        r.visitors.add(e.visitor);
        clicks.set(k, r);
    }
    // The way to a finished drive, in people: where they drop off.
    const visitors = new Set(all.map(s => s.visitor));
    const reached = (test) => new Set(all.filter(test).map(s => s.visitor)).size;
    const funnel = [
        { step: 'Opened the link', people: visitors.size },
        { step: 'Waited for the app to load', people: reached(s => !!s.loaded) },
        { step: 'Looked at a drive', people: reached(s => s.screens.some(v => v.screen.startsWith('exercise'))) },
        { step: 'Started a drive', people: reached(s => s.started > 0) },
        { step: 'Completed a drive', people: reached(s => s.completed > 0) },
        { step: 'Signed in', people: reached(s => s.signin || s.signedIn) }
    ];
    // Coming back: of the people new in the period (before the last week, so a week can have passed), how many came
    // back on another day, and within a week.
    const sessionsOf = new Map();
    for (const s of all)
        sessionsOf.set(s.visitor, [...(sessionsOf.get(s.visitor) ?? []), s.start]);
    let fresh = 0, back = 0, backWeek = 0;
    for (const [v, starts] of sessionsOf) {
        const f = firstTime.get(v);
        if (f === undefined || f > now.getTime() - 7 * DAY)
            continue;
        fresh++;
        const later = starts.filter(t => dayOf(t) !== dayOf(f));
        if (later.length)
            back++;
        if (later.some(t => t - f <= 7 * DAY))
            backWeek++;
    }
    const devices = new Map();
    for (const s of all) {
        const d = s.open?.data;
        const k = `${d?.['device'] ?? '?'} · ${d?.['os'] ?? '?'}${d?.['standalone'] ? ' · home screen' : ''}`;
        devices.set(k, (devices.get(k) ?? 0) + 1);
    }
    const countries = new Map();
    for (const s of all) {
        const c = s.open?.country;
        if (c)
            countries.set(c, (countries.get(c) ?? 0) + 1);
    }
    const median = (xs) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : 0; };
    return {
        at: now.toISOString(), days,
        totals: { visitors: visitors.size, sessions: all.length, homeScreen: reached(s => !!s.open?.data?.['standalone']),
            medianSeconds: median(all.map(seconds)), meanSeconds: all.length ? Math.round(all.reduce((n, s) => n + seconds(s), 0) / all.length) : 0,
            // Left at once: under half a minute on the first screen, nothing pressed.
            leftWhileLoading: all.filter(s => !s.loaded).length,
            bounced: all.filter(s => s.loaded && s.screens.length <= 1 && s.clicks === 0 && seconds(s) < 30).length },
        daily: [...byDay.entries()].map(([day, d]) => ({ day, visitors: d.visitors.size, newVisitors: d.fresh.size, homeScreen: d.home.size, signedIn: d.signedIn.size,
            sessions: d.sessions, minutes: Math.round(d.seconds / 60) })),
        sources: top(bySource, r => r.sessions, 30).map(([source, r]) => ({ source, sessions: r.sessions, visitors: r.visitors.size, meanSeconds: Math.round(r.seconds / r.sessions),
            startedDrive: r.started, completedDrive: r.completed, signedIn: r.signin })),
        campaigns: top(campaigns, n => n, 20).map(([campaign, sessions]) => ({ campaign, sessions })),
        screens: top(byScreen, r => r.views, 40).map(([screen, r]) => ({ screen, views: r.views, visitors: r.visitors.size, meanSeconds: Math.round(r.seconds / r.views),
            exits: r.exits, exitShare: all.length ? r.exits / all.length : 0 })),
        paths: top(paths, n => n, 25).map(([path, n]) => ({ path, n })),
        clicks: top(clicks, r => r.n, 40).map(([target, r]) => ({ target, n: r.n, visitors: r.visitors.size })),
        funnel,
        returning: { newVisitors: fresh, cameBack: back, cameBackWithinWeek: backWeek },
        devices: top(devices, n => n, 15).map(([device, sessions]) => ({ device, sessions })),
        countries: top(countries, n => n, 15).map(([country, sessions]) => ({ country, sessions }))
    };
}
