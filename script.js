// ================================================================
//  FLASHCOACH — COMPLETE MODERN APPLICATION ENGINE
//  Authentic Anki SM-2 Algorithm, Subdecks, File Import & Cloud Sync
// ================================================================

const DB_NAME = 'FlashCoachDB';
const DB_VERSION = 3;

// ================================================================
//  INDEXEDDB LOCAL STORAGE ENGINE
// ================================================================

class StorageEngine {
    constructor() {
        this.db = null;
        this.ready = false;
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
                if (!db.objectStoreNames.contains('settings')) {
                    db.createObjectStore('settings', { keyPath: 'key' });
                }
            };
            request.onsuccess = (e) => {
                this.db = e.target.result;
                this.ready = true;
                resolve(true);
            };
            request.onerror = () => {
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
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction(store, 'readwrite');
                const req = tx.objectStore(store).put(data);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        } else {
            localStorage.setItem(`_${store}_${data.id || data.key}`, JSON.stringify(data));
        }
    }

    async delete(store, id) {
        await this._ensureReady();
        if (this.db) {
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction(store, 'readwrite');
                const req = tx.objectStore(store).delete(id);
                req.onsuccess = () => resolve();
                req.onerror = () => reject(req.error);
            });
        } else {
            localStorage.removeItem(`_${store}_${id}`);
        }
    }
}

// ================================================================
//  DEFAULT SETTINGS & APPLICATION STATE
// ================================================================

const DEFAULT_SETTINGS = {
    dailyGoal: 20,
    theme: 'light',
    streak: 0,
    goalStreak: 0,
    bestStreak: 0,
    lastStudyDate: null,
    reviewedToday: 0,
    goalMetToday: false,
    totalStudyTimeToday: 0,
    learningSteps: [1, 10],         // Anki Standard: 1min and 10min
    graduatingInterval: 1,          // 1 day
    easyInterval: 4,                // 4 days
    startingEase: 2.5,
    easyBonus: 1.3,
    leechThreshold: 8,
    learnAheadLimit: 20             // minutes
};

const App = {
    storage: new StorageEngine(),
    cards: [],
    decks: [],
    history: [],
    settings: { ...DEFAULT_SETTINGS },
    expandedDecks: {},
    currentDeckId: null,
    contextMenuDeckId: null,

    // Dynamic Review Queue State
    isReviewActive: false,
    sessionNewQueue: [],
    sessionReviewQueue: [],
    learningPool: new Set(),
    currentCardId: null,
    sessionStats: { total: 0, again: 0, hard: 0, good: 0, easy: 0 },
    sessionTimerInterval: null,
    sessionElapsedSeconds: 0,
    waitingInterval: null,
    tempAiCards: [],
    targetImportDeckId: null,
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
    return Math.round((a - b) / (1000 * 60 * 60 * 24));
}

function getLocalName(fullName) {
    if (!fullName) return '';
    return fullName.includes('::') ? fullName.split('::').pop() : fullName;
}

function formatTimeMMSS(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icon = type === 'success' ? 'fa-check-circle' : type === 'error' ? 'fa-exclamation-circle' : 'fa-info-circle';
    toast.innerHTML = `<i class="fas ${icon}"></i> <span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 200);
    }, 3000);
}

// ================================================================
//  ANKI SM-2 SCHEDULER & INTERVAL CALCULATIONS
// ================================================================

function previewIntervals(card) {
    const s = App.settings;
    const cardState = card.state || 'new';
    const reps = card.reps || 0;

    // ---- NEW CARDS (Step 0) ----
    if (cardState === 'new' || (cardState === 'learning' && reps === 0)) {
        return {
            again: '<1m',
            hard:  '<6m',
            good:  '<10m',
            easy:  `${s.easyInterval || 4}d`,
        };
    }

    // ---- LEARNING CARDS (Step 1 - 10m step) ----
    if (cardState === 'learning') {
        return {
            again: '<1m',
            hard:  '<10m',
            good:  `${s.graduatingInterval || 1}d`,
            easy:  `${s.easyInterval || 4}d`,
        };
    }

    // ---- RELEARNING CARDS (Lapsed review cards) ----
    if (cardState === 'relearning') {
        const prevInterval = card.interval || 1;
        const reGrad = Math.max(1, Math.round(prevInterval * 0.5));
        return {
            again: '<10m',
            hard:  '<10m',
            good:  `${reGrad}d`,
            easy:  `${reGrad}d`,
        };
    }

    // ---- GRADUATED REVIEW CARDS ----
    const interval = card.interval || 1;
    const ease = card.ease || 2.5;
    const hardDays = Math.max(1, Math.round(interval * 0.8));
    const goodDays = Math.max(hardDays + 1, Math.round(interval * ease));
    const easyDays = Math.max(goodDays + 1, Math.round(interval * ease * (s.easyBonus || 1.3)));

    return {
        again: '10m',
        hard:  `${hardDays}d`,
        good:  `${goodDays}d`,
        easy:  `${easyDays}d`,
    };
}

function scheduleCard(card, rating) {
    const s = App.settings;
    let { interval, ease, reps, state, lapses } = card;
    if (!interval) interval = 0;
    if (!ease) ease = s.startingEase || 2.5;
    if (!reps) reps = 0;
    if (!lapses) lapses = 0;
    if (!state) state = 'new';

    const now = new Date();
    const learningSteps = s.learningSteps || [1, 10];

    // ---- RELEARNING ----
    if (state === 'relearning') {
        if (rating === 0) { // Again
            lapses++;
            reps = 0;
            interval = 10 / (24 * 60);
            ease = Math.max(1.3, ease - 0.2);
        } else if (rating === 1) { // Hard
            interval = 10 / (24 * 60);
        } else if (rating >= 2) { // Good or Easy -> Graduate
            state = 'review';
            interval = Math.max(1, Math.round((card.interval || 1) * 0.5));
            reps++;
        }
        const due = new Date(now.getTime() + Math.max(1 / (24 * 60), interval) * 24 * 60 * 60 * 1000);
        return { state, interval, ease, reps, lapses, due: due.toISOString() };
    }

    // ---- NEW / LEARNING ----
    if (state === 'new' || state === 'learning') {
        const isStepZero = reps === 0;

        if (rating === 0) { // Again
            lapses++;
            reps = 0;
            interval = learningSteps[0] / (24 * 60); // 1 minute
            state = 'learning';
        } else if (rating === 1) { // Hard
            const hardMins = isStepZero ? 6 : learningSteps[Math.min(reps, learningSteps.length - 1)];
            interval = hardMins / (24 * 60);
            state = 'learning';
        } else if (rating === 2) { // Good
            if (isStepZero) {
                reps = 1;
                interval = learningSteps[1] / (24 * 60); // 10 minutes
                state = 'learning';
            } else {
                // Graduate!
                state = 'review';
                interval = s.graduatingInterval || 1;
                reps = learningSteps.length;
            }
        } else if (rating === 3) { // Easy
            state = 'review';
            interval = s.easyInterval || 4;
            reps = learningSteps.length;
        }

        const due = new Date(now.getTime() + Math.max(1 / (24 * 60), interval) * 24 * 60 * 60 * 1000);
        return { state, interval, ease, reps, lapses, due: due.toISOString() };
    }

    // ---- REVIEW CARDS ----
    if (state === 'review') {
        let newInterval = interval;
        let newEase = ease;
        let newLapses = lapses;

        if (rating === 0) { // Again (Lapse)
            newLapses++;
            newInterval = 10 / (24 * 60);
            state = 'relearning';
            reps = 0;
            newEase = Math.max(1.3, ease - 0.2);
            if (newLapses >= (s.leechThreshold || 8)) state = 'suspended';
        } else if (rating === 1) { // Hard
            newInterval = Math.max(1, interval * 0.8);
            newEase = Math.max(1.3, ease - 0.15);
            reps++;
        } else if (rating === 2) { // Good
            newInterval = Math.max(1, Math.round(interval * ease));
            reps++;
        } else if (rating === 3) { // Easy
            newInterval = Math.max(1, Math.round(interval * ease * (s.easyBonus || 1.3)));
            newEase = Math.min(ease + 0.15, 10);
            reps++;
        }

        if (newInterval > 365) newInterval = 365;
        const due = new Date(now.getTime() + newInterval * 24 * 60 * 60 * 1000);
        return { state, interval: newInterval, ease: newEase, reps, lapses: newLapses, due: due.toISOString() };
    }

    return { state: 'new', interval: 1, ease: 2.5, reps: 0, lapses: 0, due: nowISO() };
}

// ================================================================
//  DECK & CARD MANAGEMENT
// ================================================================

function getDescendantIds(deckId) {
    const deck = App.decks.find(d => d.id === deckId);
    if (!deck) return [deckId];
    const prefix = deck.name + '::';
    const descendants = App.decks.filter(d => d.name.startsWith(prefix)).map(d => d.id);
    return [deckId, ...descendants];
}

function getCardCounts(deckId) {
    const descendantIds = getDescendantIds(deckId);
    const deckCards = App.cards.filter(c => descendantIds.includes(c.deckId) && !c.suspended && !c.buried);
    const now = new Date();

    return {
        total: deckCards.length,
        blue: deckCards.filter(c => c.state === 'new').length,
        red: deckCards.filter(c => c.state === 'learning' || c.state === 'relearning').length,
        green: deckCards.filter(c => c.state === 'review' && new Date(c.due) <= now).length,
    };
}

async function createDeck(name, parentId = null) {
    let deckName = name.trim();
    if (!deckName) return null;

    if (deckName.includes('::')) {
        const parts = deckName.split('::').map(p => p.trim()).filter(p => p);
        let parent = null;
        for (let i = 0; i < parts.length; i++) {
            const fullName = parts.slice(0, i + 1).join('::');
            let existing = App.decks.find(d => d.name === fullName);
            if (!existing) {
                const newDeck = {
                    id: generateId(),
                    name: fullName,
                    parentId: parent,
                    createdAt: nowISO(),
                    modifiedAt: nowISO(),
                    description: '',
                    collapsed: false,
                };
                await App.storage.put('decks', newDeck);
                App.decks.push(newDeck);
                if (window.CloudSync) window.CloudSync.upsertDeck(newDeck);
                parent = newDeck.id;
            } else {
                parent = existing.id;
            }
        }
        const fullName = parts.join('::');
        return App.decks.find(d => d.name === fullName);
    }

    let existing = App.decks.find(d => d.name === deckName);
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
    if (window.CloudSync) window.CloudSync.upsertDeck(deck);
    return deck;
}

async function renameDeck(deckId, newName) {
    const deck = App.decks.find(d => d.id === deckId);
    if (!deck || !newName.trim()) return;
    const oldName = deck.name;
    const targetName = newName.trim();

    // Rename subdecks as well if parent
    App.decks.forEach(async (d) => {
        if (d.id === deckId) {
            d.name = targetName;
            d.modifiedAt = nowISO();
            await App.storage.put('decks', d);
            if (window.CloudSync) window.CloudSync.upsertDeck(d);
        } else if (d.name.startsWith(oldName + '::')) {
            d.name = targetName + d.name.slice(oldName.length);
            d.modifiedAt = nowISO();
            await App.storage.put('decks', d);
            if (window.CloudSync) window.CloudSync.upsertDeck(d);
        }
    });

    showToast('Deck renamed.', 'success');
    renderApp();
}

async function deleteDeck(deckId) {
    const descendantIds = getDescendantIds(deckId);
    for (const dId of descendantIds) {
        await App.storage.delete('decks', dId);
        App.decks = App.decks.filter(d => d.id !== dId);
        if (window.CloudSync) window.CloudSync.deleteDeck(dId);

        // Delete cards in this deck
        const cardsToDelete = App.cards.filter(c => c.deckId === dId);
        for (const c of cardsToDelete) {
            await deleteCard(c.id);
        }
    }
    showToast('Deck and subdecks deleted.', 'info');
    renderApp();
}

async function createCard(data) {
    const card = {
        id: generateId(),
        deckId: data.deckId || (App.decks[0] ? App.decks[0].id : 'general'),
        front: data.front.trim(),
        back: data.back.trim(),
        tags: Array.isArray(data.tags) ? data.tags : (data.tags ? data.tags.split(',').map(t => t.trim()).filter(Boolean) : []),
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
        notes: data.notes || '',
    };
    await App.storage.put('cards', card);
    App.cards.push(card);
    if (window.CloudSync) window.CloudSync.upsertCard(card);
    return card;
}

async function updateCard(card) {
    card.modifiedAt = nowISO();
    await App.storage.put('cards', card);
    const idx = App.cards.findIndex(c => c.id === card.id);
    if (idx !== -1) App.cards[idx] = card;
    if (window.CloudSync) window.CloudSync.upsertCard(card);
    return card;
}

async function deleteCard(id) {
    await App.storage.delete('cards', id);
    App.cards = App.cards.filter(c => c.id !== id);
    if (window.CloudSync) window.CloudSync.deleteCard(id);
}

// ================================================================
//  FILE IMPORT & EXPORT (.CSV / .TXT / .TSV)
// ================================================================

async function importCardsFromFile(file, deckId) {
    if (!file) return;
    const text = await file.text();
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    let importedCount = 0;

    for (const line of lines) {
        let front = '';
        let back = '';
        let tags = [];

        // Detect separator: Semicolon > Tab > Comma
        if (line.includes(';')) {
            const parts = line.split(';');
            front = parts[0].trim();
            back = parts[1] ? parts[1].trim() : '';
            if (parts[2]) tags = parts[2].split(',').map(t => t.trim());
        } else if (line.includes('\t')) {
            const parts = line.split('\t');
            front = parts[0].trim();
            back = parts[1] ? parts[1].trim() : '';
            if (parts[2]) tags = parts[2].split(',').map(t => t.trim());
        } else if (line.includes(',')) {
            const parts = line.split(',');
            front = parts[0].trim();
            back = parts.slice(1).join(',').trim();
        }

        if (front && back) {
            await createCard({ front, back, deckId, tags });
            importedCount++;
        }
    }

    showToast(`Successfully imported ${importedCount} cards into deck!`, 'success');
    renderApp();
}

function exportDeckToFile(deckId) {
    const deck = App.decks.find(d => d.id === deckId);
    if (!deck) return;
    const descendantIds = getDescendantIds(deckId);
    const deckCards = App.cards.filter(c => descendantIds.includes(c.deckId));

    if (deckCards.length === 0) {
        showToast('No cards to export in this deck.', 'info');
        return;
    }

    const lines = deckCards.map(c => `${c.front};${c.back};${(c.tags || []).join(',')}`);
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${deck.name.replace(/::/g, '_')}_flashcards.txt`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Exported ${deckCards.length} cards to ${a.download}`, 'success');
}

// ================================================================
//  AUTHENTIC ANKI REVIEW FLOW & SESSIONS
// ================================================================

function startReview(deckId) {
    App.currentDeckId = deckId;
    const descendantIds = getDescendantIds(deckId);
    const allCards = App.cards.filter(c => descendantIds.includes(c.deckId) && !c.suspended && !c.buried);
    const now = new Date();

    // Separate queues
    App.sessionNewQueue = allCards.filter(c => c.state === 'new').map(c => c.id);
    App.sessionReviewQueue = allCards.filter(c => c.state === 'review' && new Date(c.due) <= now).map(c => c.id);
    App.learningPool = new Set(allCards.filter(c => (c.state === 'learning' || c.state === 'relearning')).map(c => c.id));

    const totalDue = App.sessionNewQueue.length + App.sessionReviewQueue.length + App.learningPool.size;
    if (totalDue === 0) {
        showToast('No cards due in this deck! Excellent job.', 'info');
        return;
    }

    App.isReviewActive = true;
    App.sessionStats = { total: 0, again: 0, hard: 0, good: 0, easy: 0 };
    App.sessionElapsedSeconds = 0;

    // Start Timer
    if (App.sessionTimerInterval) clearInterval(App.sessionTimerInterval);
    App.sessionTimerInterval = setInterval(() => {
        App.sessionElapsedSeconds++;
        const timerEl = document.getElementById('reviewTimerDisplay');
        if (timerEl) timerEl.textContent = formatTimeMMSS(App.sessionElapsedSeconds);
    }, 1000);

    const overlay = document.getElementById('reviewOverlay');
    overlay.classList.add('active');

    renderReviewCard();
}

function getNextReviewCard() {
    const now = new Date();

    // 1. Intraday learning cards due now (Red)
    for (const id of App.learningPool) {
        const card = App.cards.find(c => c.id === id);
        if (card && new Date(card.due) <= now) {
            return card;
        }
    }

    // 2. Review cards due (Green)
    while (App.sessionReviewQueue.length > 0) {
        const id = App.sessionReviewQueue[0];
        const card = App.cards.find(c => c.id === id);
        if (card && card.state === 'review' && new Date(card.due) <= now) {
            return card;
        }
        App.sessionReviewQueue.shift();
    }

    // 3. New cards (Blue)
    while (App.sessionNewQueue.length > 0) {
        const id = App.sessionNewQueue[0];
        const card = App.cards.find(c => c.id === id);
        if (card && card.state === 'new') {
            return card;
        }
        App.sessionNewQueue.shift();
    }

    // 4. Pending learning cards in the future
    if (App.learningPool.size > 0) {
        let soonest = null;
        let soonestTime = Infinity;
        for (const id of App.learningPool) {
            const card = App.cards.find(c => c.id === id);
            if (card) {
                const t = new Date(card.due).getTime();
                if (t < soonestTime) {
                    soonestTime = t;
                    soonest = card;
                }
            }
        }
        return { waiting: true, card: soonest, dueTime: soonestTime };
    }

    return null;
}

function renderReviewCard() {
    if (!App.isReviewActive) return;

    if (App.waitingInterval) {
        clearInterval(App.waitingInterval);
        App.waitingInterval = null;
    }

    const next = getNextReviewCard();

    // No cards left at all -> End Session
    if (!next) {
        endReviewSession();
        return;
    }

    // Waiting Screen State
    if (next.waiting) {
        document.getElementById('cardDisplay').style.display = 'none';
        document.getElementById('waitingScreen').classList.remove('hidden');
        document.getElementById('showAnswerSection').classList.add('hidden');
        document.getElementById('ratingButtonsSection').classList.add('hidden');

        const updateCountdown = () => {
            const remainingSecs = Math.max(0, Math.round((next.dueTime - Date.now()) / 1000));
            document.getElementById('waitingCountdown').textContent = formatTimeMMSS(remainingSecs);
            if (remainingSecs <= 0) {
                clearInterval(App.waitingInterval);
                renderReviewCard();
            }
        };
        updateCountdown();
        App.waitingInterval = setInterval(updateCountdown, 1000);

        document.getElementById('studyAheadBtn').onclick = () => {
            clearInterval(App.waitingInterval);
            App.currentCardId = next.card.id;
            displayCardQuestion(next.card);
        };
        return;
    }

    // Normal Card State
    App.currentCardId = next.id;
    displayCardQuestion(next);
}

function displayCardQuestion(card) {
    document.getElementById('cardDisplay').style.display = 'flex';
    document.getElementById('waitingScreen').classList.add('hidden');

    // Set Question
    document.getElementById('reviewQuestion').textContent = card.front;

    // Reset Answer Area
    document.getElementById('reviewAnswerContainer').classList.add('hidden');
    document.getElementById('reviewDivider').classList.add('hidden');
    document.getElementById('reviewAnswer').textContent = '';

    // Show Answer Button in Bottom Bar
    document.getElementById('showAnswerSection').classList.remove('hidden');
    document.getElementById('ratingButtonsSection').classList.add('hidden');

    // Update Header Counts
    updateReviewHeader();
}

function showAnswer() {
    const card = App.cards.find(c => c.id === App.currentCardId);
    if (!card) return;

    // Reveal Answer
    document.getElementById('reviewAnswer').textContent = card.back;
    document.getElementById('reviewAnswerContainer').classList.remove('hidden');
    document.getElementById('reviewDivider').classList.remove('hidden');

    // Switch Bottom Bar to Rating Buttons
    document.getElementById('showAnswerSection').classList.add('hidden');
    document.getElementById('ratingButtonsSection').classList.remove('hidden');

    // Calculate Dynamic Button Intervals
    const preview = previewIntervals(card);
    document.getElementById('againInterval').textContent = preview.again;
    document.getElementById('hardInterval').textContent = preview.hard;
    document.getElementById('goodInterval').textContent = preview.good;
    document.getElementById('easyInterval').textContent = preview.easy;
}

async function rateCard(rating) {
    if (!App.isReviewActive) return;
    const card = App.cards.find(c => c.id === App.currentCardId);
    if (!card) return;

    const oldState = card.state;
    const result = scheduleCard(card, rating);

    card.state = result.state;
    card.interval = result.interval;
    card.ease = result.ease;
    card.reps = result.reps;
    card.lapses = result.lapses;
    card.due = result.due;
    card.lastReview = nowISO();
    if (result.state === 'suspended') card.suspended = true;

    // Log History
    const historyEntry = {
        cardId: card.id,
        timestamp: nowISO(),
        rating: ['Again', 'Hard', 'Good', 'Easy'][rating],
        ratingValue: rating,
        oldState,
        newState: card.state,
    };
    await App.storage.put('history', historyEntry);
    App.history.push(historyEntry);
    if (window.CloudSync) window.CloudSync.logReview(historyEntry);

    // Update session metrics
    App.sessionStats.total++;
    await updateCard(card);

    // Update dynamic queue pools
    if (card.state === 'learning' || card.state === 'relearning') {
        App.learningPool.add(card.id);
        App.sessionNewQueue = App.sessionNewQueue.filter(id => id !== card.id);
        App.sessionReviewQueue = App.sessionReviewQueue.filter(id => id !== card.id);
    } else {
        App.learningPool.delete(card.id);
        App.sessionNewQueue = App.sessionNewQueue.filter(id => id !== card.id);
        App.sessionReviewQueue = App.sessionReviewQueue.filter(id => id !== card.id);
    }

    updateStreakAndGoal();
    renderReviewCard();
}

function updateReviewHeader() {
    const deck = App.decks.find(d => d.id === App.currentDeckId);
    if (deck) document.getElementById('reviewDeckName').textContent = getLocalName(deck.name);

    const counts = getCardCounts(App.currentDeckId);
    document.getElementById('reviewBlueCount').textContent = counts.blue;
    document.getElementById('reviewRedCount').textContent = counts.red;
    document.getElementById('reviewGreenCount').textContent = counts.green;

    const totalRemaining = App.sessionNewQueue.length + App.sessionReviewQueue.length + App.learningPool.size;
    document.getElementById('reviewProgressText').textContent = `${App.sessionStats.total} done · ${totalRemaining} left`;
}

function endReviewSession() {
    App.isReviewActive = false;
    if (App.sessionTimerInterval) clearInterval(App.sessionTimerInterval);
    if (App.waitingInterval) clearInterval(App.waitingInterval);

    document.getElementById('reviewOverlay').classList.remove('active');
    showToast(`🎉 Deck completed! You reviewed ${App.sessionStats.total} cards today.`, 'success');
    renderApp();
}

// ================================================================
//  ANKI ACTIVITY HEATMAP (365 DAYS)
// ================================================================

function renderActivityHeatmap() {
    const container = document.getElementById('activityHeatmap');
    if (!container) return;
    container.innerHTML = '';

    // Aggregate reviews by date YYYY-MM-DD
    const countsByDate = {};
    App.history.forEach(h => {
        if (h.timestamp) {
            const d = h.timestamp.split('T')[0];
            countsByDate[d] = (countsByDate[d] || 0) + 1;
        }
    });

    const today = new Date();
    const totalDays = 364; // 52 weeks
    const startDate = new Date(today);
    startDate.setDate(today.getDate() - totalDays);

    let daysStudied = 0;
    let totalReviews = 0;

    // Build 52 weeks
    let currentWeekEl = document.createElement('div');
    currentWeekEl.className = 'heatmap-week';

    for (let i = 0; i <= totalDays; i++) {
        const cur = new Date(startDate);
        cur.setDate(startDate.getDate() + i);
        const dateStr = cur.toISOString().split('T')[0];
        const count = countsByDate[dateStr] || 0;

        if (count > 0) {
            daysStudied++;
            totalReviews += count;
        }

        let lvl = 'lvl-0';
        if (count >= 30) lvl = 'lvl-4';
        else if (count >= 16) lvl = 'lvl-3';
        else if (count >= 6) lvl = 'lvl-2';
        else if (count >= 1) lvl = 'lvl-1';

        const cell = document.createElement('div');
        cell.className = `heatmap-cell ${lvl}`;
        cell.title = `${count} reviews on ${cur.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
        currentWeekEl.appendChild(cell);

        if (cur.getDay() === 6 || i === totalDays) {
            container.appendChild(currentWeekEl);
            currentWeekEl = document.createElement('div');
            currentWeekEl.className = 'heatmap-week';
        }
    }

    document.getElementById('heatmapDaysStudied').textContent = daysStudied;
    document.getElementById('heatmapTotalReviews').textContent = totalReviews;
    document.getElementById('totalReviewsLogged').textContent = totalReviews;
}

// ================================================================
//  STREAK & GOAL TRACKING
// ================================================================

function updateStreakAndGoal() {
    const today = todayStr();
    const last = App.settings.lastStudyDate;
    const goal = App.settings.dailyGoal || 20;

    if (last !== today) {
        const gap = last ? daysBetween(today, last) : 999;
        if (gap === 1) {
            App.settings.streak = (App.settings.streak || 0) + 1;
        } else if (gap > 1) {
            App.settings.streak = 1;
        }
        App.settings.bestStreak = Math.max(App.settings.bestStreak || 0, App.settings.streak);
        App.settings.lastStudyDate = today;
        App.settings.reviewedToday = 1;
    } else {
        App.settings.reviewedToday = (App.settings.reviewedToday || 0) + 1;
    }

    if (App.settings.reviewedToday >= goal && !App.settings.goalMetToday) {
        App.settings.goalMetToday = true;
        App.settings.goalStreak = (App.settings.goalStreak || 0) + 1;
        showToast('🎯 Daily Goal Achieved! Keep up the momentum.', 'success');
    }

    App.storage.put('settings', { key: 'app_settings', ...App.settings });
    if (window.CloudSync) window.CloudSync.syncSettings(App.settings);
}

// ================================================================
//  REAL GOOGLE GEMINI AI FLASHCARD GENERATION
// ================================================================

async function generateAiFlashcards(promptText, count = 10) {
    const config = window.AppConfig ? window.AppConfig.get() : {};
    const apiKey = config.geminiApiKey ? config.geminiApiKey.trim() : '';

    if (!apiKey) {
        throw new Error('Gemini API Key is required. Please enter your free API key at the top of the AI Generator.');
    }

    const systemInstruction = `You are a world-class spaced repetition expert and tutor.
Your goal is to extract the core concepts, mechanisms, definitions, formulas, and key facts from the provided text and convert them into high-yield, atomic Anki flashcards.

Rules for high quality flashcards:
1. Minimum Information Principle: Each flashcard must test exactly ONE atomic concept, mechanism, definition, formula, or relationship.
2. Front (Question): Clear, direct, and unambiguous. Ask specific questions (e.g. "What is the function of X?", "Why does Y occur during Z?", "What is the formula for A?"). Avoid overly broad or vague prompts.
3. Back (Answer): Concise, accurate, and direct (1-3 sentences or bullet points). Do not write essays.
4. Output Schema: Return a valid JSON array of objects with keys "front", "back", and "tags".
Example:
[
  {"front": "Where does glycolysis occur within the eukaryotic cell?", "back": "In the cytoplasm (cytosol).", "tags": ["biology", "cellular-respiration"]},
  {"front": "What is the net ATP yield produced per glucose molecule during glycolysis?", "back": "2 net ATP (4 produced, 2 consumed).", "tags": ["biology", "biochemistry"]}
]`;

    const userPrompt = `Generate exactly ${count} high-yield flashcards from this text:\n\n"""\n${promptText}\n"""`;

    // High-performance Gemini Flash Models (prioritizing latest flagship 3.7 Flash)
    const models = [
        'gemini-3.7-flash',
        'gemini-2.5-flash',
        'gemini-2.0-flash',
        'gemini-1.5-flash-latest'
    ];
    let lastError = null;

    for (const model of models) {
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [
                        { role: 'user', parts: [{ text: `${systemInstruction}\n\n${userPrompt}` }] }
                    ],
                    generationConfig: {
                        responseMimeType: "application/json",
                        temperature: 0.3
                    }
                })
            });

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData?.error?.message || `API HTTP ${response.status}`);
            }

            const data = await response.json();
            let textContent = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (textContent) {
                // Strip markdown fences if present
                textContent = textContent.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```$/, '');
                const parsed = JSON.parse(textContent);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    return parsed;
                }
            }
        } catch (e) {
            console.warn(`Model ${model} attempt failed:`, e);
            lastError = e;
        }
    }

    throw new Error(lastError ? lastError.message : 'Unable to generate flashcards. Please check your Gemini API key.');
}

// ================================================================
//  UI RENDERING & EVENT LISTENERS
// ================================================================

function renderDecks() {
    const container = document.getElementById('deckTreeContainer');
    const emptyState = document.getElementById('emptyDeckState');
    if (!container) return;
    container.innerHTML = '';

    if (App.decks.length === 0) {
        emptyState.classList.remove('hidden');
        return;
    }
    emptyState.classList.add('hidden');

    // Sort decks hierarchically
    const sortedDecks = [...App.decks].sort((a, b) => a.name.localeCompare(b.name));

    sortedDecks.forEach(deck => {
        const counts = getCardCounts(deck.id);
        const depth = (deck.name.match(/::/g) || []).length;

        const cardEl = document.createElement('div');
        cardEl.className = 'deck-item-card';
        cardEl.style.marginLeft = `${depth * 20}px`;
        cardEl.setAttribute('data-deck-id', deck.id);

        cardEl.innerHTML = `
            <div class="deck-item-left">
                <i class="fas fa-folder" style="color:var(--primary);"></i>
                <span class="deck-name">${getLocalName(deck.name)}</span>
            </div>
            <div class="deck-item-right">
                <div class="deck-badges">
                    <span class="count-pill blue" title="New">${counts.blue}</span>
                    <span class="count-pill red" title="Learning">${counts.red}</span>
                    <span class="count-pill green" title="Due">${counts.green}</span>
                </div>
                <button class="btn-study-deck" data-study="${deck.id}">
                    <i class="fas fa-play"></i> Study
                </button>
                <button class="deck-menu-btn" data-menu="${deck.id}" title="Deck Options">
                    <i class="fas fa-ellipsis-v"></i>
                </button>
            </div>
        `;

        // Click to study
        cardEl.querySelector('.deck-item-left').addEventListener('click', () => startReview(deck.id));
        cardEl.querySelector('[data-study]').addEventListener('click', (e) => {
            e.stopPropagation();
            startReview(deck.id);
        });

        // 3-dots Menu Button
        cardEl.querySelector('[data-menu]').addEventListener('click', (e) => {
            e.stopPropagation();
            openDeckContextMenu(deck.id, e);
        });

        // Right-Click Context Menu
        cardEl.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            openDeckContextMenu(deck.id, e);
        });

        // Long Press for Touch Devices
        let pressTimer = null;
        cardEl.addEventListener('touchstart', (e) => {
            pressTimer = setTimeout(() => {
                openDeckContextMenu(deck.id, e.touches[0]);
            }, 500);
        }, { passive: true });

        cardEl.addEventListener('touchend', () => clearTimeout(pressTimer));
        cardEl.addEventListener('touchmove', () => clearTimeout(pressTimer));

        container.appendChild(cardEl);
    });

    // Populate dropdowns in modals
    populateDeckDropdowns();
}

function openDeckContextMenu(deckId, event) {
    App.contextMenuDeckId = deckId;
    const deck = App.decks.find(d => d.id === deckId);
    if (!deck) return;

    const menu = document.getElementById('deckContextMenu');
    document.getElementById('contextMenuDeckTitle').textContent = deck.name;

    // Position menu near cursor/tap
    const x = Math.min(window.innerWidth - 220, (event.clientX || event.pageX || 100));
    const y = Math.min(window.innerHeight - 280, (event.clientY || event.pageY || 100));

    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.classList.remove('hidden');
}

function hideDeckContextMenu() {
    const menu = document.getElementById('deckContextMenu');
    if (menu) menu.classList.add('hidden');
}

function populateDeckDropdowns() {
    const selects = [
        document.getElementById('addCardDeckSelect'),
        document.getElementById('aiGenDeckSelect'),
        document.getElementById('browserDeckFilter'),
        document.getElementById('editCardDeckSelect')
    ];

    selects.forEach(select => {
        if (!select) return;
        const currentVal = select.value;
        select.innerHTML = select.id === 'browserDeckFilter' ? '<option value="">All Decks</option>' : '';
        App.decks.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.id;
            opt.textContent = d.name;
            select.appendChild(opt);
        });
        if (currentVal && App.decks.some(d => d.id === currentVal)) {
            select.value = currentVal;
        } else if (App.decks.length > 0 && select.id !== 'browserDeckFilter') {
            select.value = App.decks[0].id;
        }
    });
}

function renderDashboard() {
    const s = App.settings;
    document.getElementById('dailyStreakDisplay').textContent = s.streak || 0;
    document.getElementById('goalStreakDisplay').textContent = s.goalStreak || 0;
    document.getElementById('bestStreakDisplay').textContent = s.bestStreak || 0;

    const goal = s.dailyGoal || 20;
    const reviewed = s.reviewedToday || 0;
    document.getElementById('dailyGoalPill').textContent = `${reviewed} / ${goal} cards`;

    const progressPct = Math.min(100, Math.round((reviewed / goal) * 100));
    document.getElementById('goalProgressBar').style.width = `${progressPct}%`;

    const remaining = Math.max(0, goal - reviewed);
    document.getElementById('goalRemainingText').textContent = remaining === 0 
        ? '🎉 You have achieved your daily goal!' 
        : `${remaining} more cards left to reach your goal today.`;

    document.getElementById('totalCollectionCards').textContent = App.cards.length;

    // Calculate Retention Rate from history
    const totalReviews = App.history.length;
    const correctReviews = App.history.filter(h => h.ratingValue >= 2).length;
    const retentionRate = totalReviews > 0 ? Math.round((correctReviews / totalReviews) * 100) : 100;
    document.getElementById('retentionRateDisplay').textContent = `${retentionRate}%`;

    renderActivityHeatmap();
}

function renderBrowser() {
    const query = (document.getElementById('browserSearchInput')?.value || '').toLowerCase();
    const filterDeckId = document.getElementById('browserDeckFilter')?.value || '';
    const container = document.getElementById('browserCardList');
    if (!container) return;
    container.innerHTML = '';

    let filtered = App.cards.filter(c => {
        if (filterDeckId && c.deckId !== filterDeckId) return false;
        if (!query) return true;
        const qMatch = (c.front || '').toLowerCase().includes(query);
        const aMatch = (c.back || '').toLowerCase().includes(query);
        const tMatch = (c.tags || []).some(t => t.toLowerCase().includes(query));
        return qMatch || aMatch || tMatch;
    });

    document.getElementById('browserCardCount').textContent = `${filtered.length} cards found`;

    filtered.slice(0, 100).forEach(card => {
        const item = document.createElement('div');
        item.className = 'browser-card-item';
        item.innerHTML = `
            <div class="browser-card-text">
                <div class="browser-card-front">${card.front}</div>
                <div class="browser-card-back">${card.back}</div>
            </div>
            <div class="browser-card-meta">
                <span class="count-pill ${card.state === 'new' ? 'blue' : card.state === 'learning' ? 'red' : 'green'}">
                    ${card.state}
                </span>
                <i class="fas fa-edit" style="color:var(--text-muted);"></i>
            </div>
        `;
        item.addEventListener('click', () => openEditCardModal(card));
        container.appendChild(item);
    });
}

function openEditCardModal(card) {
    document.getElementById('editCardId').value = card.id;
    document.getElementById('editCardFront').value = card.front;
    document.getElementById('editCardBack').value = card.back;
    document.getElementById('editCardTags').value = (card.tags || []).join(', ');
    document.getElementById('editCardDeckSelect').value = card.deckId;
    document.getElementById('editCardModal').classList.remove('hidden');
}

function renderApp() {
    renderDecks();
    renderDashboard();
    renderBrowser();
}

// ================================================================
//  EVENT LISTENERS & MODAL HANDLERS
// ================================================================

function setupEventListeners() {
    // Hide Context Menu on outside click
    document.addEventListener('click', hideDeckContextMenu);

    // Navigation Tabs
    document.querySelectorAll('#bottomNav .nav-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#bottomNav .nav-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            btn.classList.add('active');
            const tabId = btn.getAttribute('data-tab');
            document.getElementById(tabId)?.classList.add('active');
            if (tabId === 'dashboard') renderDashboard();
            if (tabId === 'browser') renderBrowser();
        });
    });

    // Theme Toggle
    document.getElementById('themeBtn')?.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme');
        const next = current === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        App.settings.theme = next;
        App.storage.put('settings', { key: 'app_settings', ...App.settings });
    });

    // Create Deck
    document.getElementById('createDeckBtn')?.addEventListener('click', async () => {
        const input = document.getElementById('newDeckInput');
        if (input && input.value.trim()) {
            await createDeck(input.value);
            input.value = '';
            showToast('Deck created successfully!', 'success');
            renderDecks();
        }
    });

    // Add Card Modal Trigger
    document.getElementById('openAddCardBtn')?.addEventListener('click', () => {
        populateDeckDropdowns();
        document.getElementById('addCardModal').classList.remove('hidden');
        document.getElementById('addCardFront').focus();
    });

    // AI Gen Modal Trigger & Key Status
    const refreshAiKeyStatus = () => {
        const config = window.AppConfig ? window.AppConfig.get() : {};
        const statusEl = document.getElementById('aiKeyStatusText');
        const inputEl = document.getElementById('aiModalApiKeyInput');
        if (config.geminiApiKey) {
            if (statusEl) {
                statusEl.innerHTML = '<strong style="color:var(--accent);">🟢 Active &amp; Connected</strong>';
            }
            if (inputEl) inputEl.value = config.geminiApiKey;
        } else {
            if (statusEl) {
                statusEl.innerHTML = '<span style="color:var(--orange); font-weight:600;">⚠️ Key required for real Gemini generation</span>';
            }
            if (inputEl) inputEl.value = '';
        }
    };

    document.getElementById('openAiGenBtn')?.addEventListener('click', () => {
        populateDeckDropdowns();
        refreshAiKeyStatus();
        document.getElementById('aiGenModal').classList.remove('hidden');
    });

    document.getElementById('saveAiModalKeyBtn')?.addEventListener('click', () => {
        const inputEl = document.getElementById('aiModalApiKeyInput');
        const key = inputEl ? inputEl.value.trim() : '';
        if (!key) {
            showToast('Please paste a valid Gemini API key.', 'error');
            return;
        }
        const currentConfig = window.AppConfig ? window.AppConfig.get() : {};
        window.AppConfig.save({ ...currentConfig, geminiApiKey: key });
        refreshAiKeyStatus();
        showToast('Gemini API Key saved! You are now connected to real Gemini AI.', 'success');
    });

    // Auth Modal Trigger
    document.getElementById('userProfileBtn')?.addEventListener('click', () => {
        document.getElementById('authModal').classList.remove('hidden');
    });

    // Modal Close Buttons
    document.querySelectorAll('[data-close]').forEach(btn => {
        btn.addEventListener('click', () => {
            const modalId = btn.getAttribute('data-close');
            document.getElementById(modalId)?.classList.add('hidden');
        });
    });

    // Deck Context Menu Actions
    document.getElementById('ctxStudyDeck')?.addEventListener('click', () => {
        if (App.contextMenuDeckId) startReview(App.contextMenuDeckId);
    });

    document.getElementById('ctxAddCard')?.addEventListener('click', () => {
        if (App.contextMenuDeckId) {
            populateDeckDropdowns();
            document.getElementById('addCardDeckSelect').value = App.contextMenuDeckId;
            document.getElementById('addCardModal').classList.remove('hidden');
            document.getElementById('addCardFront').focus();
        }
    });

    document.getElementById('ctxCreateSubdeck')?.addEventListener('click', async () => {
        const parentDeck = App.decks.find(d => d.id === App.contextMenuDeckId);
        if (!parentDeck) return;
        const subdeckName = prompt(`Create subdeck under "${parentDeck.name}":\n(e.g. Topic1)`);
        if (subdeckName && subdeckName.trim()) {
            await createDeck(`${parentDeck.name}::${subdeckName.trim()}`);
            showToast('Subdeck created!', 'success');
            renderDecks();
        }
    });

    document.getElementById('ctxImportCards')?.addEventListener('click', () => {
        App.targetImportDeckId = App.contextMenuDeckId;
        const fileInput = document.getElementById('importFileInput');
        if (fileInput) {
            fileInput.value = '';
            fileInput.click();
        }
    });

    document.getElementById('importFileInput')?.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file && App.targetImportDeckId) {
            importCardsFromFile(file, App.targetImportDeckId);
        }
    });

    document.getElementById('ctxExportDeck')?.addEventListener('click', () => {
        if (App.contextMenuDeckId) exportDeckToFile(App.contextMenuDeckId);
    });

    document.getElementById('ctxRenameDeck')?.addEventListener('click', async () => {
        const deck = App.decks.find(d => d.id === App.contextMenuDeckId);
        if (!deck) return;
        const newName = prompt('Enter new deck name:', deck.name);
        if (newName && newName.trim() && newName.trim() !== deck.name) {
            await renameDeck(deck.id, newName.trim());
        }
    });

    document.getElementById('ctxDeleteDeck')?.addEventListener('click', async () => {
        const deck = App.decks.find(d => d.id === App.contextMenuDeckId);
        if (!deck) return;
        if (confirm(`Are you sure you want to delete "${deck.name}" and all its cards?`)) {
            await deleteDeck(deck.id);
        }
    });

    // Add Card Actions
    const handleSaveCard = async (andAnother = false) => {
        const front = document.getElementById('addCardFront').value.trim();
        const back = document.getElementById('addCardBack').value.trim();
        const deckId = document.getElementById('addCardDeckSelect').value;
        const tags = document.getElementById('addCardTags').value;

        if (!front || !back) {
            showToast('Please enter both Front (Question) and Back (Answer).', 'error');
            return;
        }

        await createCard({ front, back, deckId, tags });
        showToast('Card added!', 'success');

        if (andAnother) {
            document.getElementById('addCardFront').value = '';
            document.getElementById('addCardBack').value = '';
            document.getElementById('addCardFront').focus();
        } else {
            document.getElementById('addCardModal').classList.add('hidden');
            document.getElementById('addCardFront').value = '';
            document.getElementById('addCardBack').value = '';
        }
        renderApp();
    };

    document.getElementById('saveCardBtn')?.addEventListener('click', () => handleSaveCard(false));
    document.getElementById('saveAndNewCardBtn')?.addEventListener('click', () => handleSaveCard(true));

    // Edit Card Save & Delete
    document.getElementById('saveEditCardBtn')?.addEventListener('click', async () => {
        const id = document.getElementById('editCardId').value;
        const card = App.cards.find(c => c.id === id);
        if (card) {
            card.front = document.getElementById('editCardFront').value.trim();
            card.back = document.getElementById('editCardBack').value.trim();
            card.deckId = document.getElementById('editCardDeckSelect').value;
            card.tags = document.getElementById('editCardTags').value.split(',').map(t => t.trim()).filter(Boolean);
            await updateCard(card);
            showToast('Card updated!', 'success');
            document.getElementById('editCardModal').classList.add('hidden');
            renderApp();
        }
    });

    document.getElementById('deleteEditCardBtn')?.addEventListener('click', async () => {
        const id = document.getElementById('editCardId').value;
        if (confirm('Delete this card permanently?')) {
            await deleteCard(id);
            showToast('Card deleted.', 'info');
            document.getElementById('editCardModal').classList.add('hidden');
            renderApp();
        }
    });

    // AI Generation Execution
    document.getElementById('generateAiCardsBtn')?.addEventListener('click', async () => {
        const text = document.getElementById('aiGenInputText').value.trim();
        const count = parseInt(document.getElementById('aiGenCountSelect').value, 10) || 10;
        if (!text) {
            showToast('Please paste your notes or prompt.', 'error');
            return;
        }

        const btn = document.getElementById('generateAiCardsBtn');
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating Flashcards...';
        btn.disabled = true;

        try {
            App.tempAiCards = await generateAiFlashcards(text, count);
            const previewContainer = document.getElementById('aiGeneratedCardsList');
            previewContainer.innerHTML = '';

            App.tempAiCards.forEach((c, idx) => {
                const el = document.createElement('div');
                el.className = 'ai-card-preview-item';
                el.innerHTML = `
                    <div class="ai-card-q">${idx + 1}. ${c.front}</div>
                    <div class="ai-card-a">${c.back}</div>
                `;
                previewContainer.appendChild(el);
            });

            document.getElementById('aiGeneratedCount').textContent = App.tempAiCards.length;
            document.getElementById('aiGenPreviewSection').classList.remove('hidden');
            showToast(`Generated ${App.tempAiCards.length} cards! Review and import below.`, 'success');
        } catch (e) {
            showToast(e.message, 'error');
        } finally {
            btn.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> Generate Flashcards';
            btn.disabled = false;
        }
    });

    // Import AI Cards
    document.getElementById('importAllAiCardsBtn')?.addEventListener('click', async () => {
        const deckId = document.getElementById('aiGenDeckSelect').value;
        for (const cardData of App.tempAiCards) {
            await createCard({ front: cardData.front, back: cardData.back, deckId, tags: cardData.tags });
        }
        showToast(`Successfully added ${App.tempAiCards.length} cards to your deck!`, 'success');
        document.getElementById('aiGenModal').classList.add('hidden');
        document.getElementById('aiGenInputText').value = '';
        document.getElementById('aiGenPreviewSection').classList.add('hidden');
        App.tempAiCards = [];
        renderApp();
    });

    // Review Screen Actions
    document.getElementById('showBtn')?.addEventListener('click', showAnswer);
    document.getElementById('againBtn')?.addEventListener('click', () => rateCard(0));
    document.getElementById('hardBtn')?.addEventListener('click', () => rateCard(1));
    document.getElementById('goodBtn')?.addEventListener('click', () => rateCard(2));
    document.getElementById('easyBtn')?.addEventListener('click', () => rateCard(3));
    document.getElementById('exitReviewBtn')?.addEventListener('click', endReviewSession);

    // Browser Search
    document.getElementById('browserSearchInput')?.addEventListener('input', renderBrowser);
    document.getElementById('browserDeckFilter')?.addEventListener('change', renderBrowser);

    // Supabase Config Save
    document.getElementById('saveConfigBtn')?.addEventListener('click', () => {
        const url = document.getElementById('configSupabaseUrl').value.trim();
        const key = document.getElementById('configSupabaseKey').value.trim();
        const gemini = document.getElementById('configGeminiKey').value.trim();
        window.AppConfig.save({ supabaseUrl: url, supabaseAnonKey: key, geminiApiKey: gemini });
        if (window.CloudSync) window.CloudSync.init();
        showToast('Configuration saved!', 'success');
    });

    // Cloud Auth Form
    document.getElementById('tabSignInBtn')?.addEventListener('click', () => {
        document.getElementById('tabSignInBtn').classList.add('active');
        document.getElementById('tabSignUpBtn').classList.remove('active');
        document.getElementById('submitAuthBtn').textContent = 'Sign In';
    });

    document.getElementById('tabSignUpBtn')?.addEventListener('click', () => {
        document.getElementById('tabSignUpBtn').classList.add('active');
        document.getElementById('tabSignInBtn').classList.remove('active');
        document.getElementById('submitAuthBtn').textContent = 'Create Account';
    });

    document.getElementById('submitAuthBtn')?.addEventListener('click', async () => {
        const email = document.getElementById('authEmail').value.trim();
        const password = document.getElementById('authPassword').value.trim();
        const isSignUp = document.getElementById('tabSignUpBtn').classList.contains('active');
        const errBox = document.getElementById('authErrorMsg');
        errBox.classList.add('hidden');

        try {
            if (isSignUp) {
                await window.CloudSync.signUp(email, password);
                showToast('Account created! Please verify your email if required.', 'success');
            } else {
                await window.CloudSync.signIn(email, password);
                showToast('Signed in successfully! Syncing your data...', 'success');
            }
        } catch (e) {
            errBox.textContent = e.message;
            errBox.classList.remove('hidden');
        }
    });

    document.getElementById('signOutBtn')?.addEventListener('click', async () => {
        await window.CloudSync.signOut();
        showToast('Signed out.', 'info');
    });

    document.getElementById('manualSyncBtn')?.addEventListener('click', async () => {
        await window.CloudSync.pushAll({ decks: App.decks, cards: App.cards, settings: App.settings });
        await window.CloudSync.pullAll();
        showToast('Cloud database synchronized!', 'success');
    });

    // Global Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
        // If reviewing
        if (App.isReviewActive) {
            if (e.key === ' ' || e.key === 'Enter') {
                if (document.getElementById('ratingButtonsSection').classList.contains('hidden')) {
                    e.preventDefault();
                    showAnswer();
                }
            } else if (e.key === '1') {
                if (!document.getElementById('ratingButtonsSection').classList.contains('hidden')) rateCard(0);
            } else if (e.key === '2') {
                if (!document.getElementById('ratingButtonsSection').classList.contains('hidden')) rateCard(1);
            } else if (e.key === '3') {
                if (!document.getElementById('ratingButtonsSection').classList.contains('hidden')) rateCard(2);
            } else if (e.key === '4') {
                if (!document.getElementById('ratingButtonsSection').classList.contains('hidden')) rateCard(3);
            } else if (e.key === 'Escape') {
                endReviewSession();
            }
            return;
        }

        // Modal shortcuts
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            if (!document.getElementById('addCardModal').classList.contains('hidden')) {
                handleSaveCard(false);
            } else if (!document.getElementById('editCardModal').classList.contains('hidden')) {
                document.getElementById('saveEditCardBtn').click();
            }
        }

        if (e.key === 'Escape') {
            document.querySelectorAll('.modal-overlay').forEach(m => m.classList.add('hidden'));
            hideDeckContextMenu();
        }
    });
}

// ================================================================
//  MERGE CLOUD DATA ON SYNC
// ================================================================

App.mergeCloudData = async function(cloudData) {
    if (cloudData.decks && cloudData.decks.length > 0) {
        for (const cd of cloudData.decks) {
            const existing = App.decks.find(d => d.id === cd.id);
            if (!existing) {
                App.decks.push(cd);
                await App.storage.put('decks', cd);
            }
        }
    }

    if (cloudData.cards && cloudData.cards.length > 0) {
        for (const cc of cloudData.cards) {
            const existing = App.cards.find(c => c.id === cc.id);
            if (!existing) {
                App.cards.push(cc);
                await App.storage.put('cards', cc);
            }
        }
    }

    if (cloudData.history && cloudData.history.length > 0) {
        App.history = cloudData.history;
    }

    renderApp();
};

// ================================================================
//  APP INITIALIZATION
// ================================================================

async function initApp() {
    await App.storage.init();

    // Load Local Data
    App.decks = (await App.storage.getAll('decks')) || [];
    App.cards = (await App.storage.getAll('cards')) || [];
    App.history = (await App.storage.getAll('history')) || [];

    const savedSettings = await App.storage.get('settings', 'app_settings');
    if (savedSettings) App.settings = { ...DEFAULT_SETTINGS, ...savedSettings };

    // Apply saved theme
    if (App.settings.theme) {
        document.documentElement.setAttribute('data-theme', App.settings.theme);
    }

    // Default Deck if empty
    if (App.decks.length === 0) {
        await createDeck('Default');
    }

    // Setup Cloud Sync & Auth Listener
    if (window.CloudSync) {
        window.CloudSync.init();
        window.CloudSync.onUserChange((user) => {
            const statusDot = document.getElementById('cloudStatusDot');
            const userLabel = document.getElementById('userAccountLabel');
            const loggedInView = document.getElementById('authLoggedInView');
            const loggedOutView = document.getElementById('authLoggedOutView');

            if (user) {
                statusDot.className = 'status-dot online';
                userLabel.textContent = user.email ? user.email.split('@')[0] : 'Account';
                document.getElementById('currentUserEmail').textContent = user.email || '';
                loggedInView.classList.remove('hidden');
                loggedOutView.classList.add('hidden');
            } else {
                statusDot.className = 'status-dot offline';
                userLabel.textContent = 'Sign In';
                loggedInView.classList.add('hidden');
                loggedOutView.classList.remove('hidden');
            }
        });
    }

    setupEventListeners();
    renderApp();
}

window.addEventListener('DOMContentLoaded', initApp);
