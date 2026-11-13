/**
 * Leaderboards: one per test centre, per week (Monday to Sunday, UK time), from finished mock tests. Points reward
 * practice and quality: 10 for a finished test, 20 more for a pass, one off for each driving fault; at most five tests
 * a day count. Results come from the learner's browser, so implausible ones do not count. A learner shows by the name
 * they choose (and their driving school) only if they opt in; otherwise as "Learner".
 */
export const POINTS = { finished: 10, pass: 20, perFault: 1, perDay: 5, minSeconds: 240 };
const BLOCKED = /\b(admin|moderator|official|dvsa|driving ?practice|fuck|shit|cunt|bitch|bastard|wank|dick|cock|prick|twat|slag|whore|nigg|fag|retard|nazi|hitler)/i;
/** A name or school as typed, made safe; null if not allowed. */
export function cleanName(raw, min = 2, max = 24) {
    if (typeof raw !== 'string')
        return null;
    const s = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
    if (s.length < min || s.length > max)
        return null;
    if (!/^[\p{L}\p{N}][\p{L}\p{N} '’&.-]*$/u.test(s))
        return null;
    if (BLOCKED.test(s.replace(/[0-9]/g, c => ({ '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't' }[c] ?? c))))
        return null;
    return s;
}
/** Which centre a drive was at: an area built round a centre (`area-<slug>-…`), or the place a bundled one is named for. */
export function centreOf(scenario) {
    const area = /^(area-.+?)-(mock-test|free-drive|lesson)$/.exec(scenario);
    if (area)
        return area[1];
    return scenario.split('-')[0];
}
/** A centre's name for people ("area-hull-test-centre" → "Hull"). */
export function centreName(key) {
    const words = key.replace(/^area-/, '').replace(/-test-centre$/, '').split('-').filter(Boolean);
    return /\d/.test(key) ? words.join(' ').toUpperCase() : words.map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}
/** The Monday 00:00 (UK time) that starts the week `at` is in. */
export function weekStart(at) {
    const london = new Date(at.toLocaleString('en-US', { timeZone: 'Europe/London' }));
    // (The offset in whole minutes: the local time above has no milliseconds.)
    const offset = Math.round((london.getTime() - at.getTime()) / 60_000) * 60_000;
    const day = (london.getDay() + 6) % 7;
    const monday = new Date(london);
    monday.setHours(0, 0, 0, 0);
    monday.setDate(monday.getDate() - day);
    return new Date(monday.getTime() - offset);
}
const londonDay = (at) => at.toLocaleDateString('en-GB', { timeZone: 'Europe/London' });
/** A drive's points, or null when it does not count (not a finished mock test, or not believable). */
export function pointsOf(d) {
    const t = d.result?.test;
    if (!t?.finished || !d.owner || !d.endedAt)
        return null;
    const seconds = d.result?.seconds ?? 0, took = (d.endedAt.getTime() - d.startedAt.getTime()) / 1000;
    if (seconds < POINTS.minSeconds || took < POINTS.minSeconds)
        return null;
    // (A pass has no serious or dangerous fault and at most 15 driving faults: anything else was not a real result.)
    if (t.passed && (t.serious > 0 || t.dangerous > 0 || t.driving > 15))
        return null;
    return Math.max(0, POINTS.finished + (t.passed ? POINTS.pass : 0) - t.driving * POINTS.perFault);
}
/** Each learner's total at one centre over the given drives (at most five tests a UK day count). */
export function tally(drives, centre) {
    const rows = new Map(), perDay = new Map();
    for (const d of [...drives].filter(d => centreOf(d.scenario) === centre && d.endedAt).sort((a, b) => a.endedAt.getTime() - b.endedAt.getTime())) {
        const p = pointsOf(d);
        if (p === null)
            continue;
        const dayKey = `${d.owner}|${londonDay(d.endedAt)}`, n = perDay.get(dayKey) ?? 0;
        if (n >= POINTS.perDay)
            continue;
        perDay.set(dayKey, n + 1);
        const r = rows.get(d.owner) ?? { owner: d.owner, points: 0, tests: 0, passes: 0, reachedAt: 0 };
        r.points += p;
        r.tests++;
        if (d.result.test.passed)
            r.passes++;
        r.reachedAt = d.endedAt.getTime();
        rows.set(d.owner, r);
    }
    // Most points first; a tie goes to whoever got there first.
    return [...rows.values()].sort((a, b) => b.points - a.points || a.reachedAt - b.reachedAt);
}
/** How a row shows on the board: the chosen name (and school) if the learner opted in, otherwise "Learner". */
export function shown(a) {
    const b = a?.board;
    return b?.show && !b.hidden ? { name: b.name, school: b.school ?? null } : { name: 'Learner', school: null };
}
