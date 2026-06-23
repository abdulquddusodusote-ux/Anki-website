// ================================================================
//  FLASHCOACH — COMPLETE APPLICATION
//  SRS Compliant — Parts 1-8
//  Version: Final (with Streaks, Study Time, Collapsible Cards)
// ================================================================

// ================================================================
//  STORAGE ENGINE
// ================================================================

const DB_NAME = 'FlashCoachDB';
const DB_VERSION = 2;

class StorageEngine {
    constructor() {
        this.db = null;
        this.ready = false;
        this.pending = [];
    }

    async init() {
        return new Promise((resolve) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('cards')) {
                    const store = db.createObjectStore('cards', { keyPath: 'id' });
                    store.createIndex('deckId', 'deckId', { unique: false });
                    store.createIndex('due', 'due', { unique: false });
                    store.createIndex('state', 'state', { unique: false });
                }
                if (!db.objectStoreNames.contains('decks')) {
                    db.createObjectStore('decks', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('history')) {
                    const store = db.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
                    store.createIndex('cardId', 'cardId', { unique: false });
                }
                if (!db.objectStoreNames.contains('sessions')) {
                    db.createObjectStore('sessions', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('settings')) {
                    db.createObjectStore('settings', { keyPath: 'key' });
                }
                if (!db.objectStoreNames.contains('deckNames')) {
                    db.createObjectStore('deckNames', { keyPath: 'name' });
                }
            };
            request.onsuccess = (e) => {
                this.db = e.target.result;
                this.ready = true;
                resolve(true);
            };
            request.onerror = () => {
                // Fallback to localStorage
                this.ready = true;
                resolve(true);
            };
        });
    }

    async _ensureReady() {
        if (!this.ready) await this.init();
    }

    async get(store, id) {
        await this._ensureReady();
        if (this.db) {
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction(store, 'readonly');
                const req = tx.objectStore(store).get(id);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        }
        const data = localStorage.getItem(`_${store}_${id}`);
        return data ? JSON.parse(data) : null;
    }

    async getAll(store) {
        await this._ensureReady();
        if (this.db) {
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction(store, 'readonly');
                const req = tx.objectStore(store).getAll();
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => reject(req.error);
            });
        }
        const results = [];
        const prefix = `_${store}_`;
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith(prefix)) {
                try { results.push(JSON.parse(localStorage.getItem(key))); } catch {}
            }
        }
        return results;
    }

    async put(store, data) {
        await this._ensureReady();
        if (this.db) {
            const tx = this.db.transaction(store, 'readwrite');
            await tx.objectStore(store).put(data);
            await tx.done;
        } else {
            localStorage.setItem(`_${store}_${data.id || data.key}`, JSON.stringify(data));
        }
    }

    async delete(store, id) {
        await this._ensureReady();
        if (this.db) {
            const tx = this.db.transaction(store, 'readwrite');
            await tx.objectStore(store).delete(id);
            await tx.done;
        } else {
            localStorage.removeItem(`_${store}_${id}`);
        }
    }

    async clear(store) {
        await this._ensureReady();
        if (this.db) {
            const tx = this.db.transaction(store, 'readwrite');
            await tx.objectStore(store).clear();
            await tx.done;
        } else {
            const prefix = `_${store}_`;
            for (let i = localStorage.length - 1; i >= 0; i--) {
                const key = localStorage.key(i);
                if (key && key.startsWith(prefix)) localStorage.removeItem(key);
            }
        }
    }

    async getByIndex(store, indexName, value) {
        await this._ensureReady();
        if (this.db) {
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction(store, 'readonly');
                const req = tx.objectStore(store).index(indexName).getAll(value);
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => reject(req.error);
            });
        }
        const all = await this.getAll(store);
        return all.filter(item => item[indexName] === value);
    }
}

// ================================================================
//  DEFAULT SETTINGS
// ================================================================

const DEFAULT_SETTINGS = {
    dailyGoal: 20,
    theme: 'light',
    streak: 0,
    goalStreak: 0,
    lastStudyDate: null,
    reviewedToday: 0,
    totalStudyTimeToday: 0, // in seconds
    learningSteps: [1, 5, 10], // minutes
    graduatingInterval: 1, // days
    easyInterval: 4, // days
    startingEase: 2.5,
    easyBonus: 1.3,
    lapseInterval: 0.1, // days
    leechThreshold: 8,
};

// ================================================================
//  APPLICATION STATE
// ================================================================

const App = {
    storage: new StorageEngine(),
    cards: [],
    decks: [],
    history: [],
    settings: {},
    expandedDecks: {},
    currentDeckId: null,
    isReviewing: false,
    reviewQueue: [],
    reviewIndex: 0,
    session: null,
    sessionStats: { total: 0, again: 0, hard: 0, good: 0, easy: 0 },
    sessionStartTime: null,
    sessionTimerInterval: null,
    sessionElapsedSeconds: 0,
};

// ================================================================
//  UTILITY FUNCTIONS
// ================================================================

function generateId() {
    return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function todayStr() {
    return new Date().toISOString().split('T')[0];
}

function nowISO() {
    return new Date().toISOString();
}

function daysBetween(d1, d2) {
    const a = new Date(d1);
    const b = new Date(d2);
    const diff = (a - b) / (1000 * 60 * 60 * 24);
    return Math.round(diff);
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function getLocalName(fullName) {
    if (!fullName) return '';
    return fullName.includes('::') ? fullName.split('::').pop() : fullName;
}

function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    if (mins > 0) {
        return `${mins} min${mins > 1 ? 's' : ''}`;
    }
    return `${secs}s`;
}

function formatTimeMMSS(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

// ================================================================
//  SCHEDULER (SM-2)
// ================================================================

function scheduleCard(card, rating) {
    const s = App.settings;
    let { interval, ease, reps, state, lapses } = card;
    if (!interval) interval = 0;
    if (!ease) ease = s.startingEase || 2.5;
    if (!reps) reps = 0;
    if (!lapses) lapses = 0;
    if (!state) state = 'new';

    const now = new Date();
    const learningSteps = s.learningSteps || [1, 5, 10];

    // --- Learning Phase ---
    if (state === 'new' || state === 'learning' || state === 'relearning') {
        const stepIndex = Math.min(reps, learningSteps.length - 1);
        const step = learningSteps[stepIndex];

        if (rating === 0) { // Again
            lapses++;
            if (state === 'relearning') {
                state = 'learning';
                reps = 0;
                interval = learningSteps[0] / 1440;
            } else {
                interval = learningSteps[0] / 1440;
                reps = 0;
            }
            ease = Math.max(1.3, ease - 0.2);
        } else if (rating === 1) { // Hard
            interval = step / 1440;
            reps++;
        } else if (rating === 2) { // Good
            if (reps < learningSteps.length - 1) {
                interval = step / 1440;
                reps++;
            } else {
                state = 'review';
                interval = s.graduatingInterval || 1;
                reps = learningSteps.length;
            }
        } else if (rating === 3) { // Easy
            state = 'review';
            interval = s.easyInterval || 4;
            reps = learningSteps.length;
            ease = Math.min(ease + 0.15, 10);
        }

        if (!interval || interval < 1/1440) interval = 1/1440;
        const due = new Date(now.getTime() + interval * 24 * 60 * 60 * 1000);

        return { state, interval, ease, reps, lapses, due: due.toISOString() };
    }

    // --- Review Phase ---
    if (state === 'review') {
        let newInterval = interval;
        let newEase = ease;
        let newLapses = lapses;

        if (rating === 0) {
            newLapses++;
            newInterval = s.lapseInterval || 0.1;
            state = 'relearning';
            reps = 0;
            newEase = Math.max(1.3, ease - 0.2);
            if (newLapses >= (s.leechThreshold || 8)) {
                state = 'suspended';
            }
        } else if (rating === 1) {
            newInterval = Math.max(1, interval * 0.8);
            newEase = Math.max(1.3, ease - 0.15);
            reps++;
        } else if (rating === 2) {
            newInterval = interval * ease;
            reps++;
        } else if (rating === 3) {
            newInterval = interval * ease * (s.easyBonus || 1.3);
            newEase = Math.min(ease + 0.15, 10);
            reps++;
        }

        if (newInterval > 365) newInterval = 365;
        const due = new Date(now.getTime() + newInterval * 24 * 60 * 60 * 1000);

        return {
            state,
            interval: newInterval,
            ease: newEase,
            reps,
            lapses: newLapses,
            due: due.toISOString()
        };
    }

    // Fallback
    return {
        state,
        interval: interval || 1,
        ease: ease || 2.5,
        reps: reps || 0,
        lapses: lapses || 0,
        due: new Date(Date.now() + 86400000).toISOString()
    };
}

// ================================================================
//  CARD OPERATIONS
// ================================================================

async function createCard(data) {
    const card = {
        id: generateId(),
        front: data.front,
        back: data.back,
        deckId: data.deckId || 'general',
        tags: data.tags || [],
        createdAt: nowISO(),
        modifiedAt: nowISO(),
        due: nowISO(),
        interval: 0,
        ease: 2.5,
        reps: 0,
        lapses: 0,
        state: 'new',
        suspended: false,
        buried: false,
        flag: 'none',
        notes: data.notes || '',
        source: 'manual',
    };
    await App.storage.put('cards', card);
    App.cards.push(card);
    return card;
}

async function deleteCard(id) {
    await App.storage.delete('cards', id);
    App.cards = App.cards.filter(c => c.id !== id);
    const history = App.history.filter(h => h.cardId === id);
    for (const h of history) {
        await App.storage.delete('history', h.id);
    }
    App.history = App.history.filter(h => h.cardId !== id);
}

async function updateCard(card) {
    card.modifiedAt = nowISO();
    await App.storage.put('cards', card);
    const idx = App.cards.findIndex(c => c.id === card.id);
    if (idx !== -1) App.cards[idx] = card;
    return card;
}

function getCard(id) {
    return App.cards.find(c => c.id === id);
}

function getDueCards() {
    const now = new Date();
    return App.cards.filter(c => {
        if (c.suspended || c.buried) return false;
        return new Date(c.due) <= now;
    });
}

// ================================================================
//  DECK OPERATIONS
// ================================================================

async function createDeck(name, parentId = null) {
    let deckName = name.trim();
    let currentParentId = parentId;

    if (deckName.includes('::')) {
        const parts = deckName.split('::').map(p => p.trim()).filter(p => p);
        let parent = null;
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (i === 0) {
                const existing = App.decks.find(d => d.name === part);
                if (!existing) {
                    const newDeck = {
                        id: generateId(),
                        name: part,
                        parentId: null,
                        createdAt: nowISO(),
                        modifiedAt: nowISO(),
                        description: '',
                        collapsed: false,
                    };
                    await App.storage.put('decks', newDeck);
                    App.decks.push(newDeck);
                    await App.storage.put('deckNames', { name: part });
                    parent = newDeck.id;
                } else {
                    parent = existing.id;
                }
            } else {
                const fullPath = parts.slice(0, i + 1).join('::');
                const existing = App.decks.find(d => d.name === fullPath);
                if (!existing) {
                    const newDeck = {
                        id: generateId(),
                        name: fullPath,
                        parentId: parent,
                        createdAt: nowISO(),
                        modifiedAt: nowISO(),
                        description: '',
                        collapsed: false,
                    };
                    await App.storage.put('decks', newDeck);
                    App.decks.push(newDeck);
                    await App.storage.put('deckNames', { name: fullPath });
                    parent = newDeck.id;
                } else {
                    parent = existing.id;
                }
            }
        }
        const fullName = parts.join('::');
        return App.decks.find(d => d.name === fullName);
    }

    const existing = App.decks.find(d => d.name === deckName);
    if (existing) return existing;

    const deck = {
        id: generateId(),
        name: deckName,
        parentId: parentId || null,
        createdAt: nowISO(),
        modifiedAt: nowISO(),
        description: '',
        collapsed: false,
    };
    await App.storage.put('decks', deck);
    App.decks.push(deck);
    await App.storage.put('deckNames', { name: deck.name });
    return deck;
}

async function createSubdeck(parentId) {
    const parent = App.decks.find(d => d.id === parentId);
    if (!parent) {
        alert('Parent deck not found.');
        return;
    }
    const name = prompt(`Enter subdeck name to create inside "${getLocalName(parent.name)}":`);
    if (!name || !name.trim()) return;
    const fullName = parent.name + '::' + name.trim();
    const existing = App.decks.find(d => d.name === fullName);
    if (existing) {
        alert('This subdeck already exists!');
        return;
    }
    const deck = {
        id: generateId(),
        name: fullName,
        parentId: parent.id,
        createdAt: nowISO(),
        modifiedAt: nowISO(),
        description: '',
        collapsed: false,
    };
    await App.storage.put('decks', deck);
    App.decks.push(deck);
    await App.storage.put('deckNames', { name: deck.name });
    updateUI();
    return deck;
}

async function deleteDeck(id) {
    const deck = App.decks.find(d => d.id === id);
    if (!deck) return;
    const children = App.decks.filter(d => d.parentId === id);
    for (const child of children) {
        await deleteDeck(child.id);
    }
    const cards = App.cards.filter(c => c.deckId === id);
    for (const card of cards) {
        await deleteCard(card.id);
    }
    await App.storage.delete('decks', id);
    App.decks = App.decks.filter(d => d.id !== id);
    const deckNames = await App.storage.getAll('deckNames');
    const toRemove = deckNames.filter(d => d.name === deck.name || d.name.startsWith(deck.name + '::'));
    for (const d of toRemove) {
        await App.storage.delete('deckNames', d.name);
    }
}

function getDescendantIds(deckId) {
    const result = [deckId];
    const children = App.decks.filter(d => d.parentId === deckId);
    for (const child of children) {
        result.push(...getDescendantIds(child.id));
    }
    return result;
}

function getDeckCounts(deckId) {
    const descendantIds = getDescendantIds(deckId);
    const deckCards = App.cards.filter(c => descendantIds.includes(c.deckId));
    const now = new Date();
    return {
        total: deckCards.length,
        due: deckCards.filter(c => !c.suspended && !c.buried && new Date(c.due) <= now).length,
        new: deckCards.filter(c => c.state === 'new' && !c.suspended && !c.buried).length,
        learning: deckCards.filter(c => c.state === 'learning' && !c.suspended && !c.buried).length,
        review: deckCards.filter(c => c.state === 'review' && !c.suspended && !c.buried).length,
        suspended: deckCards.filter(c => c.suspended).length,
    };
}

// ================================================================
//  STATISTICS
// ================================================================

function getRetention(deckId = null, days = 30) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    let filtered = App.history.filter(h => new Date(h.timestamp) >= cutoff);
    if (deckId) {
        const descendantIds = getDescendantIds(deckId);
        const cardIds = App.cards.filter(c => descendantIds.includes(c.deckId)).map(c => c.id);
        filtered = filtered.filter(h => cardIds.includes(h.cardId));
    }
    if (filtered.length === 0) return 0;
    const correct = filtered.filter(h => h.ratingValue >= 2).length;
    return Math.round((correct / filtered.length) * 100);
}

function getLapseRate(deckId = null, days = 30) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    let filtered = App.history.filter(h => new Date(h.timestamp) >= cutoff);
    if (deckId) {
        const descendantIds = getDescendantIds(deckId);
        const cardIds = App.cards.filter(c => descendantIds.includes(c.deckId)).map(c => c.id);
        filtered = filtered.filter(h => cardIds.includes(h.cardId));
    }
    if (filtered.length === 0) return 0;
    const lapses = filtered.filter(h => h.ratingValue === 0).length;
    return Math.round((lapses / filtered.length) * 100);
}

function getExamReadiness(deckId) {
    const descendantIds = getDescendantIds(deckId);
    const deckCards = App.cards.filter(c => descendantIds.includes(c.deckId));
    if (deckCards.length === 0) return 0;
    const mature = deckCards.filter(c => c.interval > 21).length;
    const retention = getRetention(deckId, 30);
    const coverage = Math.min(100, (deckCards.length / (deckCards.length + 10)) * 100);
    const score = Math.round(
        (mature / deckCards.length) * 40 +
        retention * 0.4 +
        coverage * 0.2
    );
    return Math.min(100, Math.max(0, score));
}

function getInsights(deckId = null) {
    const insights = [];
    const retention = getRetention(deckId, 30);
    const lapseRate = getLapseRate(deckId, 30);
    if (retention < 70) {
        insights.push("📉 Your retention is below 70%. Consider reviewing more frequently or using mnemonic techniques.");
    } else if (retention > 90) {
        insights.push("📈 Excellent retention! Your study method is working well.");
    }
    if (lapseRate > 20) {
        insights.push("🔄 You're forgetting cards often. Try reducing your daily new card limit.");
    }
    if (insights.length === 0) {
        insights.push("📚 Keep studying consistently. You're on the right track!");
    }
    return insights;
}

// ================================================================
//  SESSION MANAGER
// ================================================================

async function createSession(deckId, queue) {
    const session = {
        id: generateId(),
        deckId: deckId || 'all',
        createdAt: nowISO(),
        startedAt: nowISO(),
        queue: queue.map(c => c.id),
        completedIds: [],
        currentIndex: 0,
        totalCards: queue.length,
        lastActivity: nowISO(),
        finished: false,
    };
    await App.storage.put('sessions', session);
    App.session = session;
    return session;
}

async function loadSession() {
    const sessions = await App.storage.getAll('sessions');
    const active = sessions.find(s => !s.finished);
    if (active) {
        App.session = active;
        return active;
    }
    return null;
}

async function updateSession(session) {
    session.lastActivity = nowISO();
    await App.storage.put('sessions', session);
    App.session = session;
}

async function completeSession(session) {
    session.finished = true;
    session.lastActivity = nowISO();
    await App.storage.put('sessions', session);
    if (App.session && App.session.id === session.id) {
        App.session = null;
    }
}

async function discardSession() {
    if (App.session) {
        await App.storage.delete('sessions', App.session.id);
        App.session = null;
    }
}

// ================================================================
//  UI RENDER FUNCTIONS
// ================================================================

function renderStatStrip() {
    const total = App.cards.length;
    const due = getDueCards().length;
    const avgSec = 8;
    const timeMin = Math.round((due * avgSec) / 60);
    const retention = getRetention(null, 7);
    const streak = App.settings.streak || 0;
    const goalStreak = App.settings.goalStreak || 0;
    const goal = App.settings.dailyGoal || 20;
    const reviewed = App.settings.reviewedToday || 0;
    const studyTime = App.settings.totalStudyTimeToday || 0;
    const strip = document.getElementById('statStrip');
    if (strip) {
        strip.innerHTML = `
            <span class="stat-item"><span class="label">📚 Cards</span> <strong>${total}</strong></span>
            <span class="stat-item"><span class="label">⏳ Due</span> <strong>${due}</strong> <span style="font-size:0.75rem;color:var(--text-muted);">≈${timeMin}m</span></span>
            <span class="stat-item"><span class="label">📈 Retention</span> <strong>${retention}%</strong></span>
            <span class="stat-item"><span class="label">🔥 Streak</span> <strong>${streak}d</strong> <span style="font-size:0.7rem;color:var(--text-muted);">(Goal: ${goalStreak}d)</span></span>
            <span class="stat-item"><span class="label">🎯 Today</span> <strong>${reviewed}/${goal}</strong></span>
            <span class="stat-item"><span class="label">⏱️ Time</span> <strong>${formatTime(studyTime)}</strong></span>
        `;
    }
    updateGoalPill();
    renderStudyTime();
}

function renderStudyTime() {
    const today = App.settings.totalStudyTimeToday || 0;
    const week = App.settings.totalStudyTimeWeek || 0;
    const month = App.settings.totalStudyTimeMonth || 0;

    const todayEl = document.getElementById('studyTimeDisplay');
    if (todayEl) todayEl.textContent = formatTime(today);

    const weekEl = document.getElementById('weekStudyTime');
    if (weekEl) weekEl.textContent = formatTime(week);

    const monthEl = document.getElementById('monthStudyTime');
    if (monthEl) monthEl.textContent = formatTime(month);

    // Update streaks
    const dailyStreakEl = document.getElementById('dailyStreakDisplay');
    if (dailyStreakEl) dailyStreakEl.textContent = `${App.settings.streak || 0} days`;

    const goalStreakEl = document.getElementById('goalStreakDisplay');
    if (goalStreakEl) goalStreakEl.textContent = `${App.settings.goalStreak || 0} days`;
}

function renderForecast() {
    const container = document.getElementById('forecastContainer');
    if (!container) return;
    const now = new Date();
    let maxCount = 1;
    const counts = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(now);
        d.setDate(d.getDate() + i);
        const key = d.toISOString().split('T')[0];
        const count = App.cards.filter(c => !c.suspended && !c.buried && c.due.split('T')[0] === key).length;
        counts.push(count);
        if (count > maxCount) maxCount = count;
    }
    const labels = ['Today','+1','+2','+3','+4','+5','+6'];
    container.innerHTML = counts.map((c, idx) => {
        const pct = maxCount > 0 ? Math.max(4, (c / maxCount) * 70) : 4;
        return `<div class="forecast-bar" style="height:${pct}px;">
            <span class="count">${c}</span>
            <span class="label">${labels[idx]}</span>
        </div>`;
    }).join('');
}

function renderWeakTopic() {
    const el = document.getElementById('weakTopicDisplay');
    if (!el) return;
    if (App.decks.length === 0) {
        el.textContent = 'No decks yet. Add some cards to see your weak topics.';
        return;
    }
    let weakest = null;
    let worstScore = 100;
    for (const deck of App.decks) {
        const ret = getRetention(deck.id, 30);
        if (ret < worstScore) {
            worstScore = ret;
            weakest = deck;
        }
    }
    if (weakest && worstScore < 80) {
        el.innerHTML = `<strong>${getLocalName(weakest.name)}</strong> — Retention: <strong>${worstScore}%</strong>
            <span style="display:block;font-size:0.8rem;color:var(--text-muted);margin-top:4px;">
            ⚠️ This is your weakest topic. Consider reviewing it today.</span>`;
    } else {
        el.textContent = '✅ No weak topics detected. Keep going!';
    }
}

function renderSmartGoal() {
    const el = document.getElementById('smartGoalDisplay');
    if (!el) return;
    const due = getDueCards().length;
    const upcoming = App.cards.filter(c => {
        if (c.suspended || c.buried) return false;
        const d = new Date(c.due);
        const now = new Date();
        return d > now && d <= new Date(now.getTime() + 3*86400000);
    }).length;
    const total = due + upcoming;
    if (total === 0) {
        el.innerHTML = '🎉 No backlog! Keep up the great work.';
        return;
    }
    const goal7 = Math.ceil(total / 7);
    const goal14 = Math.ceil(total / 14);
    el.innerHTML = `
        <div>📅 <strong>${total}</strong> cards due in the next 3 days.</div>
        <div style="margin-top:4px;">To clear in 7 days: <strong>${goal7}</strong> / day</div>
        <div>To clear in 14 days: <strong>${goal14}</strong> / day</div>
    `;
}

function updateGoalPill() {
    const reviewed = App.settings.reviewedToday || 0;
    const goal = App.settings.dailyGoal || 20;
    const pill = document.getElementById('goalPill');
    if (pill) pill.textContent = `${reviewed}/${goal}`;
}

function populateDeckSelects() {
    const selects = ['reviewDeckSelect', 'statsDeckSelect'];
    for (const id of selects) {
        const el = document.getElementById(id);
        if (!el) continue;
        const current = el.value;
        el.innerHTML = App.decks.map(d => `<option value="${d.id}">${getLocalName(d.name)}</option>`).join('');
        if (current) el.value = current;
    }
}

// ================================================================
//  DECK TREE
// ================================================================

function renderDeckTree() {
    const container = document.getElementById('deckTreeContainer');
    if (!container) return;
    const roots = App.decks.filter(d => !d.parentId);
    container.innerHTML = renderTreeNodes(roots);

    container.querySelectorAll('.arrow').forEach(el => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            const li = el.closest('li');
            const sub = li.querySelector('ul');
            if (sub) {
                const isExpanded = sub.style.display !== 'none';
                sub.style.display = isExpanded ? 'none' : '';
                el.textContent = isExpanded ? '▶' : '▼';
                const deckId = el.dataset.deckId;
                if (deckId) App.expandedDecks[deckId] = !isExpanded;
            }
        });
    });

    container.querySelectorAll('.deck-name').forEach(el => {
        el.addEventListener('click', () => {
            const deckId = el.dataset.deckId;
            if (deckId) selectDeck(deckId);
        });
    });
}

function renderTreeNodes(deckList, level = 0) {
    let html = '<ul>';
    for (const deck of deckList) {
        const children = App.decks.filter(d => d.parentId === deck.id);
        const isExpanded = App.expandedDecks[deck.id] !== undefined ? App.expandedDecks[deck.id] : false;
        const counts = getDeckCounts(deck.id);
        const localName = getLocalName(deck.name);

        html += `<li>
            <div class="deck-item">
                ${children.length > 0 ? `<span class="arrow" data-deck-id="${deck.id}">${isExpanded ? '▼' : '▶'}</span>` : `<span class="arrow" style="opacity:0;">▶</span>`}
                <span class="deck-icon"><i class="fas fa-folder"></i></span>
                <span class="deck-name" data-deck-id="${deck.id}">${localName}</span>
                <span class="badge">${counts.total} (${counts.due})</span>
                <div class="actions">
                    <button onclick="createSubdeckAction('${deck.id}')" title="Create Subdeck"><i class="fas fa-plus-circle"></i></button>
                    <button onclick="importToDeck('${deck.id}')" title="Import"><i class="fas fa-upload"></i></button>
                    <button onclick="addCardToDeck('${deck.id}')" title="Add Card"><i class="fas fa-file"></i></button>
                    <button onclick="deleteDeckAction('${deck.id}')" title="Delete"><i class="fas fa-trash"></i></button>
                </div>
            </div>`;
        if (children.length > 0) {
            html += `<ul style="display:${isExpanded ? '' : 'none'};">${renderTreeNodes(children, level + 1)}</ul>`;
        }
        html += '</li>';
    }
    html += '</ul>';
    return html;
}

function selectDeck(deckId) {
    const info = document.getElementById('selectedDeckInfo');
    const nameEl = document.getElementById('selectedDeckName');
    const deck = App.decks.find(d => d.id === deckId);
    if (!deck) return;
    const counts = getDeckCounts(deckId);
    nameEl.textContent = `📁 ${getLocalName(deck.name)} (${counts.total} cards)`;
    info.style.display = 'block';

    document.querySelectorAll('.deck-item').forEach(el => el.classList.remove('highlight'));
    const highlight = document.querySelector(`.deck-item .deck-name[data-deck-id="${deckId}"]`);
    if (highlight) highlight.closest('.deck-item').classList.add('highlight');

    document.getElementById('toggleCardsBtn').onclick = () => toggleCardsView(deckId);
    document.getElementById('importToDeckBtn').onclick = () => importToDeck(deckId);
    document.getElementById('addCardToDeckBtn').onclick = () => addCardToDeck(deckId);
}

let cardsVisible = false;

function toggleCardsView(deckId) {
    const container = document.getElementById('deckCardListContainer');
    const btn = document.getElementById('toggleCardsBtn');
    if (cardsVisible) {
        container.style.display = 'none';
        btn.innerHTML = '<i class="fas fa-list"></i> View Cards';
        cardsVisible = false;
    } else {
        container.style.display = 'block';
        btn.innerHTML = '<i class="fas fa-chevron-up"></i> Hide Cards';
        cardsVisible = true;
        showCardsInDeck(deckId);
    }
}

function showCardsInDeck(deckId) {
    const container = document.getElementById('deckCardList');
    const filtered = App.cards.filter(c => c.deckId === deckId);
    if (filtered.length === 0) {
        container.innerHTML = `<p class="text-muted">No cards in this deck.</p>
            <button onclick="addCardToDeck('${deckId}')" class="btn-primary" style="margin-top:8px;"><i class="fas fa-plus"></i> Add Card</button>`;
        return;
    }
    let html = `<h4>${getLocalName(App.decks.find(d => d.id === deckId)?.name)} (${filtered.length} cards)</h4>
        <button onclick="addCardToDeck('${deckId}')" class="btn-primary" style="font-size:0.8rem;margin-bottom:8px;"><i class="fas fa-plus"></i> Add Card</button>
        <div style="max-height:300px;overflow-y:auto;">`;
    for (const c of filtered) {
        const tags = c.tags && c.tags.length ? c.tags.map(t => `#${t}`).join(' ') : '';
        html += `<div class="card-entry">
            <span class="card-text"><span class="front">${c.front}</span> → <span class="back">${c.back}</span> ${tags ? `<span class="card-tags">${tags}</span>` : ''}</span>
            <div class="actions">
                <button onclick="editCardAction('${c.id}')"><i class="fas fa-edit"></i></button>
                <button onclick="deleteCardAction('${c.id}')"><i class="fas fa-trash"></i></button>
            </div>
        </div>`;
    }
    html += '</div>';
    container.innerHTML = html;

    // Hide cards button
    document.getElementById('hideCardsBtn').onclick = () => {
        document.getElementById('deckCardListContainer').style.display = 'none';
        document.getElementById('toggleCardsBtn').innerHTML = '<i class="fas fa-list"></i> View Cards';
        cardsVisible = false;
    };
}

// ================================================================
//  ACTION FUNCTIONS
// ================================================================

async function createSubdeckAction(deckId) {
    await createSubdeck(deckId);
}

async function addCardToDeck(deckId) {
    const front = prompt('Enter question:');
    if (!front) return;
    const back = prompt('Enter answer:');
    if (!back) return;
    await createCard({ front, back, deckId });
    updateUI();
    if (deckId) showCardsInDeck(deckId);
}

async function deleteDeckAction(deckId) {
    const deck = App.decks.find(d => d.id === deckId);
    if (!deck) return;
    const counts = getDeckCounts(deckId);
    if (!confirm(`Delete deck "${getLocalName(deck.name)}" and all ${counts.total} cards inside it?`)) return;
    await deleteDeck(deckId);
    document.getElementById('selectedDeckInfo').style.display = 'none';
    document.getElementById('deckCardListContainer').style.display = 'none';
    updateUI();
}

async function editCardAction(cardId) {
    const card = getCard(cardId);
    if (!card) return;
    const front = prompt('Edit question:', card.front);
    if (front !== null) card.front = front;
    const back = prompt('Edit answer:', card.back);
    if (back !== null) card.back = back;
    await updateCard(card);
    const deckId = card.deckId;
    if (deckId) showCardsInDeck(deckId);
}

async function deleteCardAction(cardId) {
    if (!confirm('Delete this card?')) return;
    const card = getCard(cardId);
    await deleteCard(cardId);
    if (card) {
        const deckId = card.deckId;
        if (deckId) showCardsInDeck(deckId);
    }
    updateUI();
}

async function importToDeck(deckId) {
    const input = document.getElementById('importFileInput');
    input.value = '';
    input.onchange = async function() {
        const file = input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async function(ev) {
            const text = ev.target.result;
            const lines = text.split(/\r?\n/).filter(line => line.trim() !== '');
            let count = 0;
            for (const line of lines) {
                const parts = line.split(';');
                if (parts.length < 2) continue;
                const front = parts[0].trim();
                const back = parts.slice(1).join(';').trim();
                if (!front || !back) continue;
                await createCard({ front, back, deckId });
                count++;
            }
            alert(`✅ Imported ${count} cards into "${getLocalName(App.decks.find(d => d.id === deckId)?.name)}".`);
            updateUI();
            if (deckId) showCardsInDeck(deckId);
        };
        reader.readAsText(file);
        input.value = '';
        input.onchange = null;
    };
    input.click();
}

// ================================================================
//  REVIEW ENGINE
// ================================================================

async function startReview(deckId) {
    let queue = getDueCards();
    if (deckId && deckId !== 'all') {
        const descendantIds = getDescendantIds(deckId);
        queue = queue.filter(c => descendantIds.includes(c.deckId));
    }
    queue.sort((a, b) => {
        const order = { 'learning': 0, 'relearning': 1, 'review': 2, 'new': 3 };
        return (order[a.state] || 4) - (order[b.state] || 4);
    });

    if (queue.length === 0) {
        document.getElementById('reviewProgress').textContent = '0 / 0';
        document.getElementById('reviewQuestion').textContent = '🎉 No cards due!';
        document.getElementById('reviewAnswer').style.display = 'none';
        document.getElementById('reviewAnswer').textContent = '';
        document.getElementById('reviewTimer').textContent = '⏱️ 00:00';
        document.querySelectorAll('#reviewButtons button').forEach(b => b.classList.add('hidden'));
        return;
    }

    const session = await createSession(deckId, queue);
    App.isReviewing = true;
    App.reviewQueue = queue;
    App.reviewIndex = 0;
    App.sessionStartTime = Date.now();
    App.sessionElapsedSeconds = 0;
    App.sessionStats = { total: 0, again: 0, hard: 0, good: 0, easy: 0 };

    // Start timer
    if (App.sessionTimerInterval) clearInterval(App.sessionTimerInterval);
    App.sessionTimerInterval = setInterval(() => {
        App.sessionElapsedSeconds = Math.floor((Date.now() - App.sessionStartTime) / 1000);
        document.getElementById('reviewTimer').textContent = `⏱️ ${formatTimeMMSS(App.sessionElapsedSeconds)}`;
    }, 500);

    document.getElementById('reviewExtra').classList.add('hidden');
    renderReviewCard();
}

function renderReviewCard() {
    if (App.reviewIndex >= App.reviewQueue.length || !App.isReviewing) {
        document.getElementById('reviewProgress').textContent = '✅ Complete!';
        document.getElementById('reviewQuestion').textContent = 'Review complete! Great job.';
        document.getElementById('reviewAnswer').style.display = 'none';
        document.querySelectorAll('#reviewButtons button').forEach(b => b.classList.add('hidden'));
        if (App.sessionTimerInterval) clearInterval(App.sessionTimerInterval);
        showSessionSummary();
        App.isReviewing = false;
        return;
    }

    const card = App.reviewQueue[App.reviewIndex];
    document.getElementById('reviewProgress').textContent = `${App.reviewIndex + 1} / ${App.reviewQueue.length}`;
    document.getElementById('reviewQuestion').textContent = card.front;
    document.getElementById('reviewAnswer').style.display = 'none';
    document.getElementById('reviewAnswer').textContent = '';

    document.getElementById('showBtn').classList.remove('hidden');
    document.getElementById('againBtn').classList.add('hidden');
    document.getElementById('hardBtn').classList.add('hidden');
    document.getElementById('goodBtn').classList.add('hidden');
    document.getElementById('easyBtn').classList.add('hidden');
}

function showAnswer() {
    const card = App.reviewQueue[App.reviewIndex];
    document.getElementById('reviewAnswer').textContent = card.back;
    document.getElementById('reviewAnswer').style.display = 'block';

    document.getElementById('showBtn').classList.add('hidden');
    document.getElementById('againBtn').classList.remove('hidden');
    document.getElementById('hardBtn').classList.remove('hidden');
    document.getElementById('goodBtn').classList.remove('hidden');
    document.getElementById('easyBtn').classList.remove('hidden');
}

async function rateCard(rating) {
    if (!App.isReviewing) return;
    const card = App.reviewQueue[App.reviewIndex];
    if (!card) return;

    const result = scheduleCard(card, rating);
    card.state = result.state;
    card.interval = result.interval;
    card.ease = result.ease;
    card.reps = result.reps;
    card.lapses = result.lapses;
    card.due = result.due;
    card.lastReview = nowISO();
    card.modifiedAt = nowISO();
    if (result.state === 'suspended') card.suspended = true;

    const historyEntry = {
        cardId: card.id,
        timestamp: nowISO(),
        rating: ['Again', 'Hard', 'Good', 'Easy'][rating],
        ratingValue: rating,
        oldState: card.state,
        newState: card.state,
    };
    await App.storage.put('history', historyEntry);
    App.history.push(historyEntry);

    App.sessionStats.total++;
    if (rating === 0) App.sessionStats.again++;
    else if (rating === 1) App.sessionStats.hard++;
    else if (rating === 2) App.sessionStats.good++;
    else if (rating === 3) App.sessionStats.easy++;

    await updateCard(card);

    if (App.session) {
        if (!App.session.completedIds.includes(card.id)) {
            App.session.completedIds.push(card.id);
        }
        App.session.currentIndex = App.session.completedIds.length;
        await updateSession(App.session);
    }

    App.reviewIndex++;
    renderReviewCard();
    updateUI();
}

function showSessionSummary() {
    const duration = Math.round((Date.now() - App.sessionStartTime) / 1000);
    const total = App.sessionStats.total || 0;
    const retention = total ? Math.round(((App.sessionStats.good + App.sessionStats.easy) / total) * 100) : 0;
    const el = document.getElementById('reviewExtra');
    el.classList.remove('hidden');
    el.innerHTML = `
        <h4>📊 Session Complete</h4>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:0.9rem;margin-top:8px;">
            <span>⏱ ${formatTime(duration)}</span>
            <span>📝 ${total} cards</span>
            <span>✅ Retention: ${retention}%</span>
            <span>🔴 Again: ${App.sessionStats.again}</span>
            <span>🟡 Hard: ${App.sessionStats.hard}</span>
            <span>🟢 Good: ${App.sessionStats.good}</span>
            <span>🌟 Easy: ${App.sessionStats.easy}</span>
        </div>
        <button onclick="closeSessionSummary()" class="btn-primary" style="margin-top:12px;">OK</button>
    `;
    updateStreakAndStudyTime(duration);
    if (App.session) {
        completeSession(App.session);
    }
    updateUI();
}

function closeSessionSummary() {
    document.getElementById('reviewExtra').classList.add('hidden');
    document.getElementById('reviewProgress').textContent = '0 / 0';
    document.getElementById('reviewQuestion').textContent = 'Select a deck and tap "Start".';
    document.getElementById('reviewAnswer').style.display = 'none';
    document.getElementById('reviewAnswer').textContent = '';
    document.getElementById('reviewTimer').textContent = '⏱️ 00:00';
    document.querySelectorAll('#reviewButtons button').forEach(b => b.classList.add('hidden'));
    if (App.sessionTimerInterval) clearInterval(App.sessionTimerInterval);
    App.isReviewing = false;
    updateUI();
}

function updateStreakAndStudyTime(sessionDuration) {
    const today = todayStr();
    const last = App.settings.lastStudyDate;
    let streak = App.settings.streak || 0;
    let goalStreak = App.settings.goalStreak || 0;
    const reviewedToday = App.settings.reviewedToday || 0;

    // Update streak
    if (last !== today) {
        const diff = daysBetween(today, last);
        if (diff <= 1) {
            if (reviewedToday > 0) streak++;
            if (reviewedToday >= App.settings.dailyGoal) goalStreak++;
        } else {
            streak = reviewedToday > 0 ? 1 : 0;
            goalStreak = reviewedToday >= App.settings.dailyGoal ? 1 : 0;
        }
        App.settings.streak = streak;
        App.settings.goalStreak = goalStreak;
        App.settings.lastStudyDate = today;
        App.storage.put('settings', { key: 'streak', value: streak });
        App.storage.put('settings', { key: 'goalStreak', value: goalStreak });
        App.storage.put('settings', { key: 'lastStudyDate', value: today });
    }

    // Update study time
    if (sessionDuration > 0) {
        App.settings.totalStudyTimeToday = (App.settings.totalStudyTimeToday || 0) + sessionDuration;
        App.storage.put('settings', { key: 'totalStudyTimeToday', value: App.settings.totalStudyTimeToday });
    }

    // Update reviewed today
    App.settings.reviewedToday = reviewedToday + App.sessionStats.total;
    App.storage.put('settings', { key: 'reviewedToday', value: App.settings.reviewedToday });
}

// ================================================================
//  STATS TAB
// ================================================================

function renderStatsTab() {
    const select = document.getElementById('statsDeckSelect');
    const deckId = select?.value;
    if (!deckId || !App.decks.find(d => d.id === deckId)) {
        if (App.decks.length > 0) {
            select.value = App.decks[0].id;
            renderStatsTab();
            return;
        }
        const els = ['statsRetention', 'statsReadiness', 'statsMaturity', 'statsDueDist'];
        for (const id of els) {
            const el = document.getElementById(id);
            if (el) el.textContent = 'Select a deck.';
        }
        const insights = document.getElementById('insightsContainer');
        if (insights) insights.innerHTML = '';
        return;
    }

    const deck = App.decks.find(d => d.id === deckId);
    if (!deck) return;

    const retention = getRetention(deckId, 30);
    const readiness = getExamReadiness(deckId);
    const counts = getDeckCounts(deckId);

    document.getElementById('statsRetention').innerHTML = `<strong>${getLocalName(deck.name)}</strong>: ${retention}%`;
    document.getElementById('statsReadiness').innerHTML = `<strong>${getLocalName(deck.name)}</strong>: ${readiness}/100`;
    document.getElementById('statsMaturity').innerHTML = `
        <div>🆕 New: ${counts.new}</div>
        <div>📖 Learning: ${counts.learning}</div>
        <div>✅ Review: ${counts.review}</div>
        <div>⛔ Suspended: ${counts.suspended}</div>
    `;

    const now = new Date();
    let distHtml = '';
    for (let i = 0; i < 7; i++) {
        const d = new Date(now);
        d.setDate(d.getDate() + i);
        const key = d.toISOString().split('T')[0];
        const count = App.cards.filter(c => {
            if (c.suspended || c.buried) return false;
            return c.deckId === deckId && c.due.split('T')[0] === key;
        }).length;
        distHtml += `<div style="display:flex;gap:8px;align-items:center;padding:2px 0;">
            <span style="width:50px;font-size:0.7rem;">${i===0?'Today':'Day '+i}</span>
            <div style="flex:1;background:var(--border);height:4px;border-radius:2px;">
                <div style="height:100%;width:${Math.min(100,count*8)}%;background:var(--primary);border-radius:2px;"></div>
            </div>
            <span style="font-size:0.7rem;">${count}</span>
        </div>`;
    }
    document.getElementById('statsDueDist').innerHTML = distHtml || 'No cards scheduled.';

    const insights = getInsights(deckId);
    document.getElementById('insightsContainer').innerHTML = insights.map(i =>
        `<div class="insight">${i}</div>`
    ).join('');
}

// ================================================================
//  EXPORT / IMPORT
// ================================================================

async function exportAll() {
    let text = '';
    for (const c of App.cards) {
        text += `${c.front};${c.back}\n`;
    }
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `flashcards_export_${todayStr()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
}

async function resetAll() {
    if (!confirm('⚠️ This will delete ALL your cards, decks, and history. This cannot be undone! Are you sure?')) return;
    if (!confirm('Really? All data will be permanently lost.')) return;
    await App.storage.clear('cards');
    await App.storage.clear('decks');
    await App.storage.clear('history');
    await App.storage.clear('sessions');
    await App.storage.clear('settings');
    await App.storage.clear('deckNames');
    location.reload();
}

// ================================================================
//  NAVIGATION
// ================================================================

function navigateTo(tab) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    const target = document.getElementById(tab);
    if (target) target.classList.add('active');
    document.querySelectorAll(`.nav-btn[data-tab="${tab}"]`).forEach(b => b.classList.add('active'));
    if (tab === 'stats') renderStatsTab();
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('overlay').classList.remove('show');
}

// ================================================================
//  THEME
// ================================================================

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const btn = document.getElementById('themeBtn');
    if (btn) btn.innerHTML = theme === 'light' ? '<i class="fas fa-moon"></i>' : '<i class="fas fa-sun"></i>';
}

async function toggleTheme() {
    const current = App.settings.theme || 'light';
    const next = current === 'light' ? 'dark' : 'light';
    App.settings.theme = next;
    applyTheme(next);
    await App.storage.put('settings', { key: 'theme', value: next });
}

// ================================================================
//  SET GOAL
// ================================================================

async function setGoal() {
    const input = document.getElementById('goalInput');
    if (!input) return;
    const val = parseInt(input.value);
    if (val > 0 && val < 1000) {
        App.settings.dailyGoal = val;
        await App.storage.put('settings', { key: 'dailyGoal', value: val });
        updateUI();
        alert(`✅ Daily goal set to ${val} cards/day.`);
    }
}

// ================================================================
//  UPDATE UI
// ================================================================

function updateUI() {
    renderStatStrip();
    renderForecast();
    renderWeakTopic();
    renderSmartGoal();
    renderDeckTree();
    populateDeckSelects();
    renderStatsTab();
    updateGoalPill();
    renderStudyTime();
}

// ================================================================
//  INIT
// ================================================================

async function initApp() {
    await App.storage.init();

    App.cards = await App.storage.getAll('cards');
    App.decks = await App.storage.getAll('decks');
    App.history = await App.storage.getAll('history');

    const settings = await App.storage.getAll('settings');
    for (const s of settings) {
        App.settings[s.key] = s.value;
    }
    for (const [key, val] of Object.entries(DEFAULT_SETTINGS)) {
        if (App.settings[key] === undefined) App.settings[key] = val;
    }

    const deckNames = await App.storage.getAll('deckNames');
    for (const deck of App.decks) {
        if (!deckNames.some(d => d.name === deck.name)) {
            await App.storage.put('deckNames', { name: deck.name });
        }
    }

    applyTheme(App.settings.theme || 'light');

    const session = await loadSession();
    if (session) {
        const progress = {
            completed: session.completedIds.length,
            total: session.totalCards,
        };
        document.getElementById('resumeInfo').textContent =
            `Progress: ${progress.completed} / ${progress.total} cards completed`;
        document.getElementById('resumeModal').classList.remove('hidden');
        document.getElementById('resumeContinueBtn').onclick = () => {
            document.getElementById('resumeModal').classList.add('hidden');
            resumeReview();
        };
        document.getElementById('resumeDiscardBtn').onclick = async () => {
            await discardSession();
            document.getElementById('resumeModal').classList.add('hidden');
            updateUI();
        };
    }

    const goalInput = document.getElementById('goalInput');
    if (goalInput) goalInput.value = App.settings.dailyGoal || 20;

    updateUI();
    setupEventListeners();
}

async function resumeReview() {
    const session = await loadSession();
    if (!session) return;
    const queue = session.queue.map(id => App.cards.find(c => c.id === id)).filter(Boolean);
    App.isReviewing = true;
    App.reviewQueue = queue;
    App.reviewIndex = session.completedIds.length;
    App.sessionStartTime = Date.now();
    App.sessionStats = { total: session.completedIds.length, again: 0, hard: 0, good: 0, easy: 0 };
    document.getElementById('reviewExtra').classList.add('hidden');
    renderReviewCard();
}

// ================================================================
//  EVENT LISTENERS
// ================================================================

function setupEventListeners() {
    document.querySelectorAll('#bottomNav .nav-btn').forEach(btn => {
        btn.addEventListener('click', () => navigateTo(btn.dataset.tab));
    });

    document.querySelectorAll('#sidebar .nav-btn').forEach(btn => {
        btn.addEventListener('click', () => navigateTo(btn.dataset.tab));
    });

    document.getElementById('menuBtn').addEventListener('click', () => {
        document.getElementById('sidebar').classList.toggle('open');
        document.getElementById('overlay').classList.toggle('show');
    });
    document.getElementById('closeMenuBtn').addEventListener('click', () => {
        document.getElementById('sidebar').classList.remove('open');
        document.getElementById('overlay').classList.remove('show');
    });
    document.getElementById('overlay').addEventListener('click', () => {
        document.getElementById('sidebar').classList.remove('open');
        document.getElementById('overlay').classList.remove('show');
    });

    document.getElementById('themeBtn').addEventListener('click', toggleTheme);
    document.getElementById('settingsThemeBtn')?.addEventListener('click', toggleTheme);

    document.getElementById('createDeckBtn').addEventListener('click', async () => {
        const input = document.getElementById('newDeckInput');
        const name = input.value.trim();
        if (!name) { alert('Enter a deck name.'); return; }
        await createDeck(name);
        input.value = '';
        updateUI();
    });
    document.getElementById('newDeckInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('createDeckBtn').click();
    });

    document.getElementById('startReviewBtn').addEventListener('click', () => {
        const deckId = document.getElementById('reviewDeckSelect').value;
        startReview(deckId);
    });
    document.getElementById('reviewAllBtn').addEventListener('click', () => {
        startReview('all');
    });
    document.getElementById('showBtn').addEventListener('click', showAnswer);
    document.getElementById('againBtn').addEventListener('click', () => rateCard(0));
    document.getElementById('hardBtn').addEventListener('click', () => rateCard(1));
    document.getElementById('goodBtn').addEventListener('click', () => rateCard(2));
    document.getElementById('easyBtn').addEventListener('click', () => rateCard(3));

    document.getElementById('statsDeckSelect').addEventListener('change', renderStatsTab);

    document.getElementById('setGoalBtn').addEventListener('click', setGoal);
    document.getElementById('settingsExportBtn').addEventListener('click', exportAll);
    document.getElementById('resetBtn').addEventListener('click', resetAll);

    document.getElementById('quickReviewBtn').addEventListener('click', () => {
        navigateTo('review');
    });

    document.getElementById('searchInput').addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase().trim();
        if (!query) {
            document.getElementById('deckCardListContainer').style.display = 'none';
            return;
        }
        const filtered = App.cards.filter(c =>
            c.front.toLowerCase().includes(query) ||
            c.back.toLowerCase().includes(query) ||
            (c.tags && c.tags.some(t => t.toLowerCase().includes(query)))
        );
        const container = document.getElementById('deckCardList');
        container.style.display = 'block';
        if (filtered.length === 0) {
            container.innerHTML = '<p class="text-muted">No matching cards.</p>';
            return;
        }
        let html = `<h4>Search results (${filtered.length})</h4><div style="max-height:300px;overflow-y:auto;">`;
        for (const c of filtered) {
            const tags = c.tags && c.tags.length ? c.tags.map(t => `#${t}`).join(' ') : '';
            html += `<div class="card-entry">
                <span class="card-text"><span class="front">${c.front}</span> → <span class="back">${c.back}</span> ${tags ? `<span class="card-tags">${tags}</span>` : ''}</span>
                <div class="actions">
                    <button onclick="editCardAction('${c.id}')"><i class="fas fa-edit"></i></button>
                    <button onclick="deleteCardAction('${c.id}')"><i class="fas fa-trash"></i></button>
                </div>
            </div>`;
        }
        html += '</div>';
        container.innerHTML = html;
        document.getElementById('deckCardListContainer').style.display = 'block';
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === '1') rateCard(0);
        else if (e.key === '2') rateCard(1);
        else if (e.key === '3') rateCard(2);
        else if (e.key === '4') rateCard(3);
        else if (e.key === ' ' || e.key === 'Space') {
            e.preventDefault();
            if (!document.getElementById('showBtn').classList.contains('hidden')) showAnswer();
        }
    });
}

// ================================================================
//  BOOT
// ================================================================

document.addEventListener('DOMContentLoaded', initApp);