// ================================================================
//  SUPABASE CLIENT & CLOUD SYNC ENGINE
// ================================================================

class CloudSyncEngine {
    constructor() {
        this.client = null;
        this.currentUser = null;
        this.isOnline = navigator.onLine;
        this.syncInProgress = false;
        this.onUserChangeCallbacks = [];

        window.addEventListener('online', () => {
            this.isOnline = true;
            this.triggerSync();
        });
        window.addEventListener('offline', () => {
            this.isOnline = false;
        });
    }

    init() {
        const config = window.AppConfig ? window.AppConfig.get() : {};
        if (config.supabaseUrl && config.supabaseAnonKey && window.supabase) {
            try {
                this.client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
                    auth: {
                        persistSession: true,
                        autoRefreshToken: true,
                        detectSessionInUrl: true
                    }
                });

                // Listen for auth state changes
                this.client.auth.onAuthStateChange(async (event, session) => {
                    this.currentUser = session?.user || null;
                    this._notifyUserChange(this.currentUser);
                    if (this.currentUser && event === 'SIGNED_IN') {
                        await this.pullAll();
                    }
                });

                // Check initial session
                this.client.auth.getSession().then(({ data: { session } }) => {
                    this.currentUser = session?.user || null;
                    this._notifyUserChange(this.currentUser);
                });

                return true;
            } catch (e) {
                console.warn('Failed to initialize Supabase client:', e);
                this.client = null;
            }
        }
        return false;
    }

    onUserChange(callback) {
        if (typeof callback === 'function') {
            this.onUserChangeCallbacks.push(callback);
            if (this.currentUser) callback(this.currentUser);
        }
    }

    _notifyUserChange(user) {
        this.onUserChangeCallbacks.forEach(cb => {
            try { cb(user); } catch (e) { console.error(e); }
        });
    }

    isConfigured() {
        return !!this.client;
    }

    isLoggedIn() {
        return !!this.currentUser;
    }

    getUser() {
        return this.currentUser;
    }

    async signUp(email, password) {
        if (!this.client) {
            throw new Error('Cloud sync is not configured. Please add your Supabase credentials in Settings.');
        }
        const { data, error } = await this.client.auth.signUp({
            email,
            password
        });
        if (error) throw error;
        this.currentUser = data.user;
        this._notifyUserChange(this.currentUser);
        return data;
    }

    async signIn(email, password) {
        if (!this.client) {
            throw new Error('Cloud sync is not configured. Please add your Supabase credentials in Settings.');
        }
        const { data, error } = await this.client.auth.signInWithPassword({
            email,
            password
        });
        if (error) throw error;
        this.currentUser = data.user;
        this._notifyUserChange(this.currentUser);
        return data;
    }

    async signOut() {
        if (this.client) {
            await this.client.auth.signOut();
        }
        this.currentUser = null;
        this._notifyUserChange(null);
    }

    // ================================================================
    //  DATABASE PUSH & PULL SYNC
    // ================================================================

    async upsertDeck(deck) {
        if (!this.client || !this.currentUser) return;
        try {
            await this.client.from('decks').upsert({
                id: deck.id,
                user_id: this.currentUser.id,
                name: deck.name,
                parent_id: deck.parentId || null,
                description: deck.description || '',
                collapsed: !!deck.collapsed,
                created_at: deck.createdAt || new Date().toISOString(),
                modified_at: deck.modifiedAt || new Date().toISOString()
            });
        } catch (e) {
            console.warn('Cloud sync error (deck):', e);
        }
    }

    async deleteDeck(deckId) {
        if (!this.client || !this.currentUser) return;
        try {
            await this.client.from('decks').delete().eq('id', deckId).eq('user_id', this.currentUser.id);
        } catch (e) {
            console.warn('Cloud delete error (deck):', e);
        }
    }

    async upsertCard(card) {
        if (!this.client || !this.currentUser) return;
        try {
            await this.client.from('cards').upsert({
                id: card.id,
                user_id: this.currentUser.id,
                deck_id: card.deckId,
                front: card.front,
                back: card.back,
                tags: Array.isArray(card.tags) ? card.tags : [],
                state: card.state || 'new',
                due: card.due || new Date().toISOString(),
                interval: card.interval || 0,
                ease: card.ease || 2.5,
                reps: card.reps || 0,
                lapses: card.lapses || 0,
                suspended: !!card.suspended,
                buried: !!card.buried,
                notes: card.notes || '',
                created_at: card.createdAt || new Date().toISOString(),
                modified_at: card.modifiedAt || new Date().toISOString()
            });
        } catch (e) {
            console.warn('Cloud sync error (card):', e);
        }
    }

    async deleteCard(cardId) {
        if (!this.client || !this.currentUser) return;
        try {
            await this.client.from('cards').delete().eq('id', cardId).eq('user_id', this.currentUser.id);
        } catch (e) {
            console.warn('Cloud delete error (card):', e);
        }
    }

    async logReview(historyEntry) {
        if (!this.client || !this.currentUser) return;
        try {
            await this.client.from('history').insert({
                user_id: this.currentUser.id,
                card_id: historyEntry.cardId,
                timestamp: historyEntry.timestamp || new Date().toISOString(),
                rating: historyEntry.rating,
                rating_value: historyEntry.ratingValue,
                old_state: historyEntry.oldState,
                new_state: historyEntry.newState
            });
        } catch (e) {
            console.warn('Cloud sync error (history):', e);
        }
    }

    async syncSettings(settings) {
        if (!this.client || !this.currentUser) return;
        try {
            await this.client.from('user_settings').upsert({
                user_id: this.currentUser.id,
                daily_goal: settings.dailyGoal || 20,
                theme: settings.theme || 'light',
                streak: settings.streak || 0,
                goal_streak: settings.goalStreak || 0,
                best_streak: settings.bestStreak || 0,
                last_study_date: settings.lastStudyDate || null,
                data_json: JSON.stringify(settings),
                updated_at: new Date().toISOString()
            });
        } catch (e) {
            console.warn('Cloud sync error (settings):', e);
        }
    }

    // Pull everything from Cloud down into Local IndexedDB
    async pullAll() {
        if (!this.client || !this.currentUser || this.syncInProgress) return;
        this.syncInProgress = true;

        try {
            // Fetch Decks
            const { data: cloudDecks } = await this.client
                .from('decks')
                .select('*')
                .eq('user_id', this.currentUser.id);

            // Fetch Cards
            const { data: cloudCards } = await this.client
                .from('cards')
                .select('*')
                .eq('user_id', this.currentUser.id);

            // Fetch Settings
            const { data: cloudSettings } = await this.client
                .from('user_settings')
                .select('*')
                .eq('user_id', this.currentUser.id)
                .single();

            // Fetch History
            const { data: cloudHistory } = await this.client
                .from('history')
                .select('*')
                .eq('user_id', this.currentUser.id)
                .order('timestamp', { ascending: false })
                .limit(2000);

            if (window.App && window.App.mergeCloudData) {
                await window.App.mergeCloudData({
                    decks: cloudDecks || [],
                    cards: cloudCards || [],
                    settings: cloudSettings || null,
                    history: cloudHistory || []
                });
            }
        } catch (e) {
            console.error('Error pulling cloud data:', e);
        } finally {
            this.syncInProgress = false;
        }
    }

    // Push all local IndexedDB data up to Supabase
    async pushAll(localData) {
        if (!this.client || !this.currentUser || this.syncInProgress) return;
        this.syncInProgress = true;

        try {
            const userId = this.currentUser.id;

            // Push Decks
            if (localData.decks && localData.decks.length > 0) {
                const deckRows = localData.decks.map(d => ({
                    id: d.id,
                    user_id: userId,
                    name: d.name,
                    parent_id: d.parentId || null,
                    description: d.description || '',
                    collapsed: !!d.collapsed,
                    created_at: d.createdAt || new Date().toISOString(),
                    modified_at: d.modifiedAt || new Date().toISOString()
                }));
                await this.client.from('decks').upsert(deckRows);
            }

            // Push Cards
            if (localData.cards && localData.cards.length > 0) {
                const cardRows = localData.cards.map(c => ({
                    id: c.id,
                    user_id: userId,
                    deck_id: c.deckId,
                    front: c.front,
                    back: c.back,
                    tags: Array.isArray(c.tags) ? c.tags : [],
                    state: c.state || 'new',
                    due: c.due || new Date().toISOString(),
                    interval: c.interval || 0,
                    ease: c.ease || 2.5,
                    reps: c.reps || 0,
                    lapses: c.lapses || 0,
                    suspended: !!c.suspended,
                    buried: !!c.buried,
                    notes: c.notes || '',
                    created_at: c.createdAt || new Date().toISOString(),
                    modified_at: c.modifiedAt || new Date().toISOString()
                }));
                // Batch upsert in chunks of 100
                for (let i = 0; i < cardRows.length; i += 100) {
                    await this.client.from('cards').upsert(cardRows.slice(i, i + 100));
                }
            }

            // Push Settings
            if (localData.settings) {
                await this.syncSettings(localData.settings);
            }
        } catch (e) {
            console.error('Error pushing local data to cloud:', e);
        } finally {
            this.syncInProgress = false;
        }
    }

    async triggerSync() {
        if (this.currentUser && this.client) {
            await this.pullAll();
        }
    }
}

window.CloudSync = new CloudSyncEngine();
