-- ================================================================
-- FLASHCOACH SUPABASE DATABASE SCHEMA
-- Run this SQL in your Supabase Project's "SQL Editor" to set up tables
-- ================================================================

-- 1. Enable UUID Extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. Decks Table
CREATE TABLE IF NOT EXISTS public.decks (
    id TEXT PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    name TEXT NOT NULL,
    parent_id TEXT,
    description TEXT DEFAULT '',
    collapsed BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    modified_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Cards Table
CREATE TABLE IF NOT EXISTS public.cards (
    id TEXT PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    deck_id TEXT NOT NULL,
    front TEXT NOT NULL,
    back TEXT NOT NULL,
    tags TEXT[] DEFAULT '{}',
    state TEXT DEFAULT 'new',
    due TIMESTAMPTZ DEFAULT NOW(),
    interval FLOAT DEFAULT 0,
    ease FLOAT DEFAULT 2.5,
    reps INT DEFAULT 0,
    lapses INT DEFAULT 0,
    suspended BOOLEAN DEFAULT false,
    buried BOOLEAN DEFAULT false,
    notes TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    modified_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Review History Table
CREATE TABLE IF NOT EXISTS public.history (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    card_id TEXT NOT NULL,
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    rating TEXT NOT NULL,
    rating_value INT NOT NULL,
    old_state TEXT,
    new_state TEXT
);

-- 5. User Settings & Streaks Table
CREATE TABLE IF NOT EXISTS public.user_settings (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    daily_goal INT DEFAULT 20,
    theme TEXT DEFAULT 'light',
    streak INT DEFAULT 0,
    goal_streak INT DEFAULT 0,
    best_streak INT DEFAULT 0,
    last_study_date DATE,
    data_json JSONB DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Enable Row Level Security (RLS)
ALTER TABLE public.decks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;

-- 7. Policies (Users can only see & modify their own data)
CREATE POLICY "Users can manage own decks" ON public.decks
    FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users can manage own cards" ON public.cards
    FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users can manage own history" ON public.history
    FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users can manage own settings" ON public.user_settings
    FOR ALL USING (auth.uid() = user_id);

-- 8. Indexes for lightning fast queries
CREATE INDEX IF NOT EXISTS idx_cards_user_deck ON public.cards(user_id, deck_id);
CREATE INDEX IF NOT EXISTS idx_cards_due ON public.cards(user_id, due);
CREATE INDEX IF NOT EXISTS idx_history_user_time ON public.history(user_id, timestamp DESC);
