// ================================================================
//  FLASHCOACH — COMPLETE APPLICATION
//  Learning Queue: AnkiDroid-accurate dynamic scheduling
// ================================================================

// ================================================================
//  HOW THE REVIEW QUEUE WORKS (AnkiDroid-accurate)
// ================================================================
//
//  Anki's queue priority order (per official docs):
//    1. Intraday learning cards that are now due   (Red, sub-day)
//    2. Review cards that are due                  (Green)
//    3. New cards                                  (Blue)
//
//  Learning cards are NEVER "completed" in a session — they stay
//  in a pending pool and are re-inserted into the front of the
//  queue when their due timestamp is reached.
//
//  Learn Ahead Limit (default 20 min in Anki):
//    When the only remaining cards are learning cards that aren't
//    due yet, show the soonest one immediately rather than blocking.
//    This matches the behavior the user described: <1m, <6m, <10m
//    means AT MOST those times, not exactly those times.
//    In practice: if nothing else is left, show it now.
//
//  Implementation:
//    - App.learningPool: Set of card IDs currently in learning state
//      during this session (persists until card graduates or session ends)
//    - On each renderReviewCard() call, we dynamically build the next
//      card to show by scanning what's due right now
//    - No static queue index — always re-evaluate on every render
//
// ================================================================

// ================================================================
//  STORAGE ENGINE
// ================================================================

const DB_NAME = 'FlashCoachDB';
const DB_VERSION = 3;

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
            localStorage.setItem(`_${store}_${data.id || data.key || data.name}`, JSON.stringify(data));
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

    async clear(store) {
        await this._ensureReady();
        if (this.db) {
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction(store, 'readwrite');
                const req = tx.objectStore(store).clear();
                req.onsuccess = () => resolve();
                req.onerror = () => reject(req.error);
            });
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
    bestStreak: 0,
    lastStudyDate: null,
    reviewedToday: 0,
    goalMetToday: false,
    totalStudyTimeToday: 0,
    totalStudyTimeWeek: 0,
    totalStudyTimeMonth: 0,
    learningSteps: [1, 6, 10],      // minutes
    graduatingInterval: 1,           // days
    easyInterval: 4,                 // days
    startingEase: 2.5,
    easyBonus: 1.3,
    lapseInterval: 0.1,
    leechThreshold: 8,
    learnAheadLimit: 20,            // minutes — show learning cards early if nothing else left
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

    // ---- Dynamic queue state ----
    // Instead of a static array + index, we track:
    //   sessionNewQueue:    ordered list of new card IDs to show (in order)
    //   sessionReviewQueue: ordered list of review card IDs to show (in order)
    //   learningPool:       Set of card IDs that were sent to learning THIS session
    //   shownNewIds:        Set of new card IDs already shown at least once
    //   shownReviewIds:     Set of review card IDs already shown at least once
    //   currentCardId:      ID of the card currently on screen
    sessionNewQueue: [],
    sessionReviewQueue: [],
    learningPool: new Set(),
    shownNewIds: new Set(),
    shownReviewIds: new Set(),
    currentCardId: null,

    session: null,
    sessionStats: { total: 0, again: 0, hard: 0, good: 0, easy: 0 },
    sessionStartTime: null,
    sessionTimerInterval: null,
    sessionElapsedSeconds: 0,
    timerPaused: false,
    isReviewActive: false,

    // Waiting screen polling
    waitingInterval: null,
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

function getCardState(card) {
    if (card.suspended) return 'suspended';
    if (card.buried) return 'buried';
    if (card.state === 'new') return 'new';
    if (card.state === 'learning' || card.state === 'relearning') return 'learning';
    if (card.state === 'review') return 'review';
    return 'unknown';
}

function getCardColor(card) {
    const state = getCardState(card);
    if (state === 'new') return 'blue';
    if (state === 'learning') return 'red';
    if (state === 'review') return 'green';
    return 'gray';
}

// ================================================================
//  SCHEDULER (SM-2)
// ================================================================

// ----------------------------------------------------------------
//  previewIntervals(card) — returns what each button will show
//  Called by showAnswer() to compute dynamic button labels.
//  Matches AnkiDroid/Anki behavior exactly:
//
//  Learning phase (new/learning/relearning):
//    Again  → learningSteps[0] minutes  (always reset to step 0)
//    Hard   → if on step 0: average of steps[0] and steps[1]
//              if on any other step: repeat current step
//    Good   → if not on last step: next step duration
//              if on last step: graduating interval (days)
//    Easy   → easyInterval (days) — NEVER changes during learning
//
//  Review phase:
//    Again  → relearning step (10m default)
//    Hard   → interval * 0.8 days (min 1)
//    Good   → interval * ease days
//    Easy   → interval * ease * easyBonus days
// ----------------------------------------------------------------

function previewIntervals(card) {
    const s = App.settings;
    const learningSteps = s.learningSteps || [1, 6, 10]; // minutes
    const cardState = card.state || 'new'; // use raw card state, not abstracted
    const reps = card.reps || 0;

    // ---- New and Learning cards ----
    if (cardState === 'new' || cardState === 'learning') {
        const stepIndex = Math.min(reps, learningSteps.length - 1);

        // Again: always reset to step 0
        const againMins = learningSteps[0];

        // Hard: step 0 → average of step[0]+step[1]; other steps → repeat current
        let hardMins;
        if (learningSteps.length === 1) {
            hardMins = learningSteps[0] * 1.5;
        } else if (stepIndex === 0) {
            hardMins = (learningSteps[0] + learningSteps[1]) / 2;
        } else {
            hardMins = learningSteps[stepIndex];
        }

        // Good: advance to next step, or graduate
        let goodLabel;
        if (stepIndex < learningSteps.length - 1) {
            goodLabel = `<${Math.round(learningSteps[stepIndex + 1])}m Good`;
        } else {
            goodLabel = `${s.graduatingInterval || 1}d Good`;
        }

        // Easy: ALWAYS fixed easyInterval — never changes during learning phase
        const easyDays = s.easyInterval || 4;

        return {
            again: `<${Math.round(againMins)}m Again`,
            hard:  `<${Math.round(hardMins)}m Hard`,
            good:  goodLabel,
            easy:  `${easyDays}d Easy`,
        };
    }

    // ---- Relearning cards (lapsed review cards in relearning phase) ----
    if (cardState === 'relearning') {
        // Single 10-minute relearning step by default
        const relearningStep = 10;
        // Good on the only relearning step → re-graduate
        const prevInterval = card.interval || 1;
        const reGradInterval = Math.max(1, Math.round(prevInterval * 0.5));
        return {
            again: `<${relearningStep}m Again`,
            hard:  `<${relearningStep}m Hard`,
            good:  `${reGradInterval}d Good`,
            easy:  `${reGradInterval}d Easy`,
        };
    }

    // ---- Review cards ----
    const interval = card.interval || 1;
    const ease = card.ease || 2.5;
    const hardDays = Math.max(1, Math.round(interval * 0.8));
    const goodDays = Math.max(hardDays + 1, Math.round(interval * ease));
    const easyDays = Math.max(goodDays + 1, Math.round(interval * ease * (s.easyBonus || 1.3)));
    return {
        again: '10m Again',
        hard:  `${hardDays}d Hard`,
        good:  `${goodDays}d Good`,
        easy:  `${easyDays}d Easy`,
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
    const learningSteps = s.learningSteps || [1, 6, 10]; // minutes

    // ---- RELEARNING (lapsed review card) ----
    // Separate from learning because it uses its own single 10-minute step
    // and re-graduates at 50% of the previous interval.
    if (state === 'relearning') {
        const relearningStep = 10; // 10 minutes
        if (rating === 0) {
            // Again — stay in relearning
            lapses++;
            reps = 0;
            interval = relearningStep / (24 * 60);
            ease = Math.max(1.3, ease - 0.2);
        } else if (rating === 1) {
            // Hard — repeat the relearning step
            interval = relearningStep / (24 * 60);
        } else if (rating === 2) {
            // Good — re-graduate at 50% of previous interval
            state = 'review';
            interval = Math.max(1, Math.round(interval * 0.5));
            reps++;
        } else if (rating === 3) {
            // Easy — re-graduate at 50% of previous interval
            state = 'review';
            interval = Math.max(1, Math.round(interval * 0.5));
            reps++;
        }
        if (!interval || interval < 1 / (24 * 60)) interval = 1 / (24 * 60);
        const due = new Date(now.getTime() + interval * 24 * 60 * 60 * 1000);
        return { state, interval, ease, reps, lapses, due: due.toISOString() };
    }

    // ---- NEW / LEARNING ----
    if (state === 'new' || state === 'learning') {
        const stepIndex = Math.min(reps, learningSteps.length - 1);

        if (rating === 0) {
            // Again — reset to step 0
            // NOTE: Anki does NOT penalize ease during the learning phase.
            // "New cards have no ease, so no matter how many times you press
            // Again or Hard, the future ease factor won't be affected."
            //  — https://faqs.ankiweb.net/what-spaced-repetition-algorithm
            lapses++;
            reps = 0;
            interval = learningSteps[0] / (24 * 60); // minutes → days
            if (state === 'new') state = 'learning';
            // ease unchanged during learning

        } else if (rating === 1) {
            // Hard:
            //   step 0 → average of step[0] and step[1]
            //   other  → repeat current step
            let hardMins;
            if (learningSteps.length === 1) {
                hardMins = learningSteps[0] * 1.5;
            } else if (stepIndex === 0) {
                hardMins = (learningSteps[0] + learningSteps[1]) / 2;
            } else {
                hardMins = learningSteps[stepIndex];
            }
            interval = hardMins / (24 * 60);
            // reps stays the same (Hard does not advance the step)
            if (state === 'new') state = 'learning';
            // ease unchanged during learning

        } else if (rating === 2) {
            // Good — advance to next step or graduate
            if (stepIndex < learningSteps.length - 1) {
                reps = stepIndex + 1;
                interval = learningSteps[reps] / (24 * 60);
                if (state === 'new') state = 'learning';
            } else {
                // Passed final step → graduate
                state = 'review';
                interval = s.graduatingInterval || 1;
                reps = learningSteps.length;
            }

        } else if (rating === 3) {
            // Easy — graduate immediately; ease unchanged per official docs
            state = 'review';
            interval = s.easyInterval || 4;
            reps = learningSteps.length;
        }

        if (!interval || interval < 1 / (24 * 60)) interval = 1 / (24 * 60);
        const due = new Date(now.getTime() + interval * 24 * 60 * 60 * 1000);

        return { state, interval, ease, reps, lapses, due: due.toISOString() };
    }

    if (state === 'review') {
        let newInterval = interval;
        let newEase = ease;
        let newLapses = lapses;

        if (rating === 0) {
            // Again — card lapses back to relearning
            newLapses++;
            newInterval = 10 / (24 * 60); // 10 minutes
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

    return {
        state: state || 'new',
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

function getDueCards(deckId = null) {
    const now = new Date();
    let result = App.cards.filter(c => {
        if (c.suspended || c.buried) return false;
        return new Date(c.due) <= now;
    });
    if (deckId) {
        const descendantIds = getDescendantIds(deckId);
        result = result.filter(c => descendantIds.includes(c.deckId));
    }
    return result;
}

function getNewCards(deckId = null) {
    let result = App.cards.filter(c => c.state === 'new' && !c.suspended && !c.buried);
    if (deckId) {
        const descendantIds = getDescendantIds(deckId);
        result = result.filter(c => descendantIds.includes(c.deckId));
    }
    return result;
}

function getLearningCards(deckId = null) {
    let result = App.cards.filter(c => (c.state === 'learning' || c.state === 'relearning') && !c.suspended && !c.buried);
    if (deckId) {
        const descendantIds = getDescendantIds(deckId);
        result = result.filter(c => descendantIds.includes(c.deckId));
    }
    return result;
}

function getReviewCards(deckId = null) {
    let result = App.cards.filter(c => c.state === 'review' && !c.suspended && !c.buried);
    if (deckId) {
        const descendantIds = getDescendantIds(deckId);
        result = result.filter(c => descendantIds.includes(c.deckId));
    }
    return result;
}

function getCardCounts(deckId) {
    const descendantIds = getDescendantIds(deckId);
    const deckCards = App.cards.filter(c => descendantIds.includes(c.deckId));
    const now = new Date();
    return {
        total: deckCards.length,
        blue: deckCards.filter(c => c.state === 'new' && !c.suspended && !c.buried).length,
        red: deckCards.filter(c => (c.state === 'learning' || c.state === 'relearning') && !c.suspended && !c.buried).length,
        green: deckCards.filter(c => c.state === 'review' && !c.suspended && !c.buried && new Date(c.due) <= now).length,
        due: deckCards.filter(c => !c.suspended && !c.buried && new Date(c.due) <= now).length,
        suspended: deckCards.filter(c => c.suspended).length,
    };
}

// ================================================================
//  DECK OPERATIONS
// ================================================================

async function createDeck(name, parentId = null) {
    let deckName = name.trim();

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

async function renameDeck(deckId, newName) {
    const deck = App.decks.find(d => d.id === deckId);
    if (!deck) return null;
    const oldName = deck.name;
    deck.name = newName.trim();
    deck.modifiedAt = nowISO();
    await App.storage.put('decks', deck);
    const deckNames = await App.storage.getAll('deckNames');
    const toRemove = deckNames.filter(d => d.name === oldName);
    for (const d of toRemove) {
        await App.storage.delete('deckNames', d.name);
    }
    await App.storage.put('deckNames', { name: deck.name });
    const children = App.decks.filter(d => d.name.startsWith(oldName + '::'));
    for (const child of children) {
        child.name = child.name.replace(oldName, deck.name);
        child.modifiedAt = nowISO();
        await App.storage.put('decks', child);
        const names = await App.storage.getAll('deckNames');
        const toRemoveChild = names.filter(d => d.name === child.name);
        for (const d of toRemoveChild) {
            await App.storage.delete('deckNames', d.name);
        }
        await App.storage.put('deckNames', { name: child.name });
    }
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
        insights.push("📉 Your retention is below 70%. Consider reviewing more frequently.");
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

// ================================================================
//  SESSION MANAGER
// ================================================================

async function saveSessionState() {
    if (!App.session) return;
    App.session.sessionNewQueue = App.sessionNewQueue;
    App.session.sessionReviewQueue = App.sessionReviewQueue;
    App.session.learningPool = Array.from(App.learningPool);
    App.session.shownNewIds = Array.from(App.shownNewIds);
    App.session.shownReviewIds = Array.from(App.shownReviewIds);
    App.session.lastActivity = nowISO();
    await App.storage.put('sessions', App.session);
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

async function completeSession() {
    if (App.session) {
        App.session.finished = true;
        App.session.lastActivity = nowISO();
        await App.storage.put('sessions', App.session);
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
//  THE DYNAMIC QUEUE — HEART OF THE FIX
// ================================================================
//
//  pickNextCard() is called every time we need to decide what card
//  to show next. It follows Anki's exact priority order:
//
//  Priority 1: Learning/relearning cards whose due time has passed
//              (sorted by due time, soonest first)
//  Priority 2: Review cards not yet shown this session
//  Priority 3: New cards not yet shown this session
//  Priority 4: Learning cards not yet due — BUT if they are the
//              ONLY remaining cards, show the soonest one anyway
//              (this is the "Learn Ahead" behaviour)
//
//  Returns: a card object, or null if truly nothing left.
//
// ================================================================

function pickNextCard() {
    const now = new Date();
    const deckId = App.currentDeckId;
    if (!deckId) return null;

    // ---- Priority 1: Learning cards that are now due ----
    const learningDueNow = getLearningCardsInSession()
        .filter(c => new Date(c.due) <= now)
        .sort((a, b) => new Date(a.due) - new Date(b.due));

    if (learningDueNow.length > 0) {
        return learningDueNow[0];
    }

    // ---- Priority 2: Review cards not yet shown ----
    const nextReview = App.sessionReviewQueue
        .map(id => getCard(id))
        .filter(c => c && !c.suspended && !c.buried && c.state === 'review')
        .find(Boolean);

    if (nextReview) {
        return nextReview;
    }

    // ---- Priority 3: New cards not yet shown ----
    const nextNew = App.sessionNewQueue
        .map(id => getCard(id))
        .filter(c => c && !c.suspended && !c.buried && c.state === 'new')
        .find(Boolean);

    if (nextNew) {
        return nextNew;
    }

    // ---- Priority 4: Learning cards not yet due (Learn Ahead) ----
    // If nothing else is available, show the soonest learning card
    // regardless of whether its interval has elapsed.
    // This matches AnkiDroid's Learn Ahead Limit behaviour.
    const learningPending = getLearningCardsInSession()
        .filter(c => new Date(c.due) > now)
        .sort((a, b) => new Date(a.due) - new Date(b.due));

    if (learningPending.length > 0) {
        return learningPending[0];
    }

    // Nothing left
    return null;
}

// Returns all cards currently tracked in the learning pool that
// are still in learning/relearning state (not graduated yet).
function getLearningCardsInSession() {
    const deckId = App.currentDeckId;
    if (!deckId) return [];
    return Array.from(App.learningPool)
        .map(id => getCard(id))
        .filter(c => c && !c.suspended && !c.buried &&
            (c.state === 'learning' || c.state === 'relearning'));
}

// How many seconds until the next learning card becomes due.
// Returns 0 if one is already due, Infinity if none in pool.
function secondsUntilNextLearning() {
    const now = new Date();
    const learningPending = getLearningCardsInSession()
        .filter(c => new Date(c.due) > now)
        .sort((a, b) => new Date(a.due) - new Date(b.due));
    if (learningPending.length === 0) return Infinity;
    return Math.max(0, Math.ceil((new Date(learningPending[0].due) - now) / 1000));
}

// True if there is absolutely nothing left (no learning, no review, no new)
function sessionIsComplete() {
    const noLearning = getLearningCardsInSession().length === 0;
    const noReview = App.sessionReviewQueue
        .map(id => getCard(id))
        .filter(c => c && !c.suspended && !c.buried && c.state === 'review')
        .length === 0;
    const noNew = App.sessionNewQueue
        .map(id => getCard(id))
        .filter(c => c && !c.suspended && !c.buried && c.state === 'new')
        .length === 0;
    return noLearning && noReview && noNew;
}

// ================================================================
//  REVIEW ENGINE
// ================================================================

async function startReviewForDeck(deckId) {
    console.log('🔹 startReviewForDeck:', deckId);
    try {
        const deck = App.decks.find(d => d.id === deckId);
        if (!deck) {
            alert('Deck not found.');
            return;
        }

        if (App.session) {
            await discardSession();
        }

        // Build initial queues
        const learningDue = getLearningCards(deckId)
            .filter(c => new Date(c.due) <= new Date())
            .sort((a, b) => new Date(a.due) - new Date(b.due));

        const reviewDue = getReviewCards(deckId)
            .filter(c => new Date(c.due) <= new Date())
            .sort((a, b) => new Date(a.due) - new Date(b.due));

        const newCards = getNewCards(deckId);

        // Also pull any learning cards that exist for this deck (even not yet due)
        // so they can appear via Learn Ahead if nothing else exists
        const allLearning = getLearningCards(deckId);

        if (learningDue.length === 0 && reviewDue.length === 0 && newCards.length === 0 && allLearning.length === 0) {
            alert('No cards due in this deck. Try adding more cards or waiting for intervals to expire.');
            return;
        }

        // Reset session state
        App.currentDeckId = deckId;
        App.sessionNewQueue = newCards.map(c => c.id);
        App.sessionReviewQueue = reviewDue.map(c => c.id);
        App.learningPool = new Set(allLearning.map(c => c.id));
        // Also add any currently-due learning cards to the pool
        for (const c of learningDue) App.learningPool.add(c.id);
        App.shownNewIds = new Set();
        App.shownReviewIds = new Set();
        App.currentCardId = null;
        App.sessionStats = { total: 0, again: 0, hard: 0, good: 0, easy: 0 };
        App.sessionStartTime = Date.now();
        App.sessionElapsedSeconds = 0;
        App.timerPaused = false;
        App.isReviewActive = true;
        App.isReviewing = true;

        // Persist session
        App.session = {
            id: generateId(),
            deckId,
            createdAt: nowISO(),
            startedAt: nowISO(),
            finished: false,
            sessionNewQueue: App.sessionNewQueue,
            sessionReviewQueue: App.sessionReviewQueue,
            learningPool: Array.from(App.learningPool),
            shownNewIds: [],
            shownReviewIds: [],
            lastActivity: nowISO(),
        };
        await App.storage.put('sessions', App.session);

        enterReviewMode();
        renderReviewCard();
        startReviewTimer();
    } catch (err) {
        console.error('❌ startReviewForDeck error:', err);
        alert('An error occurred while starting review. Check console for details.');
    }
}

function enterReviewMode() {
    const overlay = document.getElementById('reviewOverlay');
    if (overlay) {
        overlay.style.display = 'flex';
        overlay.classList.add('active');
    }
}

function exitReviewMode() {
    stopWaitingScreen();
    const overlay = document.getElementById('reviewOverlay');
    if (overlay) {
        overlay.classList.remove('active');
        overlay.style.display = '';
    }
    stopReviewTimer();
    App.isReviewActive = false;
    App.isReviewing = false;
    if (App.session) {
        saveSessionState();
    }
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.getElementById('decks').classList.add('active');
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.nav-btn[data-tab="decks"]').forEach(b => b.classList.add('active'));
    updateUI();
}

function startReviewTimer() {
    if (App.sessionTimerInterval) clearInterval(App.sessionTimerInterval);
    App.sessionStartTime = Date.now() - (App.sessionElapsedSeconds * 1000);
    App.sessionTimerInterval = setInterval(() => {
        if (!App.timerPaused && App.isReviewActive) {
            App.sessionElapsedSeconds = Math.floor((Date.now() - App.sessionStartTime) / 1000);
            const el = document.getElementById('reviewTimerDisplay');
            if (el) el.textContent = `⏱️ ${formatTimeMMSS(App.sessionElapsedSeconds)}`;
        }
    }, 500);
}

function stopReviewTimer() {
    if (App.sessionTimerInterval) {
        clearInterval(App.sessionTimerInterval);
        App.sessionTimerInterval = null;
    }
}

function resumeReview() {
    const session = App.session;
    if (!session) return;

    App.currentDeckId = session.deckId;
    App.sessionNewQueue = session.sessionNewQueue || [];
    App.sessionReviewQueue = session.sessionReviewQueue || [];
    App.learningPool = new Set(session.learningPool || []);
    App.shownNewIds = new Set(session.shownNewIds || []);
    App.shownReviewIds = new Set(session.shownReviewIds || []);
    App.currentCardId = null;
    App.sessionStats = { total: 0, again: 0, hard: 0, good: 0, easy: 0 };
    App.sessionStartTime = Date.now();
    App.sessionElapsedSeconds = 0;
    App.timerPaused = false;
    App.isReviewActive = true;
    App.isReviewing = true;

    enterReviewMode();
    renderReviewCard();
    startReviewTimer();
}

// ================================================================
//  RENDER REVIEW CARD — Dynamic, Anki-accurate
// ================================================================

function renderReviewCard() {
    stopWaitingScreen(); // clear any waiting screen if running

    if (!App.isReviewActive) return;

    // Check if the session is truly complete
    if (sessionIsComplete()) {
        showSessionComplete();
        return;
    }

    const card = pickNextCard();

    if (!card) {
        // pickNextCard returned null but sessionIsComplete() was false —
        // this shouldn't happen, but be defensive
        showSessionComplete();
        return;
    }

    // If the card is a learning card not yet due (learn-ahead scenario),
    // check if we should wait or show it.
    // Anki's default: show early if it's the only thing left (we already
    // do this in pickNextCard via Priority 4). So if we got here, just show it.

    App.currentCardId = card.id;

    // Update the UI
    document.getElementById('reviewQuestion').textContent = card.front;
    document.getElementById('reviewAnswer').style.display = 'none';
    document.getElementById('reviewAnswer').textContent = '';
    document.getElementById('showBtn').classList.remove('hidden');
    document.querySelectorAll('#reviewButtons button').forEach(b => b.classList.add('hidden'));

    // Show card box, hide waiting screen
    document.getElementById('cardDisplay').style.display = '';
    document.getElementById('waitingScreen').classList.add('hidden');

    // Update progress display
    updateProgressDisplay();
    updateReviewColorCounts();
}

function showSessionComplete() {
    document.getElementById('reviewQuestion').textContent = '🎉 All cards reviewed!';
    document.getElementById('reviewAnswer').style.display = 'none';
    document.getElementById('reviewAnswer').textContent = '';
    document.getElementById('showBtn').classList.add('hidden');
    document.querySelectorAll('#reviewButtons button').forEach(b => b.classList.add('hidden'));
    document.getElementById('cardDisplay').style.display = '';
    document.getElementById('waitingScreen').classList.add('hidden');
    document.getElementById('reviewProgressText').textContent = '✅ Done!';

    stopReviewTimer();
    App.isReviewActive = false;
    completeSession();
    updateReviewColorCounts();

    setTimeout(() => {
        exitReviewMode();
    }, 2000);
}

// ================================================================
//  WAITING SCREEN — shown when learning cards aren't due yet
//  AND other cards exist that must be reviewed first.
//  (In practice with our Learn Ahead approach, this rarely shows,
//   but kept as a fallback for edge cases.)
// ================================================================

function showWaitingScreen(secondsRemaining) {
    document.getElementById('cardDisplay').style.display = 'none';
    document.getElementById('waitingScreen').classList.remove('hidden');
    document.querySelectorAll('#reviewButtons button').forEach(b => b.classList.add('hidden'));

    const message = document.getElementById('waitingMessage');
    const countdown = document.getElementById('waitingCountdown');
    message.textContent = 'Learning card coming up...';

    function tick() {
        const secs = secondsUntilNextLearning();
        if (secs === 0 || secs === Infinity) {
            stopWaitingScreen();
            renderReviewCard();
            return;
        }
        countdown.textContent = formatTimeMMSS(secs);
    }

    tick();
    App.waitingInterval = setInterval(() => {
        const secs = secondsUntilNextLearning();
        if (secs === 0 || secs === Infinity) {
            stopWaitingScreen();
            renderReviewCard();
        } else {
            countdown.textContent = formatTimeMMSS(secs);
        }
    }, 500);
}

function stopWaitingScreen() {
    if (App.waitingInterval) {
        clearInterval(App.waitingInterval);
        App.waitingInterval = null;
    }
    const ws = document.getElementById('waitingScreen');
    if (ws) ws.classList.add('hidden');
    const cd = document.getElementById('cardDisplay');
    if (cd) cd.style.display = '';
}

// ================================================================
//  SHOW ANSWER
// ================================================================

function showAnswer() {
    const card = getCard(App.currentCardId);
    if (!card) return;

    document.getElementById('reviewAnswer').textContent = card.back;
    document.getElementById('reviewAnswer').style.display = 'block';
    document.getElementById('showBtn').classList.add('hidden');

    document.getElementById('againBtn').classList.remove('hidden');
    document.getElementById('hardBtn').classList.remove('hidden');
    document.getElementById('goodBtn').classList.remove('hidden');
    document.getElementById('easyBtn').classList.remove('hidden');

    // Compute dynamic button labels based on card's current step/state
    const preview = previewIntervals(card);
    document.getElementById('againBtn').textContent = preview.again;
    document.getElementById('hardBtn').textContent  = preview.hard;
    document.getElementById('goodBtn').textContent  = preview.good;
    document.getElementById('easyBtn').textContent  = preview.easy;
}

// ================================================================
//  RATE CARD — Core of the fix
// ================================================================

async function rateCard(rating) {
    if (!App.isReviewActive) return;
    const card = getCard(App.currentCardId);
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
    card.modifiedAt = nowISO();
    if (result.state === 'suspended') card.suspended = true;

    // Save history
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

    // Update session stats
    App.sessionStats.total++;
    if (rating === 0) App.sessionStats.again++;
    else if (rating === 1) App.sessionStats.hard++;
    else if (rating === 2) App.sessionStats.good++;
    else if (rating === 3) App.sessionStats.easy++;

    await updateCard(card);

    // ----------------------------------------------------------------
    //  UPDATE THE DYNAMIC QUEUES — THIS IS THE FIX
    // ----------------------------------------------------------------
    //
    //  Old behavior (broken): just increment an index and forget card.
    //
    //  New behavior (correct):
    //
    //  Case A: Card entered or stayed in learning state
    //    → Add it to learningPool (so pickNextCard sees it as pending)
    //    → Remove it from sessionNewQueue / sessionReviewQueue
    //      (it no longer belongs there)
    //
    //  Case B: Card graduated to review (rating=Easy on learning card)
    //    → Remove from learningPool, sessionNewQueue
    //    → Don't add to sessionReviewQueue (already reviewed this session)
    //
    //  Case C: Card was already in review and rated good/hard/easy
    //    → Remove from sessionReviewQueue (it's done for today)
    //    → Don't touch learningPool
    //
    //  Case D: Review card pressed Again → goes to relearning
    //    → Remove from sessionReviewQueue
    //    → Add to learningPool
    //
    // ----------------------------------------------------------------

    const newState = card.state;

    if (newState === 'learning' || newState === 'relearning') {
        // Card is (or stays) in learning — keep it in the pool
        App.learningPool.add(card.id);
        // Remove from static queues so it doesn't appear there again
        App.sessionNewQueue = App.sessionNewQueue.filter(id => id !== card.id);
        App.sessionReviewQueue = App.sessionReviewQueue.filter(id => id !== card.id);
    } else if (newState === 'review') {
        // Card graduated — remove from learning pool and static queues
        App.learningPool.delete(card.id);
        App.sessionNewQueue = App.sessionNewQueue.filter(id => id !== card.id);
        App.sessionReviewQueue = App.sessionReviewQueue.filter(id => id !== card.id);
    } else if (newState === 'suspended') {
        // Suspended — remove from everything
        App.learningPool.delete(card.id);
        App.sessionNewQueue = App.sessionNewQueue.filter(id => id !== card.id);
        App.sessionReviewQueue = App.sessionReviewQueue.filter(id => id !== card.id);
    } else {
        // Any other state (shouldn't happen normally) — treat as done
        App.sessionNewQueue = App.sessionNewQueue.filter(id => id !== card.id);
        App.sessionReviewQueue = App.sessionReviewQueue.filter(id => id !== card.id);
        App.learningPool.delete(card.id);
    }

    updateStreakAndStudyTime();
    await saveSessionState();
    updateUI();

    // Pick next card — this re-evaluates the full queue dynamically
    renderReviewCard();
}

// ================================================================
//  PROGRESS DISPLAY
// ================================================================

function updateProgressDisplay() {
    // Count what's left to give the user a sense of progress
    const learningCount = getLearningCardsInSession().length;
    const reviewRemaining = App.sessionReviewQueue
        .map(id => getCard(id))
        .filter(c => c && !c.suspended && !c.buried && c.state === 'review').length;
    const newRemaining = App.sessionNewQueue
        .map(id => getCard(id))
        .filter(c => c && !c.suspended && !c.buried && c.state === 'new').length;

    const total = learningCount + reviewRemaining + newRemaining;
    document.getElementById('reviewProgressText').textContent =
        `${App.sessionStats.total} done · ${total} left`;
}

function updateReviewColorCounts() {
    const deckId = App.currentDeckId;
    if (!deckId) return;

    const counts = getCardCounts(deckId);

    const blueEl = document.getElementById('reviewBlueCount');
    const redEl = document.getElementById('reviewRedCount');
    const greenEl = document.getElementById('reviewGreenCount');
    const deckNameEl = document.getElementById('reviewDeckName');

    if (blueEl) blueEl.textContent = counts.blue || 0;
    if (redEl) redEl.textContent = counts.red || 0;
    if (greenEl) greenEl.textContent = counts.green || 0;

    if (deckNameEl) {
        const deck = App.decks.find(d => d.id === deckId);
        if (deck) deckNameEl.textContent = getLocalName(deck.name);
    }
}

// ================================================================
//  STREAK DETECTION
// ================================================================

function updateStreakAndStudyTime() {
    const today = todayStr();
    const last = App.settings.lastStudyDate;
    const goal = App.settings.dailyGoal || 20;

    if (last !== today) {
        let streak = App.settings.streak || 0;
        let goalStreak = App.settings.goalStreak || 0;
        const gap = last ? daysBetween(today, last) : 999;

        if (gap === 1) {
            streak += 1;
            const metGoalYesterday = (App.settings.goalMetToday || false);
            if (metGoalYesterday) {
                goalStreak += 1;
            } else {
                goalStreak = 0;
            }
        } else {
            streak = 1;
            goalStreak = 0;
        }

        App.settings.streak = streak;
        App.settings.goalStreak = goalStreak;
        App.settings.lastStudyDate = today;
        App.settings.reviewedToday = 0;
        App.settings.goalMetToday = false;
        App.settings.totalStudyTimeToday = 0;

        App.storage.put('settings', { key: 'streak', value: streak });
        App.storage.put('settings', { key: 'goalStreak', value: goalStreak });
        App.storage.put('settings', { key: 'lastStudyDate', value: today });
        App.storage.put('settings', { key: 'reviewedToday', value: 0 });
        App.storage.put('settings', { key: 'goalMetToday', value: false });
        App.storage.put('settings', { key: 'totalStudyTimeToday', value: 0 });
    }

    const reviewedToday = (App.settings.reviewedToday || 0) + 1;
    App.settings.reviewedToday = reviewedToday;
    App.storage.put('settings', { key: 'reviewedToday', value: reviewedToday });

    if (reviewedToday >= goal && !App.settings.goalMetToday) {
        App.settings.goalMetToday = true;
        App.storage.put('settings', { key: 'goalMetToday', value: true });
    }

    const newTime = (App.settings.totalStudyTimeToday || 0) + 8;
    App.settings.totalStudyTimeToday = newTime;
    App.storage.put('settings', { key: 'totalStudyTimeToday', value: newTime });

    renderStudyTime();
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

    const dailyStreakEl = document.getElementById('dailyStreakDisplay');
    if (dailyStreakEl) dailyStreakEl.textContent = `${App.settings.streak || 0} days`;

    const goalStreakEl = document.getElementById('goalStreakDisplay');
    if (goalStreakEl) goalStreakEl.textContent = `${App.settings.goalStreak || 0} days`;

    const goalLabel = document.getElementById('goalLabel');
    if (goalLabel) goalLabel.textContent = App.settings.dailyGoal || 20;
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
        return d > now && d <= new Date(now.getTime() + 3 * 86400000);
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
    const selects = ['statsDeckSelect'];
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
        el.addEventListener('click', function () {
            const deckId = this.dataset.deckId;
            if (deckId) startReviewForDeck(deckId);
        });
    });

    container.querySelectorAll('.deck-item').forEach(el => {
        el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const deckId = el.querySelector('.deck-name')?.dataset.deckId;
            if (deckId) showDeckMenu(deckId, e.clientX || e.pageX, e.clientY || e.pageY);
        });
        let longPressTimer = null;
        el.addEventListener('touchstart', (e) => {
            longPressTimer = setTimeout(() => {
                const deckId = el.querySelector('.deck-name')?.dataset.deckId;
                if (deckId) showDeckMenu(deckId, e.touches[0].clientX, e.touches[0].clientY);
            }, 600);
        });
        el.addEventListener('touchend', () => clearTimeout(longPressTimer));
        el.addEventListener('touchmove', () => clearTimeout(longPressTimer));
    });
}

function renderTreeNodes(deckList, level = 0) {
    let html = '<ul>';
    for (const deck of deckList) {
        const children = App.decks.filter(d => d.parentId === deck.id);
        const isExpanded = App.expandedDecks[deck.id] !== undefined ? App.expandedDecks[deck.id] : false;
        const counts = getCardCounts(deck.id);
        const localName = getLocalName(deck.name);

        html += `<li>
            <div class="deck-item">
                ${children.length > 0
                    ? `<span class="arrow" data-deck-id="${deck.id}">${isExpanded ? '▼' : '▶'}</span>`
                    : `<span class="arrow" style="opacity:0;">▶</span>`}
                <span class="deck-icon"><i class="fas fa-folder"></i></span>
                <span class="deck-name" data-deck-id="${deck.id}">${localName}</span>
                <span class="badge">
                    <span class="blue-count">${counts.blue}</span>
                    <span class="red-count">${counts.red}</span>
                    <span class="green-count">${counts.green}</span>
                    <span class="total-count">(${counts.total})</span>
                </span>
                <div class="actions">
                    <button class="menu-btn" data-deck-id="${deck.id}" title="Menu"><i class="fas fa-ellipsis-v"></i></button>
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

// ================================================================
//  DECK MENU
// ================================================================

let deckMenuVisible = false;
let menuDeckId = null;

function showDeckMenu(deckId, x, y) {
    if (deckMenuVisible) hideDeckMenu();
    const deck = App.decks.find(d => d.id === deckId);
    if (!deck) return;
    menuDeckId = deckId;
    deckMenuVisible = true;

    let menu = document.getElementById('deckMenu');
    if (!menu) {
        menu = document.createElement('div');
        menu.id = 'deckMenu';
        menu.style.cssText = `
            position: fixed;
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: var(--radius);
            box-shadow: 0 4px 16px rgba(0,0,0,0.15);
            padding: 8px 0;
            z-index: 500;
            min-width: 190px;
            display: none;
        `;
        document.body.appendChild(menu);
    }

    const counts = getCardCounts(deckId);
    const dueCount = counts.due || 0;

    menu.innerHTML = `
        <button onclick="reviewFromMenu('${deckId}')" style="display:flex;align-items:center;gap:10px;width:100%;padding:10px 16px;border:none;background:none;cursor:pointer;font-size:0.9rem;color:var(--primary);font-weight:600;border-bottom:1px solid var(--border);">
            <i class="fas fa-play"></i> Review Cards ${dueCount > 0 ? '(' + dueCount + ' due)' : ''}
        </button>
        <button onclick="createSubdeckAction('${deckId}')" style="display:flex;align-items:center;gap:10px;width:100%;padding:10px 16px;border:none;background:none;cursor:pointer;font-size:0.9rem;color:var(--text);">
            <i class="fas fa-folder-plus"></i> Create Subdeck
        </button>
        <button onclick="renameDeckAction('${deckId}')" style="display:flex;align-items:center;gap:10px;width:100%;padding:10px 16px;border:none;background:none;cursor:pointer;font-size:0.9rem;color:var(--text);">
            <i class="fas fa-edit"></i> Rename Deck
        </button>
        <button onclick="importToDeck('${deckId}')" style="display:flex;align-items:center;gap:10px;width:100%;padding:10px 16px;border:none;background:none;cursor:pointer;font-size:0.9rem;color:var(--text);">
            <i class="fas fa-upload"></i> Import Cards
        </button>
        <button onclick="deleteDeckAction('${deckId}')" style="display:flex;align-items:center;gap:10px;width:100%;padding:10px 16px;border:none;background:none;cursor:pointer;font-size:0.9rem;color:var(--danger);">
            <i class="fas fa-trash"></i> Delete Deck
        </button>
    `;

    const menuWidth = 200;
    const menuHeight = 220;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let left = x;
    let top = y;

    if (left + menuWidth > viewportWidth) left = viewportWidth - menuWidth - 10;
    if (top + menuHeight > viewportHeight) top = viewportHeight - menuHeight - 10;
    if (left < 10) left = 10;
    if (top < 10) top = 10;

    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    menu.style.display = 'block';

    setTimeout(() => {
        document.addEventListener('click', hideDeckMenu);
    }, 100);
}

function hideDeckMenu() {
    const menu = document.getElementById('deckMenu');
    if (menu) menu.style.display = 'none';
    deckMenuVisible = false;
    menuDeckId = null;
    document.removeEventListener('click', hideDeckMenu);
}

function reviewFromMenu(deckId) {
    hideDeckMenu();
    startReviewForDeck(deckId);
}

async function createSubdeckAction(deckId) {
    hideDeckMenu();
    await createSubdeck(deckId);
}

async function renameDeckAction(deckId) {
    hideDeckMenu();
    const deck = App.decks.find(d => d.id === deckId);
    if (!deck) return;
    const newName = prompt(`Rename "${getLocalName(deck.name)}" to:`, deck.name);
    if (!newName || newName.trim() === deck.name) return;
    await renameDeck(deckId, newName.trim());
    updateUI();
}

async function deleteDeckAction(deckId) {
    hideDeckMenu();
    const deck = App.decks.find(d => d.id === deckId);
    if (!deck) return;
    const counts = getCardCounts(deckId);
    if (!confirm(`Delete deck "${getLocalName(deck.name)}" and all ${counts.total} cards inside it?`)) return;
    await deleteDeck(deckId);
    document.getElementById('selectedDeckInfo').style.display = 'none';
    document.getElementById('deckCardListContainer').style.display = 'none';
    updateUI();
}

// ================================================================
//  IMPORT / EXPORT
// ================================================================

async function importToDeck(deckId) {
    hideDeckMenu();
    const input = document.getElementById('importFileInput');
    input.value = '';
    input.onchange = async function () {
        const file = input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async function (ev) {
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
        };
        reader.readAsText(file);
        input.value = '';
        input.onchange = null;
    };
    input.click();
}

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
    const counts = getCardCounts(deckId);

    document.getElementById('statsRetention').innerHTML = `<strong>${getLocalName(deck.name)}</strong>: ${retention}%`;
    document.getElementById('statsReadiness').innerHTML = `<strong>${getLocalName(deck.name)}</strong>: ${readiness}/100`;
    document.getElementById('statsMaturity').innerHTML = `
        <div>🔵 New: ${counts.blue}</div>
        <div>🔴 Learning: ${counts.red}</div>
        <div>🟢 Review: ${counts.green}</div>
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
            <span style="width:50px;font-size:0.7rem;">${i === 0 ? 'Today' : 'Day ' + i}</span>
            <div style="flex:1;background:var(--border);height:4px;border-radius:2px;">
                <div style="height:100%;width:${Math.min(100, count * 8)}%;background:var(--primary);border-radius:2px;"></div>
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
        document.getElementById('goalDisplay').textContent = `Goal set to ${val} cards/day.`;
        updateUI();
        alert(`✅ Daily goal set to ${val} cards/day.`);
    }
}

// ================================================================
//  NAVIGATION
// ================================================================

function navigateTo(tab) {
    hideDeckMenu();
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    const target = document.getElementById(tab);
    if (target) target.classList.add('active');
    document.querySelectorAll(`.nav-btn[data-tab="${tab}"]`).forEach(b => b.classList.add('active'));
    if (tab === 'stats') renderStatsTab();
}

// ================================================================
//  UPDATE UI
// ================================================================

function updateUI() {
    renderStatStrip();
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
    if (session && !session.finished) {
        console.log('🔹 Resuming previous session');
        resumeReview();
    }

    const goalInput = document.getElementById('goalInput');
    if (goalInput) goalInput.value = App.settings.dailyGoal || 20;
    const goalDisplay = document.getElementById('goalDisplay');
    if (goalDisplay) goalDisplay.textContent = `Current: ${App.settings.dailyGoal || 20} cards/day.`;

    updateUI();
    setupEventListeners();
}

// ================================================================
//  EVENT LISTENERS
// ================================================================

function setupEventListeners() {
    document.querySelectorAll('#bottomNav .nav-btn').forEach(btn => {
        btn.addEventListener('click', () => navigateTo(btn.dataset.tab));
    });

    document.getElementById('themeBtn').addEventListener('click', toggleTheme);

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

    document.getElementById('showBtn').addEventListener('click', showAnswer);
    document.getElementById('againBtn').addEventListener('click', () => rateCard(0));
    document.getElementById('hardBtn').addEventListener('click', () => rateCard(1));
    document.getElementById('goodBtn').addEventListener('click', () => rateCard(2));
    document.getElementById('easyBtn').addEventListener('click', () => rateCard(3));

    document.getElementById('exitReviewBtn').addEventListener('click', () => {
        if (confirm('Exit review session? Progress will be saved.')) {
            exitReviewMode();
        }
    });

    document.getElementById('statsDeckSelect').addEventListener('change', renderStatsTab);
    document.getElementById('setGoalBtn').addEventListener('click', setGoal);
    document.getElementById('exportBtn').addEventListener('click', exportAll);

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
        document.getElementById('deckCardListContainer').style.display = 'block';
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
    });

    document.addEventListener('keydown', (e) => {
        if (!App.isReviewActive) return;
        if (e.key === '1') rateCard(0);
        else if (e.key === '2') rateCard(1);
        else if (e.key === '3') rateCard(2);
        else if (e.key === '4') rateCard(3);
        else if (e.key === ' ' || e.key === 'Space') {
            e.preventDefault();
            if (!document.getElementById('showBtn').classList.contains('hidden')) showAnswer();
        } else if (e.key === 'Escape' || e.key === 'Esc') {
            if (document.getElementById('reviewOverlay').classList.contains('active')) {
                if (confirm('Exit review session? Progress will be saved.')) {
                    exitReviewMode();
                }
            }
        }
    });

    document.getElementById('toggleCardsBtn').addEventListener('click', () => {
        const container = document.getElementById('deckCardListContainer');
        const btn = document.getElementById('toggleCardsBtn');
        if (container.style.display === 'none' || !container.style.display) {
            container.style.display = 'block';
            btn.innerHTML = '<i class="fas fa-chevron-up"></i> Hide Cards';
            showCardsInDeck(App.currentDeckId);
        } else {
            container.style.display = 'none';
            btn.innerHTML = '<i class="fas fa-list"></i> View Cards';
        }
    });

    document.getElementById('hideCardsBtn').addEventListener('click', () => {
        document.getElementById('deckCardListContainer').style.display = 'none';
        document.getElementById('toggleCardsBtn').innerHTML = '<i class="fas fa-list"></i> View Cards';
    });

    document.getElementById('importToDeckBtn').addEventListener('click', () => {
        if (App.currentDeckId) importToDeck(App.currentDeckId);
    });

    document.getElementById('addCardToDeckBtn').addEventListener('click', () => {
        if (App.currentDeckId) addCardToDeck(App.currentDeckId);
    });
}

// ================================================================
//  CARD ACTIONS
// ================================================================

async function addCardToDeck(deckId) {
    const front = prompt('Enter question:');
    if (!front) return;
    const back = prompt('Enter answer:');
    if (!back) return;
    await createCard({ front, back, deckId });
    updateUI();
    if (App.currentDeckId === deckId) showCardsInDeck(deckId);
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
        const color = getCardColor(c);
        const colorEmoji = color === 'blue' ? '🔵' : color === 'red' ? '🔴' : color === 'green' ? '🟢' : '⚪';
        html += `<div class="card-entry">
            <span class="card-text">${colorEmoji} <span class="front">${c.front}</span> → <span class="back">${c.back}</span> ${tags ? `<span class="card-tags">${tags}</span>` : ''}</span>
            <div class="actions">
                <button onclick="editCardAction('${c.id}')"><i class="fas fa-edit"></i></button>
                <button onclick="deleteCardAction('${c.id}')"><i class="fas fa-trash"></i></button>
            </div>
        </div>`;
    }
    html += '</div>';
    container.innerHTML = html;
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
    if (deckId && App.currentDeckId === deckId) showCardsInDeck(deckId);
    updateUI();
}

async function deleteCardAction(cardId) {
    if (!confirm('Delete this card?')) return;
    const card = getCard(cardId);
    await deleteCard(cardId);
    if (card && App.currentDeckId === card.deckId) showCardsInDeck(card.deckId);
    updateUI();
}

// ================================================================
//  BOOT
// ================================================================

document.addEventListener('DOMContentLoaded', initApp);
