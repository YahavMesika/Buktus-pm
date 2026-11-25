import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, signInWithEmailAndPassword, sendPasswordResetEmail, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, collection, doc, onSnapshot, addDoc, setDoc, updateDoc, deleteDoc,
  serverTimestamp, writeBatch, query, orderBy, limit
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { getMessaging, getToken, onMessage, isSupported } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js';
import { firebaseConfig, VAPID_KEY } from './firebase-config.js';
import { SEED_TEAM, SEED_PROJECTS, SEED_ITEMS, SEED_SUBS } from './seed.js';

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
const db = getFirestore(fb);

/* ---------- התראות לטלפון ---------- */
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushState = () => {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) return isIOS && !standalone ? 'ios-home' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission === 'granted' && localStorage.getItem('pushToken')) return 'on';
  return 'off';
};
async function enablePush() {
  if (!VAPID_KEY) { toast('ההתראות עוד לא הוגדרו במערכת'); return; }
  if (!(await isSupported())) { toast(isIOS ? 'באייפון: קודם "הוסף למסך הבית", ופותחים את המערכת משם' : 'הדפדפן הזה לא תומך בהתראות'); return; }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { toast('ההתראות לא אושרו. אפשר לאשר בהגדרות הדפדפן'); render(); return; }
  const reg = await navigator.serviceWorker.register('firebase-messaging-sw.js');
  const token = await getToken(getMessaging(fb), { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
  await setDoc(doc(db, 'tokens', token), { name: me(), email: S.user.email, at: serverTimestamp(), device: navigator.userAgent.slice(0, 120) });
  localStorage.setItem('pushToken', token);
  toast('ההתראות הופעלו בטלפון הזה 🔔'); render();
}
async function refreshPushName() {
  const t = localStorage.getItem('pushToken');
  if (t && Notification.permission === 'granted') await setDoc(doc(db, 'tokens', t), { name: me(), email: S.user.email }, { merge: true }).catch(() => {});
}
isSupported().then(ok => { if (ok) onMessage(getMessaging(fb), m => toast(((m.notification || {}).title || '') + ' · ' + ((m.notification || {}).body || ''))); }).catch(() => {});

/* ---------- constants ---------- */
const STATUS = { open: 'פתוח', progress: 'בתהליך', stuck: 'תקוע', done: 'בוצע' };
const KIND = { task: 'משימה', info: 'לידיעה', ongoing: 'שוטף' };
const STAGES = ['כתב כמויות', 'הופץ לקבלנים', 'התקבלו הצעות', 'תנאים סגורים', 'הסכם חתום'];
const stageName = s => (s < 0 ? 'טרם התחיל' : STAGES[s]);

/* ---------- state ---------- */
const S = {
  user: null, team: [], meta: {}, projects: [], items: [], subs: [], updates: [],
  tab: localStorage.getItem('tab') || 'mine', view: localStorage.getItem('view') || '',
  fPerson: 'all', fShowDone: false, fSubOpen: true,
  meetingDate: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10),
  loaded: { projects: false, items: false, subs: false, settings: false },
  denied: false, unsub: []
};
const lastSeen = () => Number(localStorage.getItem('seen') || 0);

/* ---------- helpers ---------- */
const $app = document.getElementById('app');
const $sheet = document.getElementById('sheet');
const $toast = document.getElementById('toast');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const fmtD = d => (d ? d.slice(8, 10) + '.' + d.slice(5, 7) : '—');
const ts = v => (v && v.toMillis ? v.toMillis() : 0);
const fmtAgo = ms => {
  if (!ms) return '';
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'עכשיו';
  if (m < 60) return `לפני ${m} דק׳`;
  const h = Math.round(m / 60);
  if (h < 24) return `לפני ${h} שע׳`;
  const d = new Date(ms);
  return `${d.getDate()}.${d.getMonth() + 1} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const me = () => {
  if (!S.user) return '';
  const m = S.team.find(t => (t.email || '').toLowerCase() === (S.user.email || '').toLowerCase());
  return m ? m.name : (S.user.displayName || S.user.email);
};
const projName = id => (S.projects.find(p => p.id === id) || {}).name || 'ללא פרויקט';
const isMine = owners => (owners || []).includes(me()) || (owners || []).includes('כולם');
const isLate = it => it.kind === 'task' && it.status !== 'done' && it.due && it.due < today();
let toastT;
function toast(msg) {
  $toast.textContent = msg; $toast.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { $toast.hidden = true; }, 3200);
}
function pill(it) {
  if (it.kind === 'task') return `<span class="pill ${it.status || 'open'}">${STATUS[it.status || 'open']}</span>`;
  return `<span class="pill ${it.kind}">${KIND[it.kind]}</span>`;
}
async function logUpdate(text, ref) {
  await addDoc(collection(db, 'updates'), { text, by: me(), at: serverTimestamp(), ref: ref || null });
}
function waLink(text) { return 'https://wa.me/?text=' + encodeURIComponent(text); }

/* ---------- auth & data ---------- */
onAuthStateChanged(auth, user => {
  S.unsub.forEach(u => u()); S.unsub = [];
  S.user = user; S.denied = false;
  if (!user) { renderLogin(); return; }
  Object.keys(S.loaded).forEach(k => { S.loaded[k] = false; });
  const onErr = e => { if (e.code === 'permission-denied') { S.denied = true; render(); } else console.error(e); };
  S.unsub.push(onSnapshot(collection(db, 'projects'), q => {
    S.projects = q.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
    S.loaded.projects = true; render();
  }, onErr));
  S.unsub.push(onSnapshot(collection(db, 'items'), q => {
    S.items = q.docs.map(d => ({ id: d.id, ...d.data() }));
    S.loaded.items = true; render();
  }, onErr));
  S.unsub.push(onSnapshot(collection(db, 'subs'), q => {
    S.subs = q.docs.map(d => ({ id: d.id, ...d.data() }));
    S.loaded.subs = true; render();
  }, onErr));
  S.unsub.push(onSnapshot(doc(db, 'settings', 'main'), d => {
    const v = d.data() || {};
    S.team = v.team || []; S.meta = v;
    S.loaded.settings = true; render();
  }, onErr));
  S.unsub.push(onSnapshot(query(collection(db, 'updates'), orderBy('at', 'desc'), limit(150)), q => {
    S.updates = q.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
  }, onErr));
});

function renderLogin(err, info) {
  const email = (document.getElementById('l-email') || {}).value || '';
  $app.innerHTML = `<form class="login" id="login-form">
    <div style="font-size:22px;font-weight:800">שלום בוקטוס</div>
    <div class="sub" style="margin:0">ניהול פרויקטים, משימות וקבלני משנה</div>
    <label style="text-align:right">מייל<input type="email" id="l-email" autocomplete="username" dir="ltr" required value="${esc(email)}"></label>
    <label style="text-align:right">סיסמה<input type="password" id="l-pass" autocomplete="current-password" dir="ltr" required></label>
    <button class="btn" type="submit">כניסה</button>
    <button class="btn ghost sm" type="button" data-act="forgot">שכחתי סיסמה</button>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    ${info ? `<div style="color:#166534;font-size:14px">${esc(info)}</div>` : ''}
  </form>`;
}
const AUTH_ERR = {
  'auth/invalid-credential': 'המייל או הסיסמה לא נכונים',
  'auth/wrong-password': 'המייל או הסיסמה לא נכונים',
  'auth/user-not-found': 'המייל או הסיסמה לא נכונים',
  'auth/invalid-email': 'כתובת המייל לא תקינה',
  'auth/too-many-requests': 'יותר מדי ניסיונות. נסו שוב בעוד כמה דקות',
  'auth/network-request-failed': 'אין חיבור לאינטרנט'
};
const authMsg = e => AUTH_ERR[e.code] || ('שגיאה: ' + (e.code || e.message));

/* ---------- main render ---------- */
function render() {
  if (!S.user) return renderLogin();
  if (S.denied) {
    $app.innerHTML = `<div class="login"><div style="font-weight:800;font-size:18px">אין הרשאה</div>
      <div class="sub" style="margin:0">החשבון ${esc(S.user.email)} לא ברשימת המורשים. צריך להוסיף אותו בהגדרות האבטחה של Firebase.</div>
      <button class="btn ghost" data-act="logout">התנתקות</button></div>`;
    return;
  }
  if (!Object.values(S.loaded).every(Boolean)) { $app.innerHTML = '<div class="splash">טוען…</div>'; return; }
  const mapped = S.team.some(t => (t.email || '').toLowerCase() === (S.user.email || '').toLowerCase());
  if (S.team.length && !mapped && !S.askedWho && $sheet.hidden) { S.askedWho = true; setTimeout(sheetWho, 0); }
  const newCount = S.updates.filter(u => ts(u.at) > lastSeen() && u.by !== me()).length;
  const tabs = [['mine', 'המשימות שלי'], ['all', 'כל המשימות'], ['projects', 'פרויקטים'], ['subs', 'קבלני משנה'], ['feed', 'עדכונים'], ['meeting', 'פגישה שבועית']];
  const body = S.projects.length === 0 ? viewEmpty()
    : S.tab === 'all' ? viewAll()
    : S.tab === 'projects' ? viewProjects()
    : S.tab === 'subs' ? viewSubs()
    : S.tab === 'feed' ? viewFeed()
    : S.tab === 'meeting' ? viewMeeting()
    : viewMine();
  $app.innerHTML = `
  <header class="top">
    <div class="in">
      <div class="brand">שלום בוקטוס <span>· ניהול פרויקטים</span></div>
      <div class="who"><span>${esc(me())}</span><button data-act="team">צוות</button><button data-act="logout">יציאה</button></div>
    </div>
    <nav class="tabs" aria-label="ניווט">
      ${tabs.map(([k, l]) => `<button data-act="tab" data-v="${k}" ${S.tab === k ? 'aria-current="page"' : ''}>${l}${k === 'feed' && newCount ? `<span class="badge">${newCount}</span>` : ''}</button>`).join('')}
    </nav>
  </header>
  <main>${body}</main>
  ${S.projects.length && S.tab !== 'meeting' ? `<button class="btn fab noprint" data-act="newItem">+ משימה חדשה</button>` : ''}`;
}

function viewEmpty() {
  return `<div class="card" style="padding:22px;max-width:560px;margin:30px auto;display:flex;flex-direction:column;gap:12px">
    <h1>ברוכים הבאים</h1>
    <p class="sub" style="margin:0">המערכת עדיין ריקה. אפשר לטעון את המשימות, הפרויקטים וקבלני המשנה מהפגישה השבועית של 22.11, ולהמשיך משם.</p>
    <button class="btn" data-act="seed">טען את נתוני הפגישה מ-22.11</button>
    <button class="btn ghost" data-act="newProject">או התחל עם פרויקט ריק</button>
  </div>`;
}

/* ימים עד היעד: שדה מחושב */
function daysLeft(it) {
  if (!it.due) return null;
  const a = new Date(it.due + 'T00:00:00'), b = new Date(today() + 'T00:00:00');
  return Math.round((a - b) / 864e5);
}
function dueInfo(it) {
  const d = daysLeft(it);
  if (it.kind !== 'task') return { text: it.due ? fmtD(it.due) : '', cls: '' };
  if (it.status === 'done') return { text: it.due ? `יעד ${fmtD(it.due)}` : '', cls: 'ok' };
  if (d === null) return { text: 'ללא יעד', cls: 'none' };
  if (d < 0) return { text: `באיחור ${-d === 1 ? 'יום אחד' : -d + ' ימים'}`, cls: 'late' };
  if (d === 0) return { text: 'היום', cls: 'soon' };
  if (d === 1) return { text: 'מחר', cls: 'soon' };
  return { text: `בעוד ${d} ימים`, cls: d <= 3 ? 'soon' : 'far' };
}
const dueChip = it => { const x = dueInfo(it); return x.text ? `<span class="dchip ${x.cls}">${x.text}</span>` : ''; };
const bell = it => (it.remindAt && !it.reminderSent ? `<span class="bell" title="תזכורת: ${esc(fmtRemind(it.remindAt))}">🔔 ${esc(fmtRemind(it.remindAt))}</span>` : '');
function fmtRemind(v) { if (!v) return ''; const [d, t] = v.split('T'); return `${fmtD(d)} ${t || ''}`.trim(); }
const lastBy = it => (it.updatedBy ? `${esc(it.updatedBy)} · ${fmtAgo(ts(it.updatedAt))}` : '');

function taskCard(it, showProject = true) {
  return `<button class="task ${isLate(it) ? 'late' : ''}" data-act="openItem" data-id="${it.id}">
    <div class="h"><span>${showProject ? `<span class="proj">${esc(projName(it.projectId))}</span>` : ''}${it.urgent && it.status !== 'done' ? '<span class="urg">דחוף</span>' : ''}</span>${pill(it)}</div>
    <div class="t">${esc(it.text)}</div>
    <div class="m"><span>אחריות: ${esc((it.owners || []).join(', ') || '—')}</span>${dueChip(it)}</div>
    ${it.note ? `<div class="note">${esc(it.note)}</div>` : ''}
    <div class="m"><span>${bell(it)}</span><span>${lastBy(it) ? 'עודכן: ' + lastBy(it) : ''}</span></div>
  </button>`;
}
const dueKey = it => (it.due ? daysLeft(it) : 99999);
const taskSort = (a, b) => (a.status === 'done') - (b.status === 'done') || (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0) || dueKey(a) - dueKey(b);

function viewMine() {
  const mine = S.items.filter(it => it.kind === 'task' && isMine(it.owners));
  const open = mine.filter(it => it.status !== 'done').sort(taskSort);
  const weekAgo = Date.now() - 7 * 864e5;
  const done = mine.filter(it => it.status === 'done' && ts(it.doneAt) > weekAgo);
  const subs = S.subs.filter(s => isMine(s.owners) && (s.stage ?? -1) < 4);
  const week = open.filter(it => { const d = daysLeft(it); return d !== null && d >= 0 && d <= 7; });
  const ps = pushState();
  const banner = ps === 'on' || ps === 'unsupported' ? '' : `<div class="pushb">
    <span>🔔 ${ps === 'denied' ? 'ההתראות חסומות בטלפון הזה. אפשר לאשר אותן בהגדרות הדפדפן.' : ps === 'ios-home' ? 'כדי לקבל התראות באייפון: לחצו על כפתור השיתוף ב-Safari, "הוסף למסך הבית", ופתחו את המערכת מהאייקון.' : 'רוצה לקבל תזכורות ועדכונים לטלפון הזה?'}</span>
    ${ps === 'off' ? '<button class="btn sm" data-act="enablePush">הפעל התראות</button>' : ''}</div>`;
  return `${banner}
  <h1>שלום, ${esc(me())}</h1>
  <div class="kpis">
    <div class="kpi"><b>${open.length}</b><span>משימות פתוחות</span></div>
    <div class="kpi red"><b>${open.filter(isLate).length}</b><span>באיחור</span></div>
    <div class="kpi"><b>${week.length}</b><span>יעד השבוע</span></div>
    <div class="kpi green"><b>${done.length}</b><span>בוצעו השבוע</span></div>
  </div>
  <div class="list">${open.map(it => taskCard(it)).join('') || '<div class="empty card">אין משימות פתוחות. יפה!</div>'}</div>
  ${subs.length ? `<h2 style="margin:22px 0 10px">סגירות קבלני משנה שלי</h2><div class="list">${subs.map(s => `
    <button class="task" data-act="openSub" data-id="${s.id}">
      <div class="h"><span class="proj">${esc(projName(s.projectId))}</span><span class="pill progress">${stageName(s.stage ?? -1)}</span></div>
      <div class="t">${esc(s.trade)}${s.contractors ? ` · ${esc(s.contractors)}` : ''}</div>
      ${s.note ? `<div class="m"><span>${esc(s.note)}</span></div>` : ''}
    </button>`).join('')}</div>` : ''}
  ${done.length ? `<h2 style="margin:22px 0 10px">בוצעו השבוע</h2><div class="list">${done.map(it => taskCard(it)).join('')}</div>` : ''}`;
}

/* כל המשימות: טבלה או כרטיסים */
function viewAll() {
  const people = ['all', ...S.team.map(t => t.name)];
  const st = S.fStatus || 'active';
  let list = S.items.filter(it => it.kind === 'task')
    .filter(it => S.fPerson === 'all' || (it.owners || []).includes(S.fPerson) || (it.owners || []).includes('כולם'))
    .filter(it => !S.fProject || it.projectId === S.fProject)
    .filter(it => st === 'all' ? true : st === 'active' ? it.status !== 'done' : st === 'late' ? isLate(it) : it.status === st)
    .sort(taskSort);
  const mode = S.view || (window.innerWidth < 760 ? 'cards' : 'table');
  const stOpts = [['active', 'פתוחות'], ['late', 'באיחור'], ['progress', 'בתהליך'], ['stuck', 'תקועות'], ['done', 'בוצעו'], ['all', 'הכול']];
  return `
  <div class="row"><h1 class="sp">כל המשימות</h1>
    <div class="seg2" role="group" aria-label="תצוגה"><button data-act="view" data-v="table" aria-pressed="${mode === 'table'}">טבלה</button><button data-act="view" data-v="cards" aria-pressed="${mode === 'cards'}">כרטיסים</button></div>
  </div>
  <div class="filters">
    <label>אחראי<select data-act="fPersonSel">${people.map(p => `<option value="${esc(p)}" ${S.fPerson === p ? 'selected' : ''}>${p === 'all' ? 'כולם' : esc(p)}</option>`).join('')}</select></label>
    <label>פרויקט<select data-act="fProjectSel"><option value="">כל הפרויקטים</option>${S.projects.filter(p => !p.archived).map(p => `<option value="${p.id}" ${S.fProject === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
  </div>
  <div class="chips">${stOpts.map(([k, l]) => `<button class="chip" data-act="fStatus" data-v="${k}" aria-pressed="${st === k}">${l}</button>`).join('')}<span class="cnt">${list.length} משימות</span></div>
  ${!list.length ? '<div class="empty card">אין משימות שמתאימות לסינון</div>'
    : mode === 'cards' ? `<div class="cgrid">${list.map(it => taskCard(it)).join('')}</div>`
    : `<div class="tbl"><table>
      <thead><tr><th>משימה</th><th>פרויקט</th><th>אחראי</th><th>סטטוס</th><th>יעד</th><th>עוד כמה ימים</th><th>עודכן</th></tr></thead>
      <tbody>${list.map(it => `<tr class="click ${isLate(it) ? 'late' : ''}" data-act="openItem" data-id="${it.id}">
        <td style="min-width:240px">${it.urgent && it.status !== 'done' ? '<span class="urg">דחוף</span> ' : ''}${esc(it.text)}${it.note ? `<div style="font-size:12px;color:#4B5563">${esc(it.note)}</div>` : ''}${bell(it) ? `<div>${bell(it)}</div>` : ''}</td>
        <td>${esc(projName(it.projectId))}</td><td>${esc((it.owners || []).join(', ') || '—')}</td><td>${pill(it)}</td>
        <td>${fmtD(it.due)}</td><td>${dueChip(it)}</td><td style="font-size:12px;color:#4B5563">${lastBy(it)}</td></tr>`).join('')}</tbody>
    </table></div>`}`;
}

function projStats(pid) {
  const t = S.items.filter(it => it.projectId === pid && it.kind === 'task');
  const done = t.filter(it => it.status === 'done').length;
  return { total: t.length, done, open: t.length - done, late: t.filter(isLate).length, stuck: t.filter(it => it.status === 'stuck').length, pct: t.length ? Math.round(done / t.length * 100) : 0 };
}

function viewProjects() {
  const people = ['all', ...S.team.map(t => t.name)];
  const match = it => (S.fPerson === 'all' || (it.owners || []).includes(S.fPerson)) && (S.fShowDone || it.status !== 'done');
  const act = S.projects.filter(p => !p.archived);
  const all = act.map(p => projStats(p.id)).reduce((a, s) => ({ open: a.open + s.open, done: a.done + s.done, late: a.late + s.late }), { open: 0, done: 0, late: 0 });
  return `
  <div class="row"><h1 class="sp">פרויקטים</h1><button class="btn ghost sm noprint" data-act="newProject">+ פרויקט</button></div>
  <div class="kpis">
    <div class="kpi"><b>${act.length}</b><span>פרויקטים פעילים</span></div>
    <div class="kpi"><b>${all.open}</b><span>משימות פתוחות</span></div>
    <div class="kpi green"><b>${all.done}</b><span>משימות שבוצעו</span></div>
    <div class="kpi red"><b>${all.late}</b><span>באיחור</span></div>
  </div>
  <div class="chips">
    ${people.map(p => `<button class="chip" data-act="fPerson" data-v="${esc(p)}" aria-pressed="${S.fPerson === p}">${p === 'all' ? 'כולם' : esc(p)}</button>`).join('')}
    <button class="chip" data-act="fDone" aria-pressed="${S.fShowDone}">הצג גם מה שבוצע</button>
  </div>
  <div class="pgrid">${act.map(p => {
    const its = S.items.filter(it => it.projectId === p.id && match(it))
      .sort((a, b) => ({ task: 0, ongoing: 1, info: 2 }[a.kind] - { task: 0, ongoing: 1, info: 2 }[b.kind]) || taskSort(a, b));
    const openSubs = S.subs.filter(s => s.projectId === p.id && (s.stage ?? -1) < 4).length;
    const s = projStats(p.id);
    return `<section class="pcard">
      <div class="ph"><h3>${esc(p.name)}</h3><div class="row">
        ${openSubs ? `<button class="btn ghost sm" data-act="goSubs" data-v="${p.id}">${openSubs} סגירות קבלנים</button>` : ''}
        <button class="btn ghost sm" data-act="newItem" data-v="${p.id}" aria-label="משימה חדשה ב${esc(p.name)}">+</button>
        <button class="btn ghost sm" data-act="editProject" data-id="${p.id}" aria-label="עריכת פרויקט">✎</button>
      </div></div>
      <div class="pk">
        <div><b>${s.open}</b><span>פתוחות</span></div>
        <div class="green"><b>${s.done}</b><span>בוצעו</span></div>
        <div class="red"><b>${s.late}</b><span>באיחור</span></div>
        <div><b>${s.stuck}</b><span>תקועות</span></div>
      </div>
      <div class="bar" role="img" aria-label="${s.pct}% מהמשימות בוצעו"><i style="width:${s.pct}%"></i></div>
      <div class="barl">${s.total ? `${s.done} מתוך ${s.total} משימות בוצעו · ${s.pct}%` : 'אין משימות עדיין'}</div>
      ${its.map(it => `<button class="prow" data-act="openItem" data-id="${it.id}">
        <div><div class="t">${it.urgent && it.status !== 'done' ? '<span class="urg">דחוף</span> ' : ''}${esc(it.text)}</div>
        <div class="m">${esc((it.owners || []).join(', ') || '')} ${dueChip(it)} ${bell(it)}${it.note ? ` · ${esc(it.note)}` : ''}</div></div>
        ${pill(it)}</button>`).join('') || '<div class="empty">אין פריטים</div>'}
    </section>`;
  }).join('')}</div>`;
}

function stepsHtml(stage) {
  return `<div class="steps ${stage === 4 ? 'full' : ''}" aria-hidden="true">${STAGES.map((_, i) => `<i class="${i <= stage ? 'on' : ''}"></i>`).join('')}</div>`;
}
function viewSubs() {
  const rows = S.subs.filter(s => !S.fSubOpen || (s.stage ?? -1) < 4)
    .filter(s => !S.fSubProject || s.projectId === S.fSubProject)
    .sort((a, b) => (S.projects.findIndex(p => p.id === a.projectId) - S.projects.findIndex(p => p.id === b.projectId)) || (a.stage ?? -1) - (b.stage ?? -1));
  return `
  <div class="row"><h1 class="sp">קבלני משנה</h1><button class="btn ghost sm" data-act="newSub">+ סגירה חדשה</button></div>
  <div class="chips">
    <button class="chip" data-act="fSubProject" data-v="" aria-pressed="${!S.fSubProject}">כל הפרויקטים</button>
    ${S.projects.filter(p => !p.archived && S.subs.some(s => s.projectId === p.id)).map(p => `<button class="chip" data-act="fSubProject" data-v="${p.id}" aria-pressed="${S.fSubProject === p.id}">${esc(p.name)}</button>`).join('')}
    <button class="chip" data-act="fSubOpen" aria-pressed="${!S.fSubOpen}">הצג גם חתומים</button>
  </div>
  <div class="legend">${STAGES.map((s, i) => `<span>${i + 1}. ${s}</span>`).join('')}</div>
  <div class="tbl"><table>
    <thead><tr><th>פרויקט</th><th>מקצוע</th><th>קבלן / מי קיבל הצעה</th><th>שלב</th><th>מחיר</th><th>אחריות</th><th>הערה</th></tr></thead>
    <tbody>${rows.map(s => `<tr class="click" data-act="openSub" data-id="${s.id}">
      <td><b>${esc(projName(s.projectId))}</b></td><td>${esc(s.trade)}</td><td>${esc(s.contractors || '—')}</td>
      <td>${stepsHtml(s.stage ?? -1)}<span style="font-size:12px">${stageName(s.stage ?? -1)}</span></td>
      <td>${esc(s.price || '')}</td><td>${esc((s.owners || []).join(', '))}</td><td style="color:#4B5563">${esc(s.note || '')}</td>
    </tr>`).join('') || '<tr><td colspan="7" class="empty">אין סגירות פתוחות</td></tr>'}</tbody>
  </table></div>`;
}

function viewFeed() {
  const seen = lastSeen();
  setTimeout(() => localStorage.setItem('seen', String(Date.now())), 1500);
  return `<h1>עדכונים</h1><p class="sub">כל מה שעודכן במערכת, מהחדש לישן</p>
  <div class="feed">${S.updates.map(u => `<div class="fi ${ts(u.at) > seen && u.by !== me() ? 'new' : ''}">
    <div>${esc(u.text)}</div><div class="w">${esc(u.by)} · ${fmtAgo(ts(u.at))}</div></div>`).join('') || '<div class="empty card">עוד אין עדכונים</div>'}</div>`;
}

function viewMeeting() {
  const since = ts(S.meta.lastMeetingAt);
  const show = it => it.status !== 'done' || ts(it.doneAt) > since;
  let n = 0;
  const rowsFor = list => list.map(it => `<tr><td>${++n}</td><td>${it.urgent && it.status !== 'done' ? '<b>דחוף! </b>' : ''}${esc(it.text)}${it.note ? `<br><span style="color:#475569">${esc(it.note)}</span>` : ''}</td>
    <td>${esc((it.owners || []).join(', ') || (it.kind === 'info' ? 'לידיעה' : ''))}</td><td>${it.kind === 'ongoing' ? 'שוטף' : fmtD(it.dueOrig || '')}</td>
    <td>${it.kind === 'task' && it.due !== it.dueOrig ? fmtD(it.due) : ''}</td><td>${it.kind === 'task' ? STATUS[it.status || 'open'] : KIND[it.kind]}</td></tr>`).join('');
  const sections = S.projects.filter(p => !p.archived).map(p => {
    const its = S.items.filter(it => it.projectId === p.id && show(it));
    const subs = S.subs.filter(s => s.projectId === p.id && ((s.stage ?? -1) < 4 || ts(s.updatedAt) > since));
    if (!its.length && !subs.length) return '';
    return `<tr class="sec"><td colspan="6">${esc(p.name)}</td></tr>${rowsFor(its)}
      ${subs.length ? `<tr class="sub"><td></td><td colspan="5">קבלני משנה</td></tr>${subs.map(s => `<tr><td>${++n}</td><td>${esc(s.trade)}${s.contractors ? ` – ${esc(s.contractors)}` : ''}${s.note ? ` – ${esc(s.note)}` : ''}${s.price ? ` (${esc(s.price)})` : ''}</td><td>${esc((s.owners || []).join(', '))}</td><td></td><td></td><td>${stageName(s.stage ?? -1)}</td></tr>`).join('')}` : ''}`;
  }).join('');
  const [y, m, d] = S.meetingDate.split('-');
  return `
  <div class="row noprint" style="margin-bottom:12px">
    <h1 class="sp">פגישה שבועית</h1>
    <label style="flex-direction:row;align-items:center;gap:8px">תאריך <input type="date" value="${S.meetingDate}" data-act="meetingDate" style="width:auto"></label>
    <button class="btn" data-act="print">הדפסה / PDF</button>
    <button class="btn ghost" data-act="closeMeeting">סיימנו פגישה</button>
  </div>
  <p class="sub noprint">מוצגות כל המשימות הפתוחות, ומה שבוצע מאז הפגישה הקודמת${since ? ` (${new Date(since).toLocaleDateString('he-IL')})` : ''}. "סיימנו פגישה" מוריד מהטבלה את מה שכבר בוצע.</p>
  <div style="text-align:center;font-weight:800;font-size:18px;margin:6px 0">פגישה שבועית – שלום בוקטוס בניה ויזמות בע"מ ${d}/${m}/${y}</div>
  <div style="font-size:13px;margin-bottom:6px">נוכחים: ${esc(S.team.map(t => t.name).join(', '))}</div>
  <div style="overflow-x:auto"><table class="mt">
    <thead><tr><th style="width:36px">מס</th><th>נושא</th><th style="width:110px">אחריות</th><th style="width:80px">יעד מקורי</th><th style="width:80px">יעד עדכני</th><th style="width:80px">סטטוס</th></tr></thead>
    <tbody>${sections}</tbody>
  </table></div>`;
}

/* ---------- sheets ---------- */
function openSheet(html) { $sheet.innerHTML = `<div class="box" role="dialog" aria-modal="true">${html}</div>`; $sheet.hidden = false; }
function closeSheet() { $sheet.hidden = true; $sheet.innerHTML = ''; }
const head = (title, sub) => `<div class="row"><div class="sp">${sub ? `<span class="proj">${esc(sub)}</span>` : ''}</div><button class="x" data-act="close" aria-label="סגירה">×</button></div><h3>${esc(title)}</h3>`;
const ownersChecks = sel => `<div class="checks">${[...S.team.map(t => t.name), 'כולם'].map(n => `<label><input type="checkbox" name="owners" value="${esc(n)}" ${(sel || []).includes(n) ? 'checked' : ''}> ${esc(n)}</label>`).join('')}</div>`;

let draft = {};
function sheetItem(id) {
  const it = S.items.find(x => x.id === id); if (!it) return;
  draft = { id, status: it.status || 'open' };
  openSheet(`${head(it.text, projName(it.projectId))}
    <div class="m" style="font-size:13px;color:#4B5563">אחריות: ${esc((it.owners || []).join(', ') || '—')} · ${KIND[it.kind]}${it.dueOrig ? ` · יעד מקורי ${fmtD(it.dueOrig)}` : ''} ${dueChip(it)}</div>
    ${it.remindAt ? `<div style="font-size:13px">🔔 תזכורת ${esc(fmtRemind(it.remindAt))} ל${esc((it.remindTo || []).join(', '))}${it.reminderSent ? ' (נשלחה)' : ''}</div>` : ''}
    ${it.kind === 'task' ? `<div style="font-size:13px;color:#4B5563">מה המצב?</div>
    <div class="seg">${Object.entries(STATUS).map(([k, l]) => `<button class="${k}" data-act="st" data-v="${k}" aria-pressed="${draft.status === k}">${l}</button>`).join('')}</div>
    <label>יעד עדכני<input type="date" id="f-due" value="${esc(it.due || '')}"></label>` : ''}
    <label>הערה, מחיר או פרטים<textarea id="f-note" placeholder="למשל: נסגר ב-12,000 ₪, מתחיל ביום ראשון">${esc(it.note || '')}</textarea></label>
    <div class="row"><button class="btn sp" data-act="saveItem">שמור עדכון</button><button class="btn wa" data-act="saveItem" data-v="wa">שמור ושלח בוואטסאפ</button></div>
    <div class="row"><button class="btn ghost sm" data-act="editItem" data-id="${id}">עריכה מלאה</button><button class="btn ghost sm" data-act="editItem" data-id="${id}">🔔 הגדר תזכורת</button></div>
    ${it.updatedBy ? `<div class="hist">עודכן לאחרונה ע״י ${esc(it.updatedBy)} ${fmtAgo(ts(it.updatedAt))}</div>` : ''}`);
}

function sheetItemForm(id, projectId) {
  const it = id ? S.items.find(x => x.id === id) : { projectId: projectId || (S.projects[0] || {}).id, kind: 'task', owners: [me()], status: 'open' };
  openSheet(`${head(id ? 'עריכת פריט' : 'פריט חדש')}
    <label>נושא<textarea id="f-text">${esc(it.text || '')}</textarea></label>
    <div class="two">
      <label>פרויקט<select id="f-proj">${S.projects.map(p => `<option value="${p.id}" ${p.id === it.projectId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      <label>סוג<select id="f-kind">${Object.entries(KIND).map(([k, l]) => `<option value="${k}" ${k === it.kind ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>
    <div style="font-size:13px;color:#4B5563">אחריות</div>${ownersChecks(it.owners)}
    <div class="two">
      <label>תאריך יעד<input type="date" id="f-due2" value="${esc(it.due || '')}"></label>
      <label style="flex-direction:row;align-items:center;gap:8px;margin-top:18px"><input type="checkbox" id="f-urg" ${it.urgent ? 'checked' : ''}> דחוף</label>
    </div>
    <label>הערה<textarea id="f-note2">${esc(it.note || '')}</textarea></label>
    <fieldset class="rem"><legend>🔔 תזכורת לטלפון</legend>
      <div class="two"><label>תאריך<input type="date" id="f-rd" value="${esc((it.remindAt || '').split('T')[0] || '')}"></label>
      <label>שעה<input type="time" id="f-rt" value="${esc((it.remindAt || '').split('T')[1] || '08:00')}"></label></div>
      <div style="font-size:13px;color:#4B5563">למי לשלוח? (ברירת מחדל: האחראים)</div>
      <div class="checks">${S.team.map(t => `<label><input type="checkbox" name="remindTo" value="${esc(t.name)}" ${(it.remindTo || []).includes(t.name) ? 'checked' : ''}> ${esc(t.name)}</label>`).join('')}</div>
      ${it.remindAt ? `<button class="btn ghost sm" data-act="clearRemind" type="button">בטל תזכורת</button>` : ''}
    </fieldset>
    <div class="row"><button class="btn sp" data-act="saveItemForm" data-id="${id || ''}">שמירה</button>
    ${id ? `<button class="btn danger" data-act="delItem" data-id="${id}">מחיקה</button>` : ''}</div>`);
}

function sheetSub(id) {
  const s = id ? S.subs.find(x => x.id === id) : { projectId: S.fSubProject || (S.projects[0] || {}).id, stage: -1, owners: [me()] };
  draft = { sid: id, stage: s.stage ?? -1 };
  openSheet(`${head(id ? s.trade : 'סגירת קבלן חדשה', id ? projName(s.projectId) : '')}
    <div class="two">
      <label>פרויקט<select id="s-proj">${S.projects.map(p => `<option value="${p.id}" ${p.id === s.projectId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      <label>מקצוע<input type="text" id="s-trade" value="${esc(s.trade || '')}" placeholder="חשמל, שלד, איטום…"></label>
    </div>
    <div style="font-size:13px;color:#4B5563">באיזה שלב?</div>
    <div class="seg five">${[-1, 0, 1, 2, 3, 4].map(i => `<button data-act="stage" data-v="${i}" aria-pressed="${draft.stage === i}">${stageName(i)}</button>`).join('')}</div>
    <label>קבלן / מי קיבל הצעה<input type="text" id="s-con" value="${esc(s.contractors || '')}"></label>
    <label>מחיר / תנאים<input type="text" id="s-price" value="${esc(s.price || '')}" placeholder="למשל: 180,000 ₪ או דקל פחות 15%"></label>
    <div style="font-size:13px;color:#4B5563">אחריות</div>${ownersChecks(s.owners)}
    <label>הערה<textarea id="s-note">${esc(s.note || '')}</textarea></label>
    <div class="row"><button class="btn sp" data-act="saveSub">שמירה</button><button class="btn wa" data-act="saveSub" data-v="wa">שמור ושלח בוואטסאפ</button>
    ${id ? `<button class="btn danger" data-act="delSub" data-id="${id}">מחיקה</button>` : ''}</div>`);
}

function sheetProject(id) {
  const p = id ? S.projects.find(x => x.id === id) : {};
  openSheet(`${head(id ? 'עריכת פרויקט' : 'פרויקט חדש')}
    <label>שם הפרויקט<input type="text" id="p-name" value="${esc(p.name || '')}"></label>
    ${id ? `<label style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" id="p-arch" ${p.archived ? 'checked' : ''}> הפרויקט הסתיים (להסתיר)</label>` : ''}
    <button class="btn" data-act="saveProject" data-id="${id || ''}">שמירה</button>`);
}

function sheetWho() {
  openSheet(`${head('מי אתה?')}
    <p class="sub" style="margin:0">בחר את השם שלך, כדי שהמערכת תציג לך את המשימות שלך. זה נשמר פעם אחת.</p>
    <div class="list">${S.team.filter(t => !t.email).map(t => `<button class="btn ghost" data-act="iAm" data-v="${esc(t.name)}">${esc(t.name)}</button>`).join('')}
    <button class="btn ghost" data-act="iAm" data-v="">אני לא ברשימה – להוסיף אותי</button></div>`);
}

function sheetTeam() {
  const rows = [...S.team, { name: '', email: '' }];
  openSheet(`${head('אנשי הצוות')}
    <p class="sub" style="margin:0">השם מופיע באחריות על משימות. המייל מחבר בין החשבון שמתחבר לבין השם. ההרשאה לכניסה עצמה מוגדרת ב-Firebase.</p>
    <div id="team-rows" style="display:flex;flex-direction:column;gap:8px">${rows.map(t => `<div class="two"><input type="text" placeholder="שם" value="${esc(t.name)}" data-team="name"><input type="email" placeholder="מייל" value="${esc(t.email || '')}" data-team="email" dir="ltr"></div>`).join('')}</div>
    <button class="btn ghost sm" data-act="teamRow">+ עוד שורה</button>
    <button class="btn" data-act="saveTeam">שמירה</button>`);
}

/* ---------- actions ---------- */
async function seed() {
  const b = writeBatch(db);
  SEED_PROJECTS.forEach(p => b.set(doc(db, 'projects', p.id), { name: p.name, order: p.order, archived: false }));
  SEED_ITEMS.forEach(([projectId, text, kind, owners, due = '', urgent = false, note = '']) => {
    b.set(doc(collection(db, 'items')), { projectId, text, kind, owners, due, dueOrig: due, urgent, note, status: 'open', createdAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: me() });
  });
  SEED_SUBS.forEach(([projectId, trade, contractors, stage, note, owners]) => {
    b.set(doc(collection(db, 'subs')), { projectId, trade, contractors, stage, note, owners, price: '', updatedAt: serverTimestamp() });
  });
  b.set(doc(db, 'settings', 'main'), { team: SEED_TEAM.map(name => ({ name, email: '' })) }, { merge: true });
  await b.commit();
  await logUpdate('נטענו הנתונים מהפגישה השבועית של 22.11');
  toast('הנתונים נטענו');
}

const vals = name => [...$sheet.querySelectorAll(`input[name=${name}]:checked`)].map(i => i.value);

async function handle(act, el) {
  const v = el.dataset.v, id = el.dataset.id;
  switch (act) {
    case 'forgot': {
      const email = document.getElementById('l-email').value.trim();
      if (!email) { renderLogin('כתבו קודם את המייל שלכם, ואז לחצו "שכחתי סיסמה"'); return; }
      try { await sendPasswordResetEmail(auth, email); renderLogin('', 'אם המייל רשום במערכת, נשלח אליו קישור להחלפת סיסמה. כדאי לבדוק גם בספאם.'); }
      catch (e) { renderLogin(authMsg(e)); }
      break;
    }
    case 'logout': await signOut(auth); break;
    case 'tab': S.tab = v; localStorage.setItem('tab', v); render(); window.scrollTo(0, 0); break;
    case 'fPerson': S.fPerson = v; render(); break;
    case 'fDone': S.fShowDone = !S.fShowDone; render(); break;
    case 'enablePush': el.disabled = true; await enablePush(); break;
    case 'view': S.view = v; localStorage.setItem('view', v); render(); break;
    case 'fStatus': S.fStatus = v; render(); break;
    case 'clearRemind': document.getElementById('f-rd').value = ''; el.remove(); break;
    case 'fSubOpen': S.fSubOpen = !S.fSubOpen; render(); break;
    case 'fSubProject': S.fSubProject = v; render(); break;
    case 'goSubs': S.fSubProject = v; S.tab = 'subs'; render(); break;
    case 'seed': el.disabled = true; el.textContent = 'טוען…'; await seed(); break;
    case 'close': closeSheet(); break;
    case 'openItem': sheetItem(id); break;
    case 'editItem': sheetItemForm(id); break;
    case 'newItem': sheetItemForm(null, v); break;
    case 'openSub': sheetSub(id); break;
    case 'newSub': sheetSub(null); break;
    case 'newProject': sheetProject(null); break;
    case 'editProject': sheetProject(id); break;
    case 'team': sheetTeam(); break;
    case 'teamRow': document.getElementById('team-rows').insertAdjacentHTML('beforeend', `<div class="two"><input type="text" placeholder="שם" data-team="name"><input type="email" placeholder="מייל" data-team="email" dir="ltr"></div>`); break;
    case 'st':
      draft.status = v;
      $sheet.querySelectorAll('[data-act=st]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
      break;
    case 'stage':
      draft.stage = Number(v);
      $sheet.querySelectorAll('[data-act=stage]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
      break;
    case 'saveItem': {
      const it = S.items.find(x => x.id === draft.id);
      const note = document.getElementById('f-note').value.trim();
      const dueEl = document.getElementById('f-due');
      const upd = { note, updatedAt: serverTimestamp(), updatedBy: me() };
      if (it.kind === 'task') {
        upd.status = draft.status;
        if (draft.status === 'done' && it.status !== 'done') upd.doneAt = serverTimestamp();
        if (dueEl) upd.due = dueEl.value;
      }
      await updateDoc(doc(db, 'items', it.id), upd);
      const msg = `${projName(it.projectId)} | ${it.text}${it.kind === 'task' ? ` ← ${STATUS[draft.status]}` : ''}${note && note !== it.note ? ` · ${note}` : ''}`;
      await logUpdate(msg, { type: 'item', id: it.id });
      closeSheet(); toast('העדכון נשמר ומופיע אצל כולם');
      if (v === 'wa') window.open(waLink(`עדכון מ${me()}: ${msg}`), '_blank');
      break;
    }
    case 'saveItemForm': {
      const text = document.getElementById('f-text').value.trim();
      if (!text) { toast('צריך לכתוב נושא'); return; }
      const data = {
        text, projectId: document.getElementById('f-proj').value, kind: document.getElementById('f-kind').value,
        owners: vals('owners'), due: document.getElementById('f-due2').value, urgent: document.getElementById('f-urg').checked,
        note: document.getElementById('f-note2').value.trim(), updatedAt: serverTimestamp(), updatedBy: me()
      };
      const rd = document.getElementById('f-rd').value, rt = document.getElementById('f-rt').value || '08:00';
      const old = id ? S.items.find(x => x.id === id) : {};
      data.remindAt = rd ? `${rd}T${rt}` : '';
      data.remindTo = rd ? (vals('remindTo').length ? vals('remindTo') : data.owners.filter(o => o !== 'כולם')) : [];
      if (data.remindAt !== (old.remindAt || '')) data.reminderSent = false;
      if (id) { await updateDoc(doc(db, 'items', id), data); }
      else {
        await addDoc(collection(db, 'items'), { ...data, dueOrig: data.due, status: 'open', createdAt: serverTimestamp() });
        await logUpdate(`משימה חדשה ב${projName(data.projectId)}: ${text}${data.owners.length ? ` (${data.owners.join(', ')})` : ''}`);
      }
      closeSheet(); toast('נשמר');
      break;
    }
    case 'delItem':
      if (!confirm('למחוק את הפריט? אי אפשר לבטל.')) return;
      await deleteDoc(doc(db, 'items', id)); closeSheet(); toast('נמחק'); break;
    case 'saveSub': {
      const trade = document.getElementById('s-trade').value.trim();
      if (!trade) { toast('צריך לכתוב מקצוע'); return; }
      const data = {
        projectId: document.getElementById('s-proj').value, trade, stage: draft.stage,
        contractors: document.getElementById('s-con').value.trim(), price: document.getElementById('s-price').value.trim(),
        owners: vals('owners'), note: document.getElementById('s-note').value.trim(), updatedAt: serverTimestamp(), updatedBy: me()
      };
      const old = draft.sid ? S.subs.find(x => x.id === draft.sid) : null;
      if (old) await updateDoc(doc(db, 'subs', old.id), data); else await addDoc(collection(db, 'subs'), data);
      const msg = `${projName(data.projectId)} | קבלן ${trade}${data.contractors ? ` (${data.contractors})` : ''} ← ${stageName(data.stage)}${data.price ? ` · ${data.price}` : ''}`;
      if (!old || old.stage !== data.stage || old.price !== data.price || old.contractors !== data.contractors) await logUpdate(msg, { type: 'sub' });
      closeSheet(); toast('נשמר');
      if (v === 'wa') window.open(waLink(`עדכון מ${me()}: ${msg}`), '_blank');
      break;
    }
    case 'delSub':
      if (!confirm('למחוק את השורה? אי אפשר לבטל.')) return;
      await deleteDoc(doc(db, 'subs', id)); closeSheet(); toast('נמחק'); break;
    case 'saveProject': {
      const name = document.getElementById('p-name').value.trim();
      if (!name) return;
      if (id) await updateDoc(doc(db, 'projects', id), { name, archived: document.getElementById('p-arch').checked });
      else {
        await addDoc(collection(db, 'projects'), { name, order: S.projects.length, archived: false });
        await logUpdate(`פרויקט חדש: ${name}`);
      }
      closeSheet(); toast('נשמר'); break;
    }
    case 'saveTeam': {
      const names = [...$sheet.querySelectorAll('[data-team=name]')], emails = [...$sheet.querySelectorAll('[data-team=email]')];
      const team = names.map((n, i) => ({ name: n.value.trim(), email: emails[i].value.trim().toLowerCase() })).filter(t => t.name);
      await setDoc(doc(db, 'settings', 'main'), { team }, { merge: true });
      closeSheet(); toast('הצוות עודכן'); break;
    }
    case 'iAm': {
      const email = (S.user.email || '').toLowerCase();
      const team = S.team.map(t => ({ ...t }));
      const hit = team.find(t => t.name === v);
      if (hit) hit.email = email; else team.push({ name: S.user.displayName || email, email });
      await setDoc(doc(db, 'settings', 'main'), { team }, { merge: true });
      closeSheet(); toast('שלום ' + (hit ? hit.name : (S.user.displayName || ''))); setTimeout(refreshPushName, 500); break;
    }
    case 'print': window.print(); break;
    case 'closeMeeting':
      if (!confirm('לסמן שהפגישה הסתיימה? משימות שבוצעו יירדו מהטבלה של הפגישה הבאה.')) return;
      await setDoc(doc(db, 'settings', 'main'), { lastMeetingAt: serverTimestamp() }, { merge: true });
      await logUpdate('הפגישה השבועית הסתיימה'); toast('נשמר'); break;
  }
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.tagName === 'INPUT' || el.tagName === 'SELECT') return;
  e.preventDefault();
  handle(el.dataset.act, el).catch(err => { console.error(err); toast('שגיאה: ' + (err.code || err.message)); });
});
document.addEventListener('submit', async e => {
  if (e.target.id !== 'login-form') return;
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true; btn.textContent = 'נכנס…';
  try { await signInWithEmailAndPassword(auth, document.getElementById('l-email').value.trim(), document.getElementById('l-pass').value); }
  catch (err) { renderLogin(authMsg(err)); }
});
document.addEventListener('change', e => {
  const a = e.target.dataset && e.target.dataset.act;
  if (a === 'meetingDate') { S.meetingDate = e.target.value || today(); render(); }
  if (a === 'fPersonSel') { S.fPerson = e.target.value; render(); }
  if (a === 'fProjectSel') { S.fProject = e.target.value; render(); }
});
$sheet.addEventListener('click', e => { if (e.target === $sheet) closeSheet(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$sheet.hidden) closeSheet(); });
