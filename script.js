'use strict';
// ================================================================
//  FLASHCOACH v2 — Anki-style spaced repetition, 100% local.
//  Same IndexedDB (FlashCoachDB v3, same stores) as the old app,
//  so every existing deck / card / review is kept.
// ================================================================

const DB_NAME = 'FlashCoachDB';
const DB_VERSION = 3;
const ROLLOVER = 4;                       // a new "study day" starts at 4 am (like Anki)

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const clone = (c) => JSON.parse(JSON.stringify(c));

// ---------------------------------------------------------------
//  IndexedDB wrapper (schema identical to the previous version)
// ---------------------------------------------------------------
class Store {
    constructor() {
        this.db = null; this.memory = false; this.memSeq = 1;
        this.mem = { cards: new Map(), decks: new Map(), history: new Map(), settings: new Map() };
    }
    init() {
        return new Promise((res) => {
            if (typeof indexedDB === 'undefined') { this.memory = true; return res(); }
            let rq;
            try { rq = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { this.memory = true; return res(); }
            rq.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('cards')) {
                    const s = db.createObjectStore('cards', { keyPath: 'id' });
                    s.createIndex('deckId', 'deckId', { unique: false });
                    s.createIndex('due', 'due', { unique: false });
                    s.createIndex('state', 'state', { unique: false });
                }
                if (!db.objectStoreNames.contains('decks')) db.createObjectStore('decks', { keyPath: 'id' });
                if (!db.objectStoreNames.contains('history')) {
                    const s = db.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
                    s.createIndex('cardId', 'cardId', { unique: false });
                }
                if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
            };
            rq.onsuccess = (e) => { this.db = e.target.result; this.db.onversionchange = () => this.db.close(); res(); };
            rq.onerror = () => { this.memory = true; res(); };
        });
    }
    _run(store, mode, fn) {
        return new Promise((ok, bad) => {
            const tx = this.db.transaction(store, mode);
            let out;
            const rq = fn(tx.objectStore(store));
            if (rq && 'onsuccess' in rq) rq.onsuccess = () => { out = rq.result; };
            tx.oncomplete = () => ok(out);
            tx.onerror = tx.onabort = () => bad(tx.error);
        });
    }
    get(s, id) { return this.memory ? Promise.resolve(this.mem[s].get(id)) : this._run(s, 'readonly', (o) => o.get(id)); }
    getAll(s) { return this.memory ? Promise.resolve([...this.mem[s].values()]) : this._run(s, 'readonly', (o) => o.getAll()).then((r) => r || []); }
    put(s, d) {
        if (this.memory) { let k = d.id ?? d.key; if (k === undefined) { k = this.memSeq++; d.id = k; } this.mem[s].set(k, d); return Promise.resolve(k); }
        return this._run(s, 'readwrite', (o) => o.put(d));
    }
    putMany(s, list) {
        if (!list.length) return Promise.resolve();
        if (this.memory) { list.forEach((d) => this.put(s, d)); return Promise.resolve(); }
        return this._run(s, 'readwrite', (o) => { list.forEach((d) => o.put(d)); });
    }
    delete(s, id) { return this.memory ? (this.mem[s].delete(id), Promise.resolve()) : this._run(s, 'readwrite', (o) => o.delete(id)); }
    deleteMany(s, ids) {
        if (!ids.length) return Promise.resolve();
        if (this.memory) { ids.forEach((i) => this.mem[s].delete(i)); return Promise.resolve(); }
        return this._run(s, 'readwrite', (o) => { ids.forEach((i) => o.delete(i)); });
    }
    clear(s) { return this.memory ? (this.mem[s].clear(), Promise.resolve()) : this._run(s, 'readwrite', (o) => o.clear()); }
}

// ---------------------------------------------------------------
//  Settings & app state
// ---------------------------------------------------------------
const DEF = {
    dailyGoal: 20, newPerDay: 20, revPerDay: 200,
    learningSteps: [1, 10], relearnSteps: [10],
    graduatingInterval: 1, easyInterval: 4, startingEase: 2.5, easyBonus: 1.3,
    hardInterval: 1.2, intervalMod: 1, maxInterval: 36500, lapseMult: 0,
    leechThreshold: 8, learnAheadLimit: 20,
    theme: 'light', quizName: 'Final round', quizDate: '2026-11-25',
    studyLog: {}, lastBackup: null, lastDeckId: null,
};

const App = {
    storage: new Store(),
    cards: [], decks: [], history: [], settings: { ...DEF },
    cardMap: new Map(), histVer: 0, lastSeq: 0,
    tab: 'decks', session: null, cur: null, undo: [], busy: false,
    imgCache: new Map(), editing: null, sheetDeckId: null, sheetCardId: null,
    B: { q: '', deck: '', sort: 'created', desc: true, limit: 50, selecting: false, sel: new Set() },
    imp: { rows: [], text: '' }, lastDeleted: null, katexP: null,
};

// ---------------------------------------------------------------
//  Time helpers (local time, day rolls over at 4 am)
// ---------------------------------------------------------------
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function dayStart(d = new Date()) {
    const x = new Date(d); x.setHours(ROLLOVER, 0, 0, 0);
    if (new Date(d) < x) x.setDate(x.getDate() - 1);
    return x;
}
const dayKey = (d = new Date()) => ymd(dayStart(d));
function nextDayStart() { const s = dayStart(); s.setDate(s.getDate() + 1); return s; }
const nowISO = () => new Date().toISOString();
function nextSeq() { App.lastSeq = Math.max(App.lastSeq + 1, Date.now() * 1000); return App.lastSeq; }
function generateId() { return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }
function localName(n) { return n && n.includes('::') ? n.split('::').pop() : (n || ''); }
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

function fmtDays(d) {
    if (d < 30) return d + 'd';
    if (d < 365) { const m = d / 30; return (m >= 10 ? Math.round(m) : +m.toFixed(1)) + 'mo'; }
    return +(d / 365).toFixed(1) + 'y';
}
function fmtMins(m) {
    if (m < 1) return '<1m';
    if (m < 60) return Math.round(m) + 'm';
    if (m < 1440) { const h = m / 60; return (+h.toFixed(1)) + 'h'; }
    return fmtDays(Math.round(m / 1440));
}
function fmtDate(iso) { return iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; }

// ---------------------------------------------------------------
//  Scheduler — classic Anki (SM-2 based, v2/v3 behaviour)
//  rating: 0 Again · 1 Hard · 2 Good · 3 Easy
// ---------------------------------------------------------------
function calc(card, r, now = new Date()) {
    const S = App.settings, t = now.getTime();
    const c = {
        state: card.state || 'new', interval: card.interval || 0, ease: card.ease || S.startingEase,
        reps: (card.reps || 0) + 1, lapses: card.lapses || 0, step: card.step || 0, leech: false, due: null,
    };
    const mins = (m) => new Date(t + m * 60000);
    const inDays = (d) => { const s = dayStart(now); s.setDate(s.getDate() + d); return s; };
    const grad = (ivl) => {
        c.state = 'review'; c.step = 0;
        c.interval = Math.min(S.maxInterval, Math.max(1, Math.round(ivl)));
        c.due = inDays(c.interval);
    };

    if (c.state === 'new' || c.state === 'learning' || c.state === 'relearning') {
        const re = c.state === 'relearning';
        const stp = re ? (S.relearnSteps.length ? S.relearnSteps : [10]) : (S.learningSteps.length ? S.learningSteps : [1]);
        const i = c.state === 'new' ? 0 : Math.min(c.step, stp.length - 1);
        if (c.state === 'new') c.state = 'learning';
        if (r === 0) { c.step = 0; c.due = mins(stp[0]); }
        else if (r === 1) {
            let d = stp[i];
            if (i === 0) d = stp.length > 1 ? (stp[0] + stp[1]) / 2 : Math.min(stp[0] * 1.5, stp[0] + 1440);
            c.step = i; c.due = mins(d);
        } else if (r === 2) {
            if (i + 1 < stp.length) { c.step = i + 1; c.due = mins(stp[i + 1]); }
            else if (re) grad(c.interval);
            else grad(S.graduatingInterval);
        } else {
            if (re) grad(c.interval + 1); else grad(S.easyInterval);
        }
    } else { // review
        const ivl = Math.max(1, c.interval), mod = S.intervalMod;
        const late = Math.max(0, Math.floor((t - Date.parse(card.due)) / 86400000));
        if (r === 0) {
            c.lapses++; c.ease = Math.max(1.3, c.ease - 0.2);
            c.interval = Math.max(1, Math.round(ivl * S.lapseMult));
            if (c.lapses >= S.leechThreshold) c.leech = true;
            if (S.relearnSteps.length) { c.state = 'relearning'; c.step = 0; c.due = mins(S.relearnSteps[0]); }
            else c.due = inDays(c.interval);
        } else {
            const hard = Math.max(Math.round(ivl * S.hardInterval * mod), ivl + 1);
            const good = Math.max(Math.round((ivl + late / 2) * c.ease * mod), hard + 1);
            const easy = Math.max(Math.round((ivl + late) * c.ease * S.easyBonus * mod), good + 1);
            if (r === 1) { c.interval = hard; c.ease = Math.max(1.3, c.ease - 0.15); }
            else if (r === 2) c.interval = good;
            else { c.interval = easy; c.ease += 0.15; }
            c.interval = Math.min(S.maxInterval, c.interval);
            c.due = inDays(c.interval);
        }
    }
    c.ease = +c.ease.toFixed(2);
    c.label = c.state === 'review' ? fmtDays(c.interval) : fmtMins((c.due.getTime() - t) / 60000);
    return c;
}
const previewLabels = (card) => [0, 1, 2, 3].map((r) => calc(card, r).label);

// ---------------------------------------------------------------
//  Decks
// ---------------------------------------------------------------
const getDeck = (id) => App.decks.find((d) => d.id === id);
function descendants(deckId) {
    const d = getDeck(deckId); if (!d) return [deckId];
    const p = d.name + '::';
    return [d.id, ...App.decks.filter((x) => x.name.startsWith(p)).map((x) => x.id)];
}
function hasChildren(d) { const p = d.name + '::'; return App.decks.some((x) => x.name.startsWith(p)); }
function hiddenByCollapse(d) {
    const parts = d.name.split('::');
    for (let i = 1; i < parts.length; i++) {
        const a = App.decks.find((x) => x.name === parts.slice(0, i).join('::'));
        if (a && a.collapsed) return true;
    }
    return false;
}
function deckOptionsHtml(selected, withAll) {
    const sorted = [...App.decks].sort((a, b) => a.name.localeCompare(b.name));
    return (withAll ? '<option value="">All decks</option>' : '') +
        sorted.map((d) => `<option value="${d.id}" ${d.id === selected ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
}

async function createDeck(name) {
    const parts = String(name || '').split('::').map((p) => p.trim()).filter(Boolean);
    if (!parts.length) return null;
    const made = []; let parentId = null, deck = null;
    for (let i = 0; i < parts.length; i++) {
        const full = parts.slice(0, i + 1).join('::');
        deck = App.decks.find((d) => d.name.toLowerCase() === full.toLowerCase());
        if (!deck) {
            deck = { id: generateId(), name: full, parentId, createdAt: nowISO(), modifiedAt: nowISO(), description: '', collapsed: false };
            App.decks.push(deck); made.push(deck);
        }
        parentId = deck.id;
    }
    await App.storage.putMany('decks', made);
    return deck;
}
async function renameDeck(id, newName) {
    const deck = getDeck(id); if (!deck) return false;
    const target = newName.split('::').map((p) => p.trim()).filter(Boolean).join('::');
    if (!target) return false;
    if (target.toLowerCase() === deck.name.toLowerCase() && target === deck.name) return false;
    if (App.decks.some((d) => d.id !== id && d.name.toLowerCase() === target.toLowerCase())) { toast('A deck with that name already exists.', 'error'); return false; }
    if (target.toLowerCase().startsWith(deck.name.toLowerCase() + '::')) { toast("A deck can't be moved inside itself.", 'error'); return false; }
    const old = deck.name, p = old + '::', changed = [];
    App.decks.forEach((d) => {
        if (d.id === id) d.name = target;
        else if (d.name.startsWith(p)) d.name = target + d.name.slice(old.length);
        else return;
        d.modifiedAt = nowISO(); changed.push(d);
    });
    // make sure ancestors of the new name exist, then fix parent links
    const parentName = target.includes('::') ? target.split('::').slice(0, -1).join('::') : '';
    if (parentName) await createDeck(parentName);
    App.decks.forEach((d) => {
        const pn = d.name.includes('::') ? d.name.split('::').slice(0, -1).join('::') : '';
        const par = pn ? App.decks.find((x) => x.name === pn) : null;
        const pid = par ? par.id : null;
        if (d.parentId !== pid) { d.parentId = pid; if (!changed.includes(d)) changed.push(d); }
    });
    await App.storage.putMany('decks', changed);
    return true;
}
async function deleteDeck(id) {
    const ids = descendants(id), idSet = new Set(ids);
    const decks = App.decks.filter((d) => idSet.has(d.id));
    const cards = App.cards.filter((c) => idSet.has(c.deckId));
    await App.storage.deleteMany('cards', cards.map((c) => c.id));
    await App.storage.deleteMany('decks', ids);
    App.decks = App.decks.filter((d) => !idSet.has(d.id));
    App.cards = App.cards.filter((c) => !idSet.has(c.deckId));
    cards.forEach((c) => App.cardMap.delete(c.id));
    return { decks, cards };
}

// ---------------------------------------------------------------
//  Cards
// ---------------------------------------------------------------
const isCloze = (c) => /\{\{c\d+::/.test(c.front || '');
const isActive = (c) => !c.suspended && !c.buried;
function clozeOrds(text) { return [...new Set([...String(text).matchAll(/\{\{c(\d+)::/g)].map((m) => +m[1]))].sort((a, b) => a - b); }

function normalizeCard(c) {
    if (!c.state) c.state = 'new';
    if (!Array.isArray(c.tags)) c.tags = [];
    if (c.state === 'suspended') {              // old leech handling lost the real state
        c.suspended = true; c.state = 'review'; c.interval = Math.max(1, Math.round(c.interval || 1));
        if (!c.tags.includes('leech')) c.tags.push('leech');
    }
    if (!c.ease) c.ease = DEF.startingEase;
    if (c.state === 'learning' || c.state === 'relearning') {
        if (c.step == null) c.step = (c.state === 'learning' && c.reps > 0) ? 1 : 0;
        if (c.state === 'learning') c.interval = 0;
        if (c.state === 'relearning' && !(c.interval >= 1)) c.interval = 1;
    }
    if (c.buried && c.buriedDay !== dayKey()) c.buried = false;
    if (c.flag == null) c.flag = 0;
    if (c.seq == null) c.seq = (Date.parse(c.createdAt) || 0) * 1000;
    if (!c.due) c.due = nowISO();
    return c;
}

function buildCards({ deckId, front, back, tags, reverse }) {
    const S = App.settings, noteId = generateId();
    const mk = (f, b, extra = {}) => ({
        id: generateId(), noteId, deckId, front: f, back: b, tags: [...tags], createdAt: nowISO(), modifiedAt: nowISO(),
        due: nowISO(), interval: 0, ease: S.startingEase, reps: 0, lapses: 0, state: 'new', step: 0,
        suspended: false, buried: false, flag: 0, notes: '', seq: nextSeq(), ...extra,
    });
    const out = [];
    if (/\{\{c\d+::/.test(front)) clozeOrds(front).forEach((o) => out.push(mk(front, back, { clozeOrd: o })));
    else { out.push(mk(front, back)); if (reverse && back) out.push(mk(back, front)); }
    return out;
}
async function addCards(list) {
    await App.storage.putMany('cards', list);
    list.forEach((c) => { App.cards.push(c); App.cardMap.set(c.id, c); });
}
async function saveCards(list) {
    list.forEach((c) => { c.modifiedAt = nowISO(); });
    await App.storage.putMany('cards', list);
}
async function removeCards(cards) {
    await App.storage.deleteMany('cards', cards.map((c) => c.id));
    const ids = new Set(cards.map((c) => c.id));
    App.cards = App.cards.filter((c) => !ids.has(c.id));
    cards.forEach((c) => App.cardMap.delete(c.id));
}
function replaceCard(snap) {            // put a snapshot back into memory (used by undo)
    const i = App.cards.findIndex((c) => c.id === snap.id);
    if (i >= 0) App.cards[i] = snap; else App.cards.push(snap);
    App.cardMap.set(snap.id, snap);
    return snap;
}

// ---------------------------------------------------------------
//  Today's numbers & deck counts (daily limits like Anki)
// ---------------------------------------------------------------
function todayList() {
    const key = App.histVer + '|' + dayKey();
    if (App._tk !== key) {
        const s = dayStart().getTime();
        App._tl = App.history.filter((h) => Date.parse(h.timestamp) >= s);
        App._tk = key;
    }
    return App._tl;
}
function deckStats() {
    const S = App.settings, now = Date.now(), la = now + S.learnAheadLimit * 60000, eod = nextDayStart().getTime();
    const raw = new Map(App.decks.map((d) => [d.id, { n: 0, l: 0, r: 0, t: 0, tn: 0, tr: 0 }]));
    for (const c of App.cards) {
        const r = raw.get(c.deckId); if (!r) continue;
        r.t++;
        if (!isActive(c)) continue;
        if (c.state === 'new') r.n++;
        else if (c.state === 'learning' || c.state === 'relearning') { if (Date.parse(c.due) <= la) r.l++; }
        else if (c.state === 'review') { if (Date.parse(c.due) < eod) r.r++; }
    }
    for (const h of todayList()) {
        if (h.cram) continue;
        const card = App.cardMap.get(h.cardId), r = card && raw.get(card.deckId);
        if (!r) continue;
        if (h.oldState === 'new') r.tn++; else if (h.oldState === 'review') r.tr++;
    }
    const out = new Map();
    for (const d of App.decks) {
        const p = d.name + '::'; let n = 0, l = 0, rv = 0, t = 0, tn = 0, tr = 0;
        for (const x of App.decks) {
            if (x.id !== d.id && !x.name.startsWith(p)) continue;
            const r = raw.get(x.id); n += r.n; l += r.l; rv += r.r; t += r.t; tn += r.tn; tr += r.tr;
        }
        out.set(d.id, { new: Math.max(0, Math.min(n, S.newPerDay - tn)), learn: l, due: Math.max(0, Math.min(rv, S.revPerDay - tr)), total: t });
    }
    return out;
}

// ---------------------------------------------------------------
//  Next card (Anki order: learning due → reviews → new → learn-ahead)
// ---------------------------------------------------------------
function getNext() {
    const set = App.session.deckSet, S = App.settings, now = Date.now(), la = now + S.learnAheadLimit * 60000;
    const eod = nextDayStart().getTime(), st = deckStats().get(App.session.deckId) || { new: 0, due: 0 };
    const salt = dayKey();
    let learnNow = null, learnLater = null, rev = null, nw = null, revKey = null, learnNowDue = 0, learnLaterDue = 0;
    for (const c of App.cards) {
        if (!set.has(c.deckId) || !isActive(c)) continue;
        if (c.state === 'learning' || c.state === 'relearning') {
            const d = Date.parse(c.due);
            if (d <= now) { if (!learnNow || d < learnNowDue) { learnNow = c; learnNowDue = d; } }
            else if (d <= la) { if (!learnLater || d < learnLaterDue) { learnLater = c; learnLaterDue = d; } }
        } else if (c.state === 'review') {
            const d = Date.parse(c.due);
            if (d < eod) {
                const key = [Math.floor(d / 86400000), hashStr(c.id + salt)];
                if (!revKey || key[0] < revKey[0] || (key[0] === revKey[0] && key[1] < revKey[1])) { rev = c; revKey = key; }
            }
        } else if (c.state === 'new') { if (!nw || c.seq < nw.seq) nw = c; }
    }
    if (learnNow) return { card: learnNow, type: 'learn' };
    if (rev && st.due > 0) return { card: rev, type: 'review' };
    if (nw && st.new > 0) return { card: nw, type: 'new' };
    if (learnLater) return { card: learnLater, type: 'learn' };
    return null;
}

// ================================================================
//  RICH TEXT: cloze, bold, images, LaTeX (all escaped → safe)
// ================================================================
const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');

function renderRich(text, opt = {}) {
    let t = String(text || ''); const stash = [];
    const put = (h) => { stash.push(h); return '\u0001' + (stash.length - 1) + '\u0002'; };
    const math = (x, d) => put(`<span class="math" ${d ? 'data-d="1" ' : ''}data-tex="${esc(x)}">${esc(x)}</span>`);
    t = t.replace(/\$\$([\s\S]+?)\$\$/g, (m, x) => math(x, 1))
         .replace(/\\\[([\s\S]+?)\\\]/g, (m, x) => math(x, 1))
         .replace(/\\\(([\s\S]+?)\\\)/g, (m, x) => math(x, 0));
    t = t.replace(/\[img:([\w-]+)\]/g, (m, id) => put(`<img class="card-img" data-img="${id}" alt="image">`));
    if (opt.cloze !== undefined) {
        t = t.replace(/\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g, (m, n, ans, hint) => {
            if (opt.cloze === 'all' || +n !== opt.cloze) return put(inline(ans));
            return opt.reveal ? put(`<span class="cloze reveal">${inline(ans)}</span>`)
                              : put(`<span class="cloze">[${hint ? esc(hint) : '…'}]</span>`);
        });
    }
    let out = inline(t);
    for (let i = 0; i < 6 && /\u0001\d+\u0002/.test(out); i++) out = out.replace(/\u0001(\d+)\u0002/g, (m, k) => stash[k]);
    return out;
}
const plainText = (s) => String(s || '').replace(/\[img:[\w-]+\]/g, '🖼').replace(/\{\{c\d+::([\s\S]*?)(?:::[\s\S]*?)?\}\}/g, '$1').replace(/\s+/g, ' ').trim();

function faces(card) {
    if (isCloze(card)) {
        const o = card.clozeOrd || clozeOrds(card.front)[0];
        return { q: renderRich(card.front, { cloze: o, reveal: false }), qRev: renderRich(card.front, { cloze: o, reveal: true }), a: card.back ? renderRich(card.back) : '' };
    }
    const q = renderRich(card.front);
    return { q, qRev: q, a: renderRich(card.back) };
}

// ---------- images (stored in the existing "settings" store, so no DB upgrade is needed) ----------
async function getImage(id) {
    if (App.imgCache.has(id)) return App.imgCache.get(id);
    const r = await App.storage.get('settings', 'img_' + id);
    const d = r ? r.data : null; App.imgCache.set(id, d); return d;
}
function compressImage(file) {
    return new Promise((ok, bad) => {
        const url = URL.createObjectURL(file), im = new Image();
        im.onload = () => {
            const k = Math.min(1, 1000 / Math.max(im.width, im.height));
            const w = Math.round(im.width * k), h = Math.round(im.height * k);
            const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
            const cx = cv.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, w, h); cx.drawImage(im, 0, 0, w, h);
            URL.revokeObjectURL(url); ok(cv.toDataURL('image/jpeg', 0.82));
        };
        im.onerror = () => { URL.revokeObjectURL(url); bad(new Error('Could not read that image.')); };
        im.src = url;
    });
}
async function saveImage(file) {
    const data = await compressImage(file), id = generateId();
    await App.storage.put('settings', { key: 'img_' + id, data, createdAt: nowISO() });
    App.imgCache.set(id, data); return id;
}
function ensureKatex() {
    if (window.katex) return Promise.resolve(window.katex);
    if (App.katexP) return App.katexP;
    App.katexP = new Promise((ok, bad) => {
        const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.css'; document.head.appendChild(l);
        const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.js';
        s.onload = () => ok(window.katex); s.onerror = () => { App.katexP = null; bad(); }; document.head.appendChild(s);
    });
    return App.katexP;
}
function hydrate(root) {
    if (!root) return;
    root.querySelectorAll('img[data-img]:not([src])').forEach((im) => getImage(im.dataset.img).then((d) => { if (d) im.src = d; else im.alt = '[image missing]'; }));
    const m = root.querySelectorAll('.math');
    if (m.length) ensureKatex().then((k) => m.forEach((el) => { try { el.innerHTML = k.renderToString(el.dataset.tex, { displayMode: el.dataset.d === '1', throwOnError: false }); } catch (e) { /* keep raw */ } })).catch(() => {});
}

// ================================================================
//  REVIEW SESSION
// ================================================================
function saveSettings() { return App.storage.put('settings', { key: 'app_settings', ...App.settings }); }
function addStudyTime(sec) {
    const L = App.settings.studyLog || (App.settings.studyLog = {}), k = dayKey();
    L[k] = (L[k] || 0) + sec; saveSettings();
}

function startReview(deckId, cram = null) {
    const deck = getDeck(deckId); if (!deck) return;
    App.session = { deckId, deckSet: new Set(descendants(deckId)), cram, done: 0, queue: cram ? cram.ids.slice() : [] };
    App.undo = [];
    if (!cram && !getNext()) { App.session = null; toast('Nothing is due in this deck right now.', 'info'); return; }
    closeAllSheets();
    $('reviewOverlay').classList.add('active'); document.body.classList.add('modal-open');
    nextCard();
}
function nextCard() {
    const s = App.session; if (!s) return;
    let nx;
    if (s.cram) {
        while (s.queue.length && !App.cardMap.get(s.queue[0])) s.queue.shift();
        nx = s.queue.length ? { card: App.cardMap.get(s.queue[0]), type: 'cram' } : null;
    } else nx = getNext();
    updateReviewHeader(nx && nx.type);
    if (!nx) { showFinished(); return; }
    App.cur = { card: nx.card, type: nx.type, shownAt: Date.now(), answered: false };
    displayQuestion();
}
function displayQuestion() {
    const { card } = App.cur, f = faces(card);
    $('rvFinish').classList.add('hidden'); $('rvCard').classList.remove('hidden');
    $('rvQ').innerHTML = f.q;
    $('rvA').innerHTML = ''; $('rvA').classList.add('hidden'); $('rvDiv').classList.add('hidden');
    $('rvFlag').className = 'rv-flag' + (card.flag ? ' on f' + card.flag : '');
    $('rvShow').classList.remove('hidden'); $('rvRates').classList.add('hidden');
    $('rvDone').textContent = App.session.done + ' reviewed this session';
    const el = $('rvCard'); el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter');
    hydrate($('rvQ')); $('rvBody').scrollTop = 0; updateUndoBtn();
}
function showAnswer() {
    const cur = App.cur; if (!cur || cur.answered) return;
    cur.answered = true;
    const f = faces(cur.card);
    if (f.qRev !== f.q) $('rvQ').innerHTML = f.qRev;
    if (f.a) {
        $('rvA').innerHTML = f.a; $('rvA').classList.remove('hidden'); $('rvDiv').classList.remove('hidden');
        [$('rvA'), $('rvDiv')].forEach((e) => { e.classList.remove('reveal'); void e.offsetWidth; e.classList.add('reveal'); });
    }
    const labels = App.session.cram ? ['soon', 'later', 'done', 'done'] : previewLabels(cur.card);
    document.querySelectorAll('[data-iv]').forEach((e) => { e.textContent = labels[+e.dataset.iv]; });
    $('rvShow').classList.add('hidden'); $('rvRates').classList.remove('hidden');
    hydrate($('rvQ')); hydrate($('rvA'));
}
function refreshReviewCard() {
    if (!App.session || !App.cur) return;
    const was = App.cur.answered; App.cur.answered = false; displayQuestion(); if (was) showAnswer();
}

async function rate(r) {
    const cur = App.cur, s = App.session;
    if (!cur || !cur.answered || App.busy || !s) return;
    App.busy = true;
    try {
        const card = cur.card, before = clone(card), u = { before, hist: null, cram: !!s.cram };
        const h = {
            cardId: card.id, timestamp: nowISO(), rating: ['Again', 'Hard', 'Good', 'Easy'][r], ratingValue: r,
            oldState: before.state, newState: before.state, ivlBefore: before.interval || 0, ivlAfter: before.interval || 0,
            timeMs: Math.min(60000, Date.now() - cur.shownAt),
        };
        if (s.cram) {
            u.queue = s.queue.slice(); s.queue.shift();
            if (r === 0) s.queue.splice(Math.min(s.queue.length, 4), 0, card.id);
            else if (r === 1) s.queue.splice(Math.min(s.queue.length, 12), 0, card.id);
            h.cram = true;
        } else {
            const res = calc(card, r);
            Object.assign(card, { state: res.state, interval: res.interval, ease: res.ease, reps: res.reps, lapses: res.lapses, step: res.step, due: res.due.toISOString(), lastReview: nowISO() });
            if (res.leech) { card.suspended = true; if (!card.tags.includes('leech')) card.tags.push('leech'); toast(`Leech: suspended after ${card.lapses} lapses.`, 'info'); }
            h.newState = card.state; h.ivlAfter = card.interval;
            await saveCards([card]);
        }
        h.id = await App.storage.put('history', h);
        App.history.push(h); App.histVer++; u.hist = h.id;
        App.undo.push(u); if (App.undo.length > 100) App.undo.shift();
        s.done++; addStudyTime(h.timeMs / 1000);
    } catch (e) { toast('Could not save that answer: ' + (e && e.message || e), 'error'); }
    finally { App.busy = false; }
    nextCard();
}

async function undoLast() {
    if (App.busy || !App.session) return;
    const u = App.undo.pop();
    if (!u) { toast('Nothing to undo.', 'info'); return; }
    App.busy = true;
    try {
        if (u.hist != null) {
            await App.storage.delete('history', u.hist);
            const i = App.history.findIndex((x) => x.id === u.hist); if (i >= 0) App.history.splice(i, 1);
            App.histVer++; App.session.done = Math.max(0, App.session.done - 1);
        }
        if (u.queue) App.session.queue = u.queue;
        replaceCard(u.before);
        if (!u.cram) await App.storage.put('cards', u.before);
    } finally { App.busy = false; }
    const st = u.before.state;
    const type = App.session.cram ? 'cram' : st === 'new' ? 'new' : st === 'review' ? 'review' : 'learn';
    App.cur = { card: u.before, type, shownAt: Date.now(), answered: false };
    updateReviewHeader(type); displayQuestion();
    toast('Undone.', 'info');
}
function updateUndoBtn() { const b = $('rvUndo'); if (b) b.disabled = !App.undo.length; }

function updateReviewHeader(type) {
    const s = App.session; if (!s) return;
    const d = getDeck(s.deckId);
    $('rvDeck').textContent = localName(d ? d.name : '') + (s.cram ? ' · custom' : '');
    ['rvNew', 'rvLearn', 'rvDue'].forEach((i) => $(i).classList.remove('cur'));
    if (s.cram) { $('rvNew').textContent = ''; $('rvLearn').textContent = ''; $('rvDue').textContent = s.queue.length; $('rvDue').classList.add('cur'); }
    else {
        const st = deckStats().get(s.deckId) || { new: 0, learn: 0, due: 0 };
        $('rvNew').textContent = st.new; $('rvLearn').textContent = st.learn; $('rvDue').textContent = st.due;
        if (type === 'new') $('rvNew').classList.add('cur'); else if (type === 'learn') $('rvLearn').classList.add('cur'); else if (type === 'review') $('rvDue').classList.add('cur');
    }
    updateUndoBtn();
}
function showFinished() {
    App.cur = null; const s = App.session;
    $('rvCard').classList.add('hidden'); $('rvShow').classList.add('hidden'); $('rvRates').classList.add('hidden');
    $('rvDone').textContent = s.done + ' reviewed this session';
    let extra = '';
    if (!s.cram) {
        const eod = nextDayStart().getTime(), eod2 = eod + 86400000;
        const tomorrow = App.cards.filter((c) => s.deckSet.has(c.deckId) && isActive(c) && c.state === 'review' && Date.parse(c.due) >= eod && Date.parse(c.due) < eod2).length;
        const learn = App.cards.filter((c) => s.deckSet.has(c.deckId) && isActive(c) && (c.state === 'learning' || c.state === 'relearning')).map((c) => Date.parse(c.due)).sort((a, b) => a - b)[0];
        extra = `<p>${tomorrow} card${tomorrow === 1 ? '' : 's'} due tomorrow.` + (learn ? ` Next learning card in ${fmtMins(Math.max(0, (learn - Date.now()) / 60000))}.` : '') + '</p>';
    }
    $('rvFinish').innerHTML = `<div class="tick"><i class="fas fa-circle-check"></i></div><h2>Congratulations!</h2>
        <p>You have finished ${s.cram ? 'this practice round' : 'this deck for now'}.</p>${extra}
        <button class="btn-primary" data-fin="exit">Back to decks</button>
        <button class="btn-secondary" data-fin="cram"><i class="fas fa-bolt"></i> Custom study</button>`;
    $('rvFinish').classList.remove('hidden');
}
function exitReview() {
    $('reviewOverlay').classList.remove('active'); $('rvMenu').classList.add('hidden');
    document.body.classList.remove('modal-open');
    App.session = null; App.cur = null; renderAll();
}
function pushUndo(before, extra = {}) { App.undo.push({ before, hist: null, cram: !!(App.session && App.session.cram), ...extra }); updateUndoBtn(); }
async function reviewMenu(act) {
    const cur = App.cur; $('rvMenu').classList.add('hidden');
    if (!cur) return;
    const card = cur.card;
    if (act === 'edit') { openCardModal({ card }); return; }
    const before = clone(card);
    if (act.startsWith('flag')) { card.flag = +act.slice(4); await saveCards([card]); pushUndo(before); $('rvFlag').className = 'rv-flag' + (card.flag ? ' on f' + card.flag : ''); return; }
    if (act === 'suspend') { card.suspended = true; await saveCards([card]); pushUndo(before); toast('Card suspended.', 'info'); nextCard(); }
    else if (act === 'bury') { card.buried = true; card.buriedDay = dayKey(); await saveCards([card]); pushUndo(before); toast('Buried until tomorrow.', 'info'); nextCard(); }
    else if (act === 'delete') {
        if (!confirm('Delete this card permanently?')) return;
        pushUndo(before, { deleted: true }); await removeCards([card]); toast('Card deleted. Tap undo to restore it.', 'info'); nextCard();
    }
}

// ================================================================
//  CUSTOM STUDY (cram) — never touches the real schedule
// ================================================================
function buildCram(deckId, mode, o) {
    const set = new Set(descendants(deckId)); const now = Date.now();
    let list = App.cards.filter((c) => set.has(c.deckId) && !c.suspended);
    if (mode === 'weak') list = list.filter((c) => c.lapses >= 1 || (c.state === 'review' && c.ease < 2.3));
    else if (mode === 'forgot') {
        const since = now - o.days * 86400000;
        const ids = new Set(App.history.filter((h) => h.ratingValue === 0 && Date.parse(h.timestamp) >= since).map((h) => h.cardId));
        list = list.filter((c) => ids.has(c.id));
    } else if (mode === 'ahead') {
        const lim = nextDayStart().getTime() + (o.days - 1) * 86400000;
        list = list.filter((c) => c.state === 'review' && Date.parse(c.due) < lim);
    } else if (mode === 'unseen') list = list.filter((c) => c.state === 'new');
    else if (mode === 'tag') { const t = (o.tag || '').toLowerCase(); list = list.filter((c) => c.tags.some((x) => x.toLowerCase() === t)); }
    for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
    return list.slice(0, o.max).map((c) => c.id);
}

// ================================================================
//  BACKUP / RESTORE / IMPORT / EXPORT
// ================================================================
function download(text, name, type) {
    const u = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' }));
    const a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(u); }, 1500);
}
async function makeBackup() {
    const settings = await App.storage.getAll('settings');
    download(JSON.stringify({ app: 'FlashCoach', version: 2, exportedAt: nowISO(), decks: App.decks, cards: App.cards, history: App.history, settings }),
        `flashcoach-backup-${ymd(new Date())}.json`, 'application/json');
    App.settings.lastBackup = nowISO(); await saveSettings();
    renderBackupBanner(); if (App.tab === 'settings') renderSettings();
    toast('Backup downloaded. Keep the file somewhere safe (e.g. Google Drive).', 'success');
}
async function restoreBackup(file) {
    let data;
    try { data = JSON.parse(await file.text()); } catch (e) { toast('That file is not a valid backup.', 'error'); return; }
    if (!data || !Array.isArray(data.cards) || !Array.isArray(data.decks)) { toast('That file is not a FlashCoach backup.', 'error'); return; }
    const mode = await ask({ title: 'Restore backup', note: `Backup contains ${data.decks.length} decks and ${data.cards.length} cards.`, options: [['merge', 'Merge: keep my current data, add the backup'], ['replace', 'Replace everything with the backup']], value: 'merge' });
    if (!mode) return;
    if (mode === 'replace' && !confirm('This erases ALL current cards, decks and history and replaces them with the backup. Continue?')) return;
    const st = App.storage;
    if (mode === 'replace') { for (const s of ['cards', 'decks', 'history', 'settings']) await st.clear(s); }
    await st.putMany('decks', data.decks); await st.putMany('cards', data.cards);
    if (Array.isArray(data.history)) {
        let hist = data.history;
        if (mode === 'merge') { const have = new Set(App.history.map((h) => h.id)); hist = hist.filter((h) => !have.has(h.id)); }
        await st.putMany('history', hist);
    }
    if (Array.isArray(data.settings)) {
        const recs = data.settings.filter((r) => mode === 'replace' || r.key !== 'app_settings');
        await st.putMany('settings', recs);
        if (mode === 'merge') {
            const b = data.settings.find((r) => r.key === 'app_settings');
            if (b && b.studyLog) { App.settings.studyLog = { ...b.studyLog, ...App.settings.studyLog }; await saveSettings(); }
        }
    }
    App.imgCache.clear(); await loadAll(); renderAll(); toast('Backup restored.', 'success');
}

function parseDelimited(text, delim) {
    const rows = []; let row = [], f = '', inQ = false, i = 0; const n = text.length;
    while (i < n) {
        const ch = text[i];
        if (inQ) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i += 2; continue; } inQ = false; i++; continue; } f += ch; i++; continue; }
        if (ch === '"' && f === '') { inQ = true; i++; continue; }
        if (text.startsWith(delim, i)) { row.push(f); f = ''; i += delim.length; continue; }
        if (ch === '\r') { i++; continue; }
        if (ch === '\n') { row.push(f); rows.push(row); row = []; f = ''; i++; continue; }
        f += ch; i++;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows.filter((r) => r.some((x) => x.trim() !== '') && !/^#(separator|html|tags column|deck column|notetype|guid column|columns)/i.test(r[0] || ''));
}
const cleanField = (s) => String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p|li)>/gi, '\n')
    .replace(/<\/?(b|i|u|div|span|p|font|strong|em|sub|sup|ul|ol|li)\b[^>]*>/gi, '').replace(/&nbsp;/g, ' ').trim();
const csvField = (s, sep) => (s.includes(sep) || s.includes('"') || s.includes('\n')) ? '"' + s.replace(/"/g, '""') + '"' : s;
function exportDeck(deckId, sep) {
    const deck = getDeck(deckId), set = new Set(descendants(deckId)), seen = new Set(), lines = [];
    for (const c of App.cards) {
        if (!set.has(c.deckId)) continue;
        if (isCloze(c) && c.noteId) { if (seen.has(c.noteId)) continue; seen.add(c.noteId); }
        lines.push([c.front, c.back, (c.tags || []).join(',')].map((x) => csvField(x || '', sep)).join(sep));
    }
    if (!lines.length) { toast('This deck has no cards to export.', 'info'); return; }
    download(lines.join('\n'), `${deck.name.replace(/::/g, '_')}.txt`, 'text/plain');
    toast(`Exported ${lines.length} cards.`, 'success');
}

// ================================================================
//  UI HELPERS
// ================================================================
function toast(msg, type = 'info', action) {
    const c = $('toastContainer'); if (!c) return;
    const t = document.createElement('div'); t.className = 'toast ' + type;
    const ic = type === 'success' ? 'fa-circle-check' : type === 'error' ? 'fa-circle-exclamation' : 'fa-circle-info';
    t.innerHTML = `<i class="fas ${ic}"></i><span>${esc(msg)}</span>`;
    if (action) { const b = document.createElement('button'); b.textContent = action.label; b.onclick = () => { action.fn(); t.remove(); }; t.appendChild(b); }
    c.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, action ? 7000 : 3000);
}
function anyModalOpen() { return !!document.querySelector('.modal-overlay:not(.hidden)'); }
function openModal(id) { $(id).classList.remove('hidden'); document.body.classList.add('modal-open'); }
function closeModal(id) {
    $(id).classList.add('hidden');
    if (!anyModalOpen() && !$('reviewOverlay').classList.contains('active')) document.body.classList.remove('modal-open');
}
function closeAllSheets() { ['deckSheet', 'cardSheet'].forEach((i) => closeModal(i)); }

function ask({ title, note = '', value = '', options = null, placeholder = '' }) {
    return new Promise((res) => {
        $('askTitle').textContent = title;
        const n = $('askNote'); n.textContent = note; n.classList.toggle('hidden', !note);
        const inp = $('askInput'), sel = $('askSelect');
        if (options) {
            sel.innerHTML = options.map(([v, l]) => `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(l)}</option>`).join('');
            sel.classList.remove('hidden'); inp.classList.add('hidden');
        } else { inp.value = value; inp.placeholder = placeholder; inp.classList.remove('hidden'); sel.classList.add('hidden'); }
        openModal('askModal');
        setTimeout(() => { if (options) sel.focus(); else { inp.focus(); inp.select(); } }, 60);
        const done = (v) => { closeModal('askModal'); App.askCancel = null; res(v); };
        $('askOk').onclick = () => done(options ? sel.value : inp.value.trim());
        $('askCancel').onclick = () => done(null);
        inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); done(inp.value.trim()); } };
        App.askCancel = () => done(null);
    });
}

function switchTab(t) {
    App.tab = t;
    document.querySelectorAll('.tab').forEach((e) => e.classList.toggle('active', e.id === 'tab-' + t));
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
    if (t === 'browse') { populateBrowseDecks(); renderBrowse(); }
    if (t === 'stats') renderStats();
    if (t === 'settings') renderSettings();
    if (t === 'import') { refreshImportDecks(); refreshImportUI(); }
    window.scrollTo(0, 0);
}

function renderAll() {
    renderDecks(); renderTopbar(); renderBackupBanner();
    if (App.tab === 'browse') renderBrowse();
    if (App.tab === 'stats') renderStats();
    if (App.tab === 'settings') renderSettings();
}

function renderTopbar() {
    const S = App.settings, chip = $('quizChip');
    document.querySelector('#themeBtn i').className = 'fas ' + (S.theme === 'dark' ? 'fa-sun' : 'fa-moon');
    if (S.quizDate) {
        const d = Math.ceil((Date.parse(S.quizDate + 'T23:59:59') - Date.now()) / 86400000);
        if (d >= 0) { chip.textContent = `${S.quizName || 'Quiz'} · ${d}d`; chip.classList.remove('hidden'); return; }
    }
    chip.classList.add('hidden');
}
function renderBackupBanner() {
    const b = $('backupBanner');
    if (App.storage.memory) { b.className = 'banner warn'; b.innerHTML = '<i class="fas fa-triangle-exclamation"></i><span>This browser mode cannot store data. Progress will be lost when you close the page.</span>'; return; }
    const last = App.settings.lastBackup;
    const days = last ? Math.floor((Date.now() - Date.parse(last)) / 86400000) : null;
    if (!App.cards.length || (last && days < 7)) { b.classList.add('hidden'); return; }
    b.className = 'banner';
    b.innerHTML = `<i class="fas fa-shield-halved"></i><span>${last ? `Last backup was ${days} days ago.` : 'You have not backed up yet.'} Save a copy so your progress is never lost.</span><button class="btn-primary sm" data-act="backup">Back up</button>`;
}

// ================================================================
//  DECK LIST & DECK SHEET
// ================================================================
function renderDecks() {
    const stats = deckStats();
    $('emptyDecks').classList.toggle('hidden', App.decks.length > 0);
    document.querySelector('.deck-table').classList.toggle('hidden', !App.decks.length);
    const key = (d) => d.name.toLowerCase().split('::').join('\u0000');
    const sorted = [...App.decks].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    const cell = (v, cls) => `<span class="n ${cls}${v ? '' : ' zero'}">${v}</span>`;
    $('deckList').innerHTML = sorted.filter((d) => !hiddenByCollapse(d)).map((d) => {
        const s = stats.get(d.id), depth = (d.name.match(/::/g) || []).length, kids = hasChildren(d);
        return `<div class="deck-row" data-id="${d.id}"><div class="deck-name-cell" style="--depth:${depth}">
            <button class="chev${kids ? '' : ' ph'}" data-toggle="${d.id}" aria-label="Expand or collapse"><i class="fas fa-chevron-${d.collapsed ? 'right' : 'down'}"></i></button>
            <div class="deck-title"><b>${esc(localName(d.name))}</b><small>${s.total} card${s.total === 1 ? '' : 's'}</small></div></div>
            ${cell(s.new, 'c-new')}${cell(s.learn, 'c-learn')}${cell(s.due, 'c-due')}</div>`;
    }).join('');
}
async function toggleCollapse(id) {
    const d = getDeck(id); if (!d) return;
    d.collapsed = !d.collapsed; d.modifiedAt = nowISO();
    await App.storage.putMany('decks', [d]); renderDecks();
}
function openDeckSheet(id) {
    const d = getDeck(id); if (!d) return;
    App.sheetDeckId = id; $('dsName').textContent = localName(d.name);
    refreshDeckSheet(); openModal('deckSheet');
}
function refreshDeckSheet() {
    const s = deckStats().get(App.sheetDeckId) || { new: 0, learn: 0, due: 0, total: 0 };
    $('dsNew').textContent = s.new; $('dsLearn').textContent = s.learn; $('dsDue').textContent = s.due;
    const none = !s.new && !s.learn && !s.due;
    $('dsMsg').textContent = s.total === 0 ? 'This deck has no cards yet.' : none ? 'Congratulations! Nothing is due right now.' : '';
    $('dsStudy').disabled = none;
}
async function deckAction(act) {
    const id = App.sheetDeckId, d = getDeck(id); if (!d) return;
    if (act === 'add') { closeModal('deckSheet'); openCardModal({ deckId: id }); }
    else if (act === 'browse') { closeModal('deckSheet'); App.B.deck = id; App.B.q = ''; $('bSearch').value = ''; switchTab('browse'); }
    else if (act === 'cram') { App.cramDeckId = id; closeModal('deckSheet'); openModal('cramModal'); }
    else if (act === 'import') { closeModal('deckSheet'); switchTab('import'); $('impDeck').value = id; }
    else if (act === 'sub') {
        const n = await ask({ title: 'New subdeck', note: `Inside “${d.name}”`, placeholder: 'Subdeck name' });
        if (n) { await createDeck(d.name + '::' + n); toast('Subdeck created.', 'success'); renderAll(); refreshDeckSheet(); }
    } else if (act === 'rename') {
        const n = await ask({ title: 'Rename or move deck', note: 'Use :: to nest, e.g. Medicine::Cardiology', value: d.name });
        if (n && await renameDeck(id, n)) { $('dsName').textContent = localName(getDeck(id).name); toast('Deck renamed.', 'success'); renderAll(); }
    } else if (act === 'export') {
        const sep = await ask({ title: 'Export deck', note: 'Choose the field separator for the file.', options: [[';', 'Semicolon ( ; )'], [',', 'Comma ( , )'], ['\t', 'Tab']], value: ';' });
        if (sep) exportDeck(id, sep);
    } else if (act === 'delete') {
        const ids = new Set(descendants(id)), n = App.cards.filter((c) => ids.has(c.deckId)).length;
        if (!confirm(`Delete “${d.name}”${ids.size > 1 ? ' and its subdecks' : ''} with ${n} card${n === 1 ? '' : 's'}?`)) return;
        App.lastDeleted = await deleteDeck(id);
        closeModal('deckSheet'); renderAll();
        toast(`Deck deleted (${n} cards).`, 'info', { label: 'Undo', fn: restoreDeleted });
    }
}
async function restoreDeleted() {
    const d = App.lastDeleted; if (!d) return;
    const decks = d.decks.filter((x) => !getDeck(x.id)); App.decks.push(...decks);
    await App.storage.putMany('decks', decks);
    await addCards(d.cards.filter((c) => !App.cardMap.has(c.id)));
    App.lastDeleted = null; renderAll(); toast('Restored.', 'success');
}

// ================================================================
//  CARD ADD / EDIT MODAL
// ================================================================
const splitTags = (s) => String(s || '').split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
async function openCardModal({ card = null, deckId = null } = {}) {
    if (!App.decks.length) await createDeck('Default');
    App.editing = card ? card.id : null;
    $('cmTitle').textContent = card ? 'Edit card' : 'Add card';
    $('cmDeck').innerHTML = deckOptionsHtml(card ? card.deckId : (deckId || (getDeck(App.settings.lastDeckId) ? App.settings.lastDeckId : App.decks[0].id)));
    $('cmFront').value = card ? card.front : ''; $('cmBack').value = card ? card.back : '';
    $('cmTags').value = card ? (card.tags || []).join(', ') : '';
    $('cmReverse').checked = false;
    ['cmReverseRow', 'cmSaveNew'].forEach((i) => $(i).classList.toggle('hidden', !!card));
    $('cmDelete').classList.toggle('hidden', !card);
    $('cmSave').textContent = card ? 'Save' : 'Add';
    openModal('cardModal'); setTimeout(() => $('cmFront').focus(), 60);
}
async function saveCardModal(another) {
    const front = $('cmFront').value.trim(), back = $('cmBack').value.trim(), deckId = $('cmDeck').value, tags = splitTags($('cmTags').value);
    const cloze = /\{\{c\d+::/.test(front);
    if (!front) { toast('Enter the front of the card.', 'error'); return; }
    if (!back && !cloze) { toast('Enter the back of the card.', 'error'); return; }
    if (!deckId) { toast('Pick a deck.', 'error'); return; }
    try {
        if (App.editing) {
            const card = App.cardMap.get(App.editing); if (!card) return;
            const targets = (isCloze(card) && card.noteId) ? App.cards.filter((c) => c.noteId === card.noteId && isCloze(c)) : [card];
            targets.forEach((c) => { c.front = front; c.back = back; c.tags = [...tags]; c.deckId = deckId; });
            let extra = [];
            if (cloze) {
                if (!card.noteId) card.noteId = generateId();
                if (!card.clozeOrd) card.clozeOrd = clozeOrds(front)[0];
                const have = new Set(targets.map((c) => c.clozeOrd));
                extra = buildCards({ deckId, front, back, tags }).filter((c) => !have.has(c.clozeOrd));
                extra.forEach((c) => { c.noteId = card.noteId; });
            }
            await saveCards(targets); await addCards(extra);
            toast('Card saved.', 'success'); closeModal('cardModal'); refreshReviewCard();
            if (App.sheetCardId === card.id) openCardSheet(card.id);
        } else {
            const list = buildCards({ deckId, front, back, tags, reverse: $('cmReverse').checked });
            await addCards(list);
            App.settings.lastDeckId = deckId; saveSettings();
            toast(list.length > 1 ? `Added ${list.length} cards.` : 'Card added.', 'success');
            if (another) { $('cmFront').value = ''; $('cmBack').value = ''; $('cmFront').focus(); } else closeModal('cardModal');
        }
    } catch (e) { toast('Could not save: ' + (e && e.message || e), 'error'); return; }
    renderAll();
}
function toolbarAction(id, act) {
    const ta = $(id), s = ta.selectionStart, e = ta.selectionEnd, sel = ta.value.slice(s, e);
    if (act === 'image') { App.imgTarget = id; $('imageFile').value = ''; $('imageFile').click(); return; }
    let pre, post;
    if (act === 'bold') { pre = '**'; post = '**'; }
    else if (act === 'cloze') { pre = `{{c${Math.max(0, ...clozeOrds(ta.value)) + 1}::`; post = '}}'; }
    else { pre = '\\('; post = '\\)'; }
    ta.setRangeText(pre + sel + post, s, e, 'end'); ta.focus();
    ta.setSelectionRange(s + pre.length, s + pre.length + sel.length);
}
async function insertImageFile(targetId, file) {
    try {
        toast('Adding image…', 'info');
        const id = await saveImage(file), ta = $(targetId);
        ta.setRangeText(`[img:${id}]`, ta.selectionStart, ta.selectionEnd, 'end'); ta.focus();
    } catch (e) { toast(e.message || 'Could not add image.', 'error'); }
}

// ================================================================
//  BROWSE (Anki-style search)
// ================================================================
function populateBrowseDecks() { $('bDeck').innerHTML = deckOptionsHtml(App.B.deck, true); $('bDeck').value = App.B.deck; $('bSearch').value = App.B.q; $('bClear').classList.toggle('hidden', !App.B.q); }
function parseSearch(q) {
    const toks = [], re = /(-?)(?:(\w+):)?(?:"([^"]*)"|(\S+))/g; let m;
    while ((m = re.exec(q))) toks.push({ neg: !!m[1], key: m[2] ? m[2].toLowerCase() : null, val: m[3] !== undefined ? m[3] : m[4] });
    return toks;
}
const haystack = (c) => (plainText(c.front) + ' ' + plainText(c.back) + ' ' + (c.tags || []).join(' ')).toLowerCase();
function matcher(tok) {
    const v = (tok.val || '').toLowerCase(), K = tok.key; let fn;
    const eod = nextDayStart().getTime();
    if (K === 'deck') fn = (c) => { const d = getDeck(c.deckId), n = d ? d.name.toLowerCase() : ''; return n === v || n.startsWith(v + '::') || n.includes(v); };
    else if (K === 'tag') fn = (c) => (c.tags || []).some((t) => { t = t.toLowerCase(); return t === v || t.startsWith(v + '::') || t.includes(v); });
    else if (K === 'is') {
        const map = {
            new: (c) => c.state === 'new', learn: (c) => c.state === 'learning' || c.state === 'relearning', review: (c) => c.state === 'review',
            due: (c) => (c.state === 'review' && Date.parse(c.due) < eod) || ((c.state === 'learning' || c.state === 'relearning') && Date.parse(c.due) <= Date.now()),
            suspended: (c) => !!c.suspended, buried: (c) => !!c.buried, leech: (c) => (c.tags || []).includes('leech'), flagged: (c) => c.flag > 0,
            young: (c) => c.state === 'review' && c.interval < 21, mature: (c) => c.state === 'review' && c.interval >= 21,
        };
        fn = map[v] || (() => false);
    } else if (K === 'flag') fn = (c) => String(c.flag || 0) === v;
    else if (K === 'added') { const cut = dayStart().getTime() - (Math.max(1, +v || 1) - 1) * 86400000; fn = (c) => Date.parse(c.createdAt) >= cut; }
    else if (K === 'rated') {
        const cut = dayStart().getTime() - (Math.max(1, +v || 1) - 1) * 86400000;
        const ids = new Set(App.history.filter((h) => Date.parse(h.timestamp) >= cut).map((h) => h.cardId)); fn = (c) => ids.has(c.id);
    } else if (K === 'prop') {
        const m = /^(ivl|ease|lapses|reps)(<=|>=|=|<|>)(\d+\.?\d*)$/.exec(v);
        if (m) {
            const f = { ivl: 'interval', ease: 'ease', lapses: 'lapses', reps: 'reps' }[m[1]], n = +m[3];
            const op = { '<': (a) => a < n, '>': (a) => a > n, '<=': (a) => a <= n, '>=': (a) => a >= n, '=': (a) => a === n }[m[2]];
            fn = (c) => op(c[f] || 0);
        } else fn = () => false;
    } else { const t = (K ? K + ':' + (tok.val || '') : (tok.val || '')).toLowerCase(); fn = (c) => haystack(c).includes(t); }
    return tok.neg ? (c) => !fn(c) : fn;
}
function dueDelta(c) { return Math.round((Date.parse(c.due) - dayStart().getTime()) / 86400000); }
function filteredCards() {
    const B = App.B, fns = parseSearch(B.q.trim()).map(matcher), set = B.deck ? new Set(descendants(B.deck)) : null;
    const list = App.cards.filter((c) => (!set || set.has(c.deckId)) && fns.every((f) => f(c)));
    const val = {
        created: (c) => c.seq || 0, modified: (c) => Date.parse(c.modifiedAt) || 0,
        due: (c) => (c.state === 'new' ? Infinity : Date.parse(c.due)), interval: (c) => c.interval || 0, ease: (c) => c.ease || 0,
        lapses: (c) => c.lapses || 0, front: (c) => plainText(c.front).toLowerCase(),
    }[B.sort];
    list.sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * (B.desc ? -1 : 1); });
    return list;
}
function renderBrowse() {
    const B = App.B, list = filteredCards();
    $('bCount').textContent = `${list.length} card${list.length === 1 ? '' : 's'}` + (B.sel.size ? ` · ${B.sel.size} selected` : '');
    $('bSelectBtn').textContent = B.selecting ? 'Done' : 'Select';
    $('bOrder').querySelector('i').className = 'fas ' + (B.desc ? 'fa-arrow-down-wide-short' : 'fa-arrow-up-short-wide');
    const box = $('bList'); box.classList.toggle('selecting', B.selecting);
    App._bIds = list.map((c) => c.id);
    box.innerHTML = list.slice(0, B.limit).map((c) => {
        const d = getDeck(c.deckId);
        let cls = c.state, label = c.state;
        if (c.suspended) { cls = 'suspended'; label = 'suspended'; }
        else if (c.buried) label = 'buried';
        else if (c.state === 'review') { const n = dueDelta(c); label = n <= 0 ? 'due' : 'in ' + fmtDays(n); }
        else if (c.state === 'relearning') label = 'relearning';
        const meta = esc(d ? d.name : '?') + ((c.tags || []).length ? ' · ' + esc(c.tags.join(' ')) : '') + (isCloze(c) ? ' · cloze' : '');
        return `<div class="b-row${c.suspended ? ' sus' : ''}${c.flag ? ' f' + c.flag : ''}${B.sel.has(c.id) ? ' sel' : ''}" data-id="${c.id}">
            <span class="b-check"><i class="fas fa-check"></i></span>
            <div class="b-main"><div class="b-front">${esc(plainText(c.front))}</div><div class="b-back">${esc(plainText(c.back)) || '&nbsp;'}</div><div class="b-meta">${meta}</div></div>
            <span class="pill ${cls}">${esc(label)}</span></div>`;
    }).join('') || (App.cards.length ? '<div class="empty" style="padding:28px 12px"><i class="fas fa-magnifying-glass"></i><p>No cards match this search.</p></div>' : '');
    $('bList').style.display = '';
    $('bMore').classList.toggle('hidden', list.length <= B.limit);
    $('bulkBar').classList.toggle('hidden', !B.selecting);
    $('bulkCount').textContent = `${B.sel.size} selected`;
}
function openCardSheet(id) {
    const c = App.cardMap.get(id); if (!c) return;
    App.sheetCardId = id; const f = faces(c), d = getDeck(c.deckId);
    $('csFront').innerHTML = isCloze(c) ? f.qRev : f.q;
    $('csBack').innerHTML = f.a || '<span class="muted">—</span>';
    const due = c.state === 'new' ? 'New' : (c.state === 'review' ? fmtDate(c.due) : 'Learning');
    $('csInfo').innerHTML = [
        ['Deck', d ? d.name : '?'], ['State', c.suspended ? 'Suspended' : c.buried ? 'Buried' : c.state], ['Due', due],
        ['Interval', c.state === 'review' ? fmtDays(c.interval) : '—'], ['Ease', c.state === 'new' ? '—' : Math.round(c.ease * 100) + '%'],
        ['Reviews', c.reps || 0], ['Lapses', c.lapses || 0], ['Added', fmtDate(c.createdAt)],
    ].map(([k, v]) => `<span>${k}: <b>${esc(v)}</b></span>`).join('');
    $('csSuspendLbl').textContent = c.suspended ? 'Unsuspend' : 'Suspend';
    openModal('cardSheet'); hydrate($('csFront')); hydrate($('csBack'));
}
async function cardSheetAction(act) {
    const c = App.cardMap.get(App.sheetCardId); if (!c) return;
    if (act === 'edit') { closeModal('cardSheet'); openCardModal({ card: c }); return; }
    if (act === 'suspend') { c.suspended = !c.suspended; if (!c.suspended) c.buried = false; await saveCards([c]); }
    else if (act === 'flag') { c.flag = ((c.flag || 0) + 1) % 5; await saveCards([c]); }
    else if (act === 'move') {
        const to = await ask({ title: 'Move card', options: App.decks.map((d) => [d.id, d.name]).sort((a, b) => a[1].localeCompare(b[1])), value: c.deckId });
        if (!to) return; c.deckId = to; await saveCards([c]);
    } else if (act === 'forget') {
        if (!confirm('Reset this card to “new”? Its review history stays in your stats.')) return;
        Object.assign(c, { state: 'new', interval: 0, ease: App.settings.startingEase, reps: 0, lapses: 0, step: 0, due: nowISO(), suspended: false, buried: false });
        await saveCards([c]);
    } else if (act === 'delete') {
        if (!confirm('Delete this card permanently?')) return;
        await removeCards([c]); App.lastDeleted = { decks: [], cards: [c] };
        closeModal('cardSheet'); renderAll(); toast('Card deleted.', 'info', { label: 'Undo', fn: restoreDeleted }); return;
    }
    renderAll(); openCardSheet(c.id);
}
async function bulkAction(act) {
    const B = App.B, cards = [...B.sel].map((id) => App.cardMap.get(id)).filter(Boolean);
    if (act === 'cancel') { B.selecting = false; B.sel.clear(); renderBrowse(); return; }
    if (act === 'all') { B.sel = new Set(App._bIds); renderBrowse(); return; }
    if (!cards.length) { toast('Select some cards first.', 'info'); return; }
    if (act === 'move') {
        const to = await ask({ title: `Move ${cards.length} cards`, options: App.decks.map((d) => [d.id, d.name]).sort((a, b) => a[1].localeCompare(b[1])), value: cards[0].deckId });
        if (!to) return; cards.forEach((c) => { c.deckId = to; });
    } else if (act === 'tag') {
        const t = await ask({ title: 'Add tags', note: `To ${cards.length} cards`, placeholder: 'tag1, tag2' });
        if (!t) return; const tags = splitTags(t); cards.forEach((c) => { tags.forEach((x) => { if (!c.tags.includes(x)) c.tags.push(x); }); });
    } else if (act === 'suspend') cards.forEach((c) => { c.suspended = true; });
    else if (act === 'unsuspend') cards.forEach((c) => { c.suspended = false; c.buried = false; });
    else if (act === 'delete') {
        if (!confirm(`Delete ${cards.length} card${cards.length === 1 ? '' : 's'} permanently?`)) return;
        await removeCards(cards); App.lastDeleted = { decks: [], cards }; B.sel.clear(); B.selecting = false;
        renderAll(); toast(`${cards.length} cards deleted.`, 'info', { label: 'Undo', fn: restoreDeleted }); return;
    }
    await saveCards(cards); renderAll(); toast('Done.', 'success');
}

// ================================================================
//  ACTIVITY
// ================================================================
function dayCounts() {
    if (App._dcv !== App.histVer) {
        const o = {}; for (const h of App.history) { const k = dayKey(new Date(h.timestamp)); o[k] = (o[k] || 0) + 1; }
        App._dc = o; App._dcv = App.histVer;
    }
    return App._dc;
}
const dayNum = (k) => { const [y, m, d] = k.split('-'); return Date.UTC(+y, m - 1, +d) / 86400000; };
function streakOf(counts, pred) {
    let best = 0, run = 0, prev = null;
    for (const k of Object.keys(counts).sort()) {
        if (!pred(counts[k])) continue;
        run = (prev && dayNum(k) - dayNum(prev) === 1) ? run + 1 : 1; best = Math.max(best, run); prev = k;
    }
    let cur = 0; const d = new Date(dayStart());
    if (!pred(counts[ymd(d)] || 0)) d.setDate(d.getDate() - 1);
    while (pred(counts[ymd(d)] || 0)) { cur++; d.setDate(d.getDate() - 1); }
    return { cur, best };
}
const fmtStudy = (s) => { s = Math.round(s || 0); const m = Math.floor(s / 60); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : m ? `${m} min` : `${s}s`; };

function renderStats() {
    const S = App.settings, counts = dayCounts(), today = dayKey(), goal = S.dailyGoal || 20;
    const done = counts[today] || 0, pct = Math.min(100, Math.round(done / goal * 100));
    const st = streakOf(counts, (n) => n > 0), gs = streakOf(counts, (n) => n >= goal);
    const todayEntries = todayList(), againToday = todayEntries.filter((h) => h.ratingValue === 0).length;

    // heatmap
    const end = dayStart(), s0 = new Date(end); s0.setDate(s0.getDate() - 364); s0.setDate(s0.getDate() - s0.getDay());
    let cells = '', months = '', prevM = -1, col = 0; const todayK = ymd(end);
    for (const d = new Date(s0); d <= end; d.setDate(d.getDate() + 1)) {
        const k = ymd(d), n = counts[k] || 0, lvl = n >= 31 ? 4 : n >= 16 ? 3 : n >= 6 ? 2 : n >= 1 ? 1 : 0;
        if (d.getDay() === 0) { months += `<span>${d.getMonth() !== prevM ? d.toLocaleDateString(undefined, { month: 'short' }) : ''}</span>`; prevM = d.getMonth(); col++; }
        cells += `<div class="hc l${lvl}${k === todayK ? ' today' : ''}" title="${n} review${n === 1 ? '' : 's'} · ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}"></div>`;
    }

    // card states + forecast
    let nNew = 0, nLearn = 0, nYoung = 0, nMature = 0, nSusp = 0; const fc = Array(14).fill(0), t0 = dayStart().getTime();
    for (const c of App.cards) {
        if (c.suspended || c.buried) { nSusp++; continue; }
        if (c.state === 'new') nNew++;
        else if (c.state === 'learning' || c.state === 'relearning') { nLearn++; fc[0]++; }
        else { if (c.interval >= 21) nMature++; else nYoung++; const i = Math.max(0, Math.floor((Date.parse(c.due) - t0) / 86400000)); if (i < 14) fc[i]++; }
    }
    const total = App.cards.length || 1, seg = (n, c) => `<i style="width:${n / total * 100}%;background:${c}"></i>`;
    const fmax = Math.max(1, ...fc);
    const fcHtml = fc.map((n, i) => { const d = new Date(end); d.setDate(d.getDate() + i); return `<div title="${n} due"><b>${n || ''}</b><i style="height:${Math.max(2, n / fmax * 64)}px"></i><em>${i === 0 ? 'now' : d.getDate()}</em></div>`; }).join('');

    // retention (last 30 days, review cards only)
    const cut = Date.now() - 30 * 86400000;
    const rv = App.history.filter((h) => !h.cram && h.oldState === 'review' && Date.parse(h.timestamp) >= cut);
    const ret = rv.length ? Math.round(rv.filter((h) => h.ratingValue > 0).length / rv.length * 100) + '%' : '—';

    // quiz plan
    let quiz = '';
    if (S.quizDate) {
        const dl = Math.ceil((Date.parse(S.quizDate + 'T23:59:59') - Date.now()) / 86400000);
        if (dl >= 0) {
            const per = dl > 0 ? Math.ceil(nNew / dl) : nNew, week = fc.slice(1, 8).reduce((a, b) => a + b, 0);
            const seen = App.cards.length ? Math.round((App.cards.length - nNew) / App.cards.length * 100) : 0;
            quiz = `<div class="card-box quiz-box"><div class="quiz-top"><span class="big">${dl}</span><span>day${dl === 1 ? '' : 's'} until ${esc(S.quizName || 'your quiz')}</span></div>
                <div class="grid3" style="margin-top:12px">
                <div class="stat"><div class="big" style="font-size:1.25rem">${nNew}</div><div class="lbl">unseen cards</div></div>
                <div class="stat"><div class="big" style="font-size:1.25rem">${nNew ? per : 0}</div><div class="lbl">new/day to see all</div></div>
                <div class="stat"><div class="big" style="font-size:1.25rem">${seen}%</div><div class="lbl">seen so far</div></div></div>
                <div class="lbl" style="margin-top:8px">${week} reviews already scheduled for the next 7 days.${nNew && per > S.newPerDay ? ` Raise “New cards per day” in Settings to at least ${per}.` : ''}</div></div>`;
        } else quiz = `<div class="card-box"><span class="muted">${esc(S.quizName || 'Your quiz')} date has passed. Set a new date in Settings.</span></div>`;
    }

    $('statsRoot').innerHTML = `${quiz}
        <div class="card-box"><div class="box-title">Today <small>${fmtStudy((S.studyLog || {})[today])} studied</small></div>
            <div class="grid3"><div class="stat"><div class="big">${done}</div><div class="lbl">reviewed</div></div>
            <div class="stat"><div class="big">${againToday}</div><div class="lbl">pressed Again</div></div>
            <div class="stat"><div class="big">${ret}</div><div class="lbl">retention (30d)</div></div></div>
            <div class="bar" style="margin-top:12px"><i style="width:${pct}%"></i></div>
            <div class="goal-row"><span>${done >= goal ? 'Daily goal reached 🎉' : `${goal - done} to go · daily goal`}</span><span class="spacer"></span>
            <input id="goalInput" class="input" type="number" min="1" value="${goal}" inputmode="numeric" aria-label="Daily goal"></div></div>
        <div class="card-box"><div class="box-title">Streaks</div><div class="grid2">
            <div class="stat"><div class="big">🔥 ${st.cur}</div><div class="lbl">day streak · best ${st.best}</div></div>
            <div class="stat"><div class="big">🎯 ${gs.cur}</div><div class="lbl">goal streak · best ${gs.best}</div></div></div></div>
        <div class="card-box"><div class="box-title">Reviews, last year <small>${Object.keys(counts).length} active days · ${App.history.length} reviews</small></div>
            <div class="heat-scroll" id="heatScroll"><div class="heat-months" style="grid-template-columns:repeat(${col},13px)">${months}</div><div class="heat">${cells}</div></div>
            <div class="heat-legend">Less <span class="hc"></span><span class="hc l1"></span><span class="hc l2"></span><span class="hc l3"></span><span class="hc l4"></span> More</div></div>
        <div class="card-box"><div class="box-title">Your cards <small>${App.cards.length} total</small></div>
            <div class="stack">${seg(nNew, 'var(--new)')}${seg(nLearn, 'var(--learn)')}${seg(nYoung, '#86efac')}${seg(nMature, 'var(--due)')}${seg(nSusp, '#f59e0b')}</div>
            <div class="legend"><span style="--c:var(--new)">New ${nNew}</span><span style="--c:var(--learn)">Learning ${nLearn}</span><span style="--c:#86efac">Young ${nYoung}</span><span style="--c:var(--due)">Mature ${nMature}</span><span style="--c:#f59e0b">Suspended ${nSusp}</span></div></div>
        <div class="card-box"><div class="box-title">Due in the next 14 days <small>day of month</small></div><div class="forecast">${fcHtml}</div></div>`;
    const hs = $('heatScroll'); if (hs) hs.scrollLeft = hs.scrollWidth;
}

// ================================================================
//  SETTINGS
// ================================================================
const FIELDS = [
    ['Daily targets'],
    ['dailyGoal', 'Daily review goal', 'cards per day, for streaks and goal', 'int', 1],
    ['newPerDay', 'New cards per day', 'new cards introduced each day', 'int', 0],
    ['revPerDay', 'Maximum reviews per day', '', 'int', 0],
    ['Quiz countdown'],
    ['quizName', 'Quiz name', '', 'text'],
    ['quizDate', 'Quiz date', '', 'date'],
    ['Scheduling (Anki defaults)'],
    ['learningSteps', 'Learning steps', 'minutes, separated by spaces', 'steps'],
    ['relearnSteps', 'Relearning steps', 'minutes after a lapse; blank = none', 'steps0'],
    ['graduatingInterval', 'Graduating interval', 'days', 'int', 1],
    ['easyInterval', 'Easy interval', 'days', 'int', 1],
    ['startingEase', 'Starting ease', 'new cards, e.g. 2.5', 'float', 1.3],
    ['easyBonus', 'Easy bonus', 'e.g. 1.3', 'float', 1],
    ['hardInterval', 'Hard interval', 'e.g. 1.2', 'float', 1],
    ['intervalMod', 'Interval modifier', '1.0 = normal', 'float', 0.1],
    ['maxInterval', 'Maximum interval', 'days', 'int', 1],
    ['leechThreshold', 'Leech threshold', 'lapses before a card is suspended', 'int', 1],
    ['learnAheadLimit', 'Learn-ahead limit', 'minutes', 'int', 0],
];
function renderSettings() {
    const S = App.settings; let html = '', open = false;
    for (const f of FIELDS) {
        if (f.length === 1) { if (open) html += '</div>'; html += `<div class="card-box"><div class="box-title">${f[0]}</div>`; open = true; continue; }
        const [k, label, hint, type] = f; let v = S[k];
        if (type === 'steps' || type === 'steps0') v = (v || []).join(' ');
        html += `<div class="set-row"><label for="set_${k}">${label}<small>${hint}</small></label><input id="set_${k}" class="input" data-k="${k}" data-t="${type}" type="${type === 'date' ? 'date' : type === 'text' || type.startsWith('steps') ? 'text' : 'number'}" ${type === 'float' ? 'step="0.05"' : ''} value="${esc(v ?? '')}"></div>`;
    }
    html += '</div>';
    const last = S.lastBackup ? new Date(S.lastBackup).toLocaleString() : 'never';
    html += `<div class="card-box"><div class="box-title">Your data <small id="storeInfo">${App.cards.length} cards · ${App.decks.length} decks · ${App.history.length} reviews</small></div>
        <p class="muted small" style="margin:0 0 10px">Everything is stored privately in this browser. Last backup: <b>${last}</b>.</p>
        <div class="set-actions">
            <button class="btn-primary" data-act="backup"><i class="fas fa-download"></i> Download backup</button>
            <button class="btn-secondary" data-act="restore"><i class="fas fa-upload"></i> Restore backup</button>
            <button class="btn-secondary" data-act="unsuspend"><i class="fas fa-play"></i> Unsuspend all</button>
            <button class="btn-secondary" data-act="defaults"><i class="fas fa-rotate-left"></i> Reset scheduling</button>
        </div><p id="persistInfo" class="muted small" style="margin:10px 0 0"></p></div>`;
    $('settingsRoot').innerHTML = html;
    if (navigator.storage && navigator.storage.persisted) navigator.storage.persisted().then((p) => { const e = $('persistInfo'); if (e) e.textContent = p ? 'Storage is marked persistent: the browser will not clear it automatically.' : 'Tip: keep this site installed/bookmarked and back up regularly — browsers can clear site data when the phone is very low on space.'; }).catch(() => {});
}
async function settingChanged(inp) {
    const k = inp.dataset.k, t = inp.dataset.t, def = FIELDS.find((f) => f[0] === k), min = def ? def[4] : 0;
    let v = inp.value.trim();
    if (t === 'int') { v = parseInt(v, 10); if (isNaN(v) || v < min) return badSetting(); }
    else if (t === 'float') { v = parseFloat(v); if (isNaN(v) || v < min) return badSetting(); }
    else if (t === 'steps' || t === 'steps0') {
        v = v.split(/[\s,]+/).filter(Boolean).map(Number);
        if (v.some((n) => isNaN(n) || n <= 0) || (t === 'steps' && !v.length)) return badSetting();
    }
    App.settings[k] = v; await saveSettings(); renderAll(); toast('Saved.', 'success');
}
function badSetting() { toast('That value is not valid.', 'error'); renderSettings(); }

// ================================================================
//  IMPORT TAB
// ================================================================
const MAP_OPTS = [['front', 'Front'], ['back', 'Back'], ['tags', 'Tags'], ['ignore', 'Ignore']];
function refreshImportDecks() {
    const prev = $('impDeck').value;
    $('impDeck').innerHTML = deckOptionsHtml(getDeck(prev) ? prev : (getDeck(App.settings.lastDeckId) ? App.settings.lastDeckId : (App.decks[0] || {}).id));
    if (!$('impMapF').options.length) {
        [['impMapF', 'front'], ['impMapB', 'back'], ['impMapT', 'tags']].forEach(([id, v]) => { $(id).innerHTML = MAP_OPTS.map(([a, b]) => `<option value="${a}">${b}</option>`).join(''); $(id).value = v; });
    }
}
function impSep() { const s = $('impSep').value; return s === 'custom' ? ($('impCustom').value || ';') : (s === '\\t' ? '\t' : s); }
function impParse() {
    const text = $('impText').value; if (!text.trim()) return { rows: [], cards: [], sep: impSep(), warn: '' };
    let rows = parseDelimited(text, impSep()); if ($('impHeader').checked) rows = rows.slice(1);
    const map = ['impMapF', 'impMapB', 'impMapT'].map((i) => $(i).value);
    const cards = rows.map((r) => {
        const o = { front: '', back: '', tags: [] };
        map.forEach((m, i) => {
            const v = r[i]; if (v === undefined || m === 'ignore') return;
            if (m === 'front') o.front = cleanField(v); else if (m === 'back') o.back = cleanField(v); else o.tags = cleanField(v).split(/[,\s]+/).filter(Boolean);
        });
        return o;
    }).filter((o) => o.front && (o.back || /\{\{c\d+::/.test(o.front)));
    let warn = '';
    const lines = text.split(/\r?\n/).filter((l) => l.trim()).length;
    if (rows.length && rows.every((r) => r.length === 1)) warn = 'Only one column was found. Check that the separator matches your file.';
    else if (rows.length < lines * 0.6) warn = 'Fewer cards than lines were found — a stray quote (") may be merging lines.';
    return { rows, cards, sep: impSep(), warn };
}
function refreshImportUI() {
    $('impCustom').classList.toggle('hidden', $('impSep').value !== 'custom');
    const r = impParse(), w = $('impWarn');
    w.textContent = r.warn; w.classList.toggle('hidden', !r.warn);
    $('impPreview').innerHTML = r.cards.length
        ? `<p class="muted small" style="margin:0 0 6px">${r.cards.length} card${r.cards.length === 1 ? '' : 's'} ready · preview:</p><table><tr><th>Front</th><th>Back</th><th>Tags</th></tr>${r.cards.slice(0, 5).map((c) => `<tr><td>${esc(c.front)}</td><td>${esc(c.back)}</td><td>${esc(c.tags.join(' '))}</td></tr>`).join('')}</table>` : '';
    $('impRun').disabled = !r.cards.length;
    $('impRun').innerHTML = `<i class="fas fa-file-import"></i> Import ${r.cards.length || ''} card${r.cards.length === 1 ? '' : 's'}`;
}
async function runImport() {
    const r = impParse(); if (!r.cards.length) return;
    const nn = $('impNewDeck').value.trim();
    let deck = nn ? await createDeck(nn) : getDeck($('impDeck').value);
    if (!deck) { toast('Pick or create a deck first.', 'error'); return; }
    const skip = $('impSkipDup').checked;
    const have = new Set(App.cards.filter((c) => c.deckId === deck.id).map((c) => c.front.trim().toLowerCase()));
    const list = []; let skipped = 0;
    for (const o of r.cards) {
        const key = o.front.trim().toLowerCase();
        if (skip && have.has(key)) { skipped++; continue; }
        have.add(key); list.push(...buildCards({ deckId: deck.id, front: o.front, back: o.back, tags: o.tags, reverse: false }));
    }
    await addCards(list);
    $('impText').value = ''; $('impNewDeck').value = ''; $('impFileName').textContent = '.csv .txt .tsv';
    toast(`Imported ${list.length} card${list.length === 1 ? '' : 's'}${skipped ? ` (${skipped} duplicates skipped)` : ''}.`, 'success');
    renderAll(); refreshImportDecks(); refreshImportUI();
}

// ================================================================
//  LOAD / INIT / EVENTS
// ================================================================
async function loadAll() {
    const st = App.storage;
    App.decks = await st.getAll('decks'); App.cards = await st.getAll('cards'); App.history = await st.getAll('history');
    const saved = await st.get('settings', 'app_settings');
    App.settings = { ...DEF, ...(saved || {}) }; delete App.settings.key;
    App.settings.studyLog = { ...(App.settings.studyLog || {}) };
    ['learningSteps', 'relearnSteps'].forEach((k) => { if (!Array.isArray(App.settings[k])) App.settings[k] = [...DEF[k]]; });
    document.documentElement.setAttribute('data-theme', App.settings.theme === 'dark' ? 'dark' : 'light');
    App.cards.forEach(normalizeCard);
    App.cardMap = new Map(App.cards.map((c) => [c.id, c])); App.histVer++;
    App.lastSeq = App.cards.reduce((m, c) => Math.max(m, c.seq || 0), 0);
    if (!App.decks.length) await createDeck('Default');
    const ids = new Set(App.decks.map((d) => d.id)), orphans = App.cards.filter((c) => !ids.has(c.deckId));
    if (orphans.length) {
        const rec = await createDeck('Recovered');
        orphans.forEach((c) => { c.deckId = rec.id; });
        await App.storage.putMany('cards', orphans);
        setTimeout(() => toast(`${orphans.length} cards without a deck were moved to “Recovered”.`, 'info'), 600);
    }
}

function setupEvents() {
    const on = (id, ev, fn) => $(id).addEventListener(ev, fn);
    // nav + topbar
    document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    on('addBtn', 'click', () => openCardModal());
    on('quizChip', 'click', () => switchTab('stats'));
    on('themeBtn', 'click', async () => {
        App.settings.theme = App.settings.theme === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', App.settings.theme); renderTopbar(); await saveSettings();
    });
    // decks
    on('deckList', 'click', (e) => {
        const t = e.target.closest('[data-toggle]'); if (t) { e.stopPropagation(); toggleCollapse(t.dataset.toggle); return; }
        const r = e.target.closest('.deck-row'); if (r) openDeckSheet(r.dataset.id);
    });
    on('createDeckBtn', 'click', async () => {
        const n = await ask({ title: 'Create deck', note: 'Use :: to make a subdeck, e.g. Medicine::Cardiology', placeholder: 'Deck name' });
        if (n) { const d = await createDeck(n); if (d) { toast('Deck created.', 'success'); renderAll(); } }
    });
    on('importGoBtn', 'click', () => switchTab('import'));
    on('dsStudy', 'click', () => startReview(App.sheetDeckId));
    on('deckSheet', 'click', (e) => { const b = e.target.closest('[data-ds]'); if (b) deckAction(b.dataset.ds); });
    on('cardSheet', 'click', (e) => { const b = e.target.closest('[data-cs]'); if (b) cardSheetAction(b.dataset.cs); });
    // generic actions
    document.addEventListener('click', (e) => {
        const a = e.target.closest('[data-act]'); if (!a) return;
        const act = a.dataset.act;
        if (act === 'backup') makeBackup();
        else if (act === 'restore') { $('restoreFile').value = ''; $('restoreFile').click(); }
        else if (act === 'unsuspend') {
            const l = App.cards.filter((c) => c.suspended || c.buried);
            if (!l.length) { toast('No suspended cards.', 'info'); return; }
            l.forEach((c) => { c.suspended = false; c.buried = false; }); saveCards(l).then(() => { renderAll(); toast(`${l.length} cards unsuspended.`, 'success'); });
        } else if (act === 'defaults') {
            if (!confirm('Reset all scheduling options to Anki defaults?')) return;
            ['learningSteps', 'relearnSteps', 'graduatingInterval', 'easyInterval', 'startingEase', 'easyBonus', 'hardInterval', 'intervalMod', 'maxInterval', 'leechThreshold', 'learnAheadLimit'].forEach((k) => { App.settings[k] = Array.isArray(DEF[k]) ? [...DEF[k]] : DEF[k]; });
            saveSettings().then(() => { renderAll(); toast('Defaults restored.', 'success'); });
        }
    });
    on('restoreFile', 'change', (e) => { const f = e.target.files[0]; if (f) restoreBackup(f); });
    // modals
    document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(b.dataset.close)));
    document.querySelectorAll('.modal-overlay').forEach((o) => o.addEventListener('mousedown', (e) => {
        if (e.target !== o) return; if (o.id === 'askModal') App.askCancel && App.askCancel(); else closeModal(o.id);
    }));
    on('cmSave', 'click', () => saveCardModal(false));
    on('cmSaveNew', 'click', () => saveCardModal(true));
    on('cmDelete', 'click', async () => {
        const c = App.cardMap.get(App.editing); if (!c || !confirm('Delete this card permanently?')) return;
        await removeCards([c]); App.lastDeleted = { decks: [], cards: [c] }; closeModal('cardModal'); renderAll();
        toast('Card deleted.', 'info', { label: 'Undo', fn: restoreDeleted });
    });
    document.querySelectorAll('.toolbar').forEach((tb) => tb.addEventListener('click', (e) => { const b = e.target.closest('button[data-tb]'); if (b) toolbarAction(tb.dataset.for, b.dataset.tb); }));
    on('imageFile', 'change', (e) => { const f = e.target.files[0]; if (f && App.imgTarget) insertImageFile(App.imgTarget, f); });
    ['cmFront', 'cmBack'].forEach((id) => $(id).addEventListener('paste', (e) => {
        const it = [...((e.clipboardData && e.clipboardData.items) || [])].find((i) => i.type.startsWith('image/'));
        if (it) { e.preventDefault(); insertImageFile(id, it.getAsFile()); }
    }));
    // custom study
    on('crMode', 'change', () => {
        const m = $('crMode').value;
        $('crDaysRow').classList.toggle('hidden', m !== 'forgot' && m !== 'ahead'); $('crTagRow').classList.toggle('hidden', m !== 'tag');
    });
    on('crStart', 'click', () => {
        const ids = buildCram(App.cramDeckId, $('crMode').value, { days: Math.max(1, +$('crDays').value || 7), tag: $('crTag').value.trim(), max: Math.max(1, +$('crCount').value || 50) });
        if (!ids.length) { toast('No cards match that selection.', 'info'); return; }
        closeModal('cramModal'); startReview(App.cramDeckId, { ids });
    });
    // browse
    let timer;
    on('bSearch', 'input', (e) => { clearTimeout(timer); timer = setTimeout(() => { App.B.q = e.target.value; App.B.limit = 50; $('bClear').classList.toggle('hidden', !App.B.q); renderBrowse(); }, 120); });
    on('bClear', 'click', () => { $('bSearch').value = ''; App.B.q = ''; $('bClear').classList.add('hidden'); renderBrowse(); $('bSearch').focus(); });
    on('bDeck', 'change', (e) => { App.B.deck = e.target.value; App.B.limit = 50; renderBrowse(); });
    on('bSort', 'change', (e) => { App.B.sort = e.target.value; renderBrowse(); });
    on('bOrder', 'click', () => { App.B.desc = !App.B.desc; renderBrowse(); });
    on('bMore', 'click', () => { App.B.limit += 50; renderBrowse(); });
    on('bSelectBtn', 'click', () => { App.B.selecting = !App.B.selecting; if (!App.B.selecting) App.B.sel.clear(); renderBrowse(); });
    on('bulkBar', 'click', (e) => { const b = e.target.closest('[data-bulk]'); if (b) bulkAction(b.dataset.bulk); });
    let lp = null, lpFired = false;
    const bl = $('bList');
    bl.addEventListener('pointerdown', (e) => {
        const r = e.target.closest('.b-row'); if (!r) return; lpFired = false;
        lp = setTimeout(() => { lpFired = true; App.B.selecting = true; App.B.sel.add(r.dataset.id); renderBrowse(); if (navigator.vibrate) navigator.vibrate(15); }, 480);
    });
    ['pointerup', 'pointerleave', 'pointermove', 'pointercancel'].forEach((ev) => bl.addEventListener(ev, () => clearTimeout(lp)));
    bl.addEventListener('click', (e) => {
        const r = e.target.closest('.b-row'); if (!r) return;
        if (lpFired) { lpFired = false; return; }
        if (App.B.selecting) { const id = r.dataset.id; App.B.sel.has(id) ? App.B.sel.delete(id) : App.B.sel.add(id); renderBrowse(); }
        else openCardSheet(r.dataset.id);
    });
    // activity + settings
    on('statsRoot', 'change', async (e) => {
        if (e.target.id !== 'goalInput') return;
        const v = parseInt(e.target.value, 10); if (isNaN(v) || v < 1) { toast('Enter a goal of at least 1.', 'error'); renderStats(); return; }
        App.settings.dailyGoal = v; await saveSettings(); renderStats(); toast('Daily goal updated.', 'success');
    });
    on('settingsRoot', 'change', (e) => { if (e.target.dataset.k) settingChanged(e.target); });
    // import
    on('impChoose', 'click', () => { $('impFile').value = ''; $('impFile').click(); });
    on('impFile', 'change', async (e) => {
        const f = e.target.files[0]; if (!f) return;
        $('impText').value = await f.text(); $('impFileName').textContent = f.name; refreshImportUI();
    });
    ['impText', 'impSep', 'impCustom', 'impHeader', 'impMapF', 'impMapB', 'impMapT'].forEach((i) => { $(i).addEventListener('input', refreshImportUI); $(i).addEventListener('change', refreshImportUI); });
    on('impRun', 'click', runImport);
    // review
    on('rvShow', 'click', showAnswer);
    on('rvRates', 'click', (e) => { const b = e.target.closest('[data-r]'); if (b) rate(+b.dataset.r); });
    on('rvExit', 'click', exitReview);
    on('rvUndo', 'click', undoLast);
    on('rvMenuBtn', 'click', (e) => { e.stopPropagation(); $('rvMenu').classList.toggle('hidden'); });
    on('rvMenu', 'click', (e) => { const b = e.target.closest('[data-rm]'); if (b) reviewMenu(b.dataset.rm); });
    on('rvBody', 'click', () => $('rvMenu').classList.add('hidden'));
    on('rvFinish', 'click', (e) => {
        const b = e.target.closest('[data-fin]'); if (!b) return;
        if (b.dataset.fin === 'exit') exitReview();
        else { App.cramDeckId = App.session.deckId; openModal('cramModal'); }
    });
    // keyboard
    window.addEventListener('keydown', (e) => {
        const tag = (e.target.tagName || '').toLowerCase(), typing = tag === 'input' || tag === 'textarea' || tag === 'select';
        const rv = $('reviewOverlay').classList.contains('active');
        if (e.key === 'Escape') {
            const open = [...document.querySelectorAll('.modal-overlay:not(.hidden)')].pop();
            if (open) { if (open.id === 'askModal') App.askCancel && App.askCancel(); else closeModal(open.id); }
            else if (rv) { if (!$('rvMenu').classList.contains('hidden')) $('rvMenu').classList.add('hidden'); else exitReview(); }
            return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !$('cardModal').classList.contains('hidden')) { e.preventDefault(); saveCardModal(false); return; }
        if (!rv || anyModalOpen()) return;
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undoLast(); return; }
        if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
        const answered = App.cur && App.cur.answered;
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (answered) rate(2); else showAnswer(); }
        else if (answered && '1234'.includes(e.key) && e.key.length === 1) rate(+e.key - 1);
        else if (e.key.toLowerCase() === 'z') undoLast();
        else if (e.key.toLowerCase() === 'e' && App.cur) openCardModal({ card: App.cur.card });
    });
}

async function initApp() {
    await App.storage.init();
    await loadAll();
    setupEvents(); refreshImportDecks(); populateBrowseDecks(); renderAll();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    setInterval(() => { if (!App.session && !anyModalOpen()) renderDecks(); }, 60000);
}
if (typeof window !== 'undefined' && typeof document !== 'undefined') window.addEventListener('DOMContentLoaded', initApp);
