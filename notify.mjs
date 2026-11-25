// רץ ב-GitHub Actions כל רבע שעה: שולח תזכורות, סיכום בוקר ועדכונים חדשים לטלפונים
import admin from 'firebase-admin';

const SITE = process.env.SITE_URL || 'https://yahavmesika.github.io/Buktus-pm/';
const FORCE = String(process.env.FORCE) === 'true';
const DIGEST_HOUR = 8; // סיכום בוקר בשעה 8:00

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();

/* זמן ישראל */
const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
}).formatToParts(new Date()).map(p => [p.type, p.value]));
const todayIL = `${parts.year}-${parts.month}-${parts.day}`;
const nowIL = `${todayIL}T${parts.hour}:${parts.minute}`;
const hourIL = Number(parts.hour);
const daysTo = d => Math.round((Date.parse(d + 'T00:00:00Z') - Date.parse(todayIL + 'T00:00:00Z')) / 864e5);
console.log('Israel time:', nowIL);

const [settingsSnap, projSnap, itemSnap, tokSnap] = await Promise.all([
  db.doc('settings/main').get(), db.collection('projects').get(), db.collection('items').get(), db.collection('tokens').get()
]);
const settings = settingsSnap.data() || {};
const projName = Object.fromEntries(projSnap.docs.map(d => [d.id, d.data().name]));
const items = itemSnap.docs.map(d => ({ id: d.id, ref: d.ref, ...d.data() }));
const tokens = tokSnap.docs.map(d => ({ id: d.id, ...d.data() }));
const team = (settings.team || []).map(t => t.name);
const tokensOf = name => tokens.filter(t => t.name === name).map(t => t.id);
const allTokens = () => tokens.map(t => t.id);
console.log(`${tokens.length} devices, ${items.length} items`);

let sent = 0;
async function push(toks, title, body, tag) {
  toks = [...new Set(toks)];
  if (!toks.length) return;
  const res = await admin.messaging().sendEachForMulticast({
    tokens: toks,
    webpush: { notification: { title, body, icon: SITE + 'icon.svg', tag: tag || undefined, dir: 'rtl', lang: 'he' }, fcmOptions: { link: SITE } }
  });
  sent += res.successCount;
  // מוחקים מכשירים שכבר לא רשומים
  await Promise.all(res.responses.map((r, i) => {
    const code = r.error && r.error.code;
    if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
      return db.doc('tokens/' + toks[i]).delete();
    }
    if (r.error) console.log('send error:', code);
  }));
}

/* בדיקה ידנית */
if (FORCE) {
  await push(allTokens(), 'בדיקה: ההתראות עובדות ✅', 'שלום בוקטוס · ניהול פרויקטים', 'test');
  console.log('test sent to', tokens.length, 'devices');
}

/* 1. תזכורות שהגיע זמנן */
for (const it of items) {
  if (!it.remindAt || it.reminderSent || it.remindAt > nowIL) continue;
  const to = (it.remindTo && it.remindTo.length ? it.remindTo : (it.owners || []));
  const names = to.includes('כולם') ? team : to;
  await push(names.flatMap(tokensOf), `🔔 תזכורת · ${projName[it.projectId] || ''}`, it.text + (it.note ? ` (${it.note})` : ''), 'r-' + it.id);
  await it.ref.update({ reminderSent: true });
  console.log('reminder:', it.text);
}

/* 2. סיכום בוקר: מה ביעד היום, מחר, ומה באיחור */
if (hourIL >= DIGEST_HOUR && settings.lastDigest !== todayIL) {
  for (const name of team) {
    const mine = items.filter(it => it.kind === 'task' && it.status !== 'done' && it.due &&
      ((it.owners || []).includes(name) || (it.owners || []).includes('כולם')) && daysTo(it.due) <= 1)
      .sort((a, b) => a.due.localeCompare(b.due));
    if (!mine.length) continue;
    const late = mine.filter(it => daysTo(it.due) < 0).length;
    const lines = mine.slice(0, 4).map(it => {
      const d = daysTo(it.due);
      return `• ${it.text} (${d < 0 ? 'באיחור' : d === 0 ? 'היום' : 'מחר'})`;
    });
    if (mine.length > 4) lines.push(`ועוד ${mine.length - 4}…`);
    await push(tokensOf(name), `בוקר טוב ${name} · ${mine.length} משימות${late ? `, ${late} באיחור` : ''}`, lines.join('\n'), 'digest');
  }
  await db.doc('settings/main').set({ lastDigest: todayIL }, { merge: true });
  console.log('morning digest sent');
}

/* 3. עדכונים חדשים של אחרים */
const since = settings.lastPushAt;
const newest = await db.collection('updates').orderBy('at', 'desc').limit(1).get();
const newestAt = newest.empty ? null : newest.docs[0].data().at;
if (!since) {
  if (newestAt) await db.doc('settings/main').set({ lastPushAt: newestAt }, { merge: true });
} else if (newestAt && newestAt.toMillis() > since.toMillis()) {
  const ups = (await db.collection('updates').where('at', '>', since).orderBy('at').get()).docs.map(d => d.data());
  for (const name of new Set(tokens.map(t => t.name))) {
    const others = ups.filter(u => u.by !== name);
    if (!others.length) continue;
    const title = others.length === 1 ? `עדכון מ${others[0].by}` : `${others.length} עדכונים חדשים`;
    const body = others.slice(-4).map(u => (others.length === 1 ? '' : `${u.by}: `) + u.text).join('\n');
    await push(tokensOf(name), title, body, 'updates');
  }
  await db.doc('settings/main').set({ lastPushAt: newestAt }, { merge: true });
  console.log(ups.length, 'updates pushed');
}

console.log('notifications sent:', sent);
process.exit(0);
