// ================================================================
//  CONFIG & CREDENTIALS MANAGER
// ================================================================

const CONFIG_KEY = 'flashcoach_config';

const DEFAULT_CONFIG = {
    supabaseUrl: '',
    supabaseAnonKey: '',
    geminiApiKey: '',
    enableCloudSync: false,
};

function loadConfig() {
    try {
        const stored = localStorage.getItem(CONFIG_KEY);
        if (stored) {
            return { ...DEFAULT_CONFIG, ...JSON.parse(stored) };
        }
    } catch (e) {
        console.error('Error loading config:', e);
    }
    return { ...DEFAULT_CONFIG };
}

function saveConfig(config) {
    try {
        localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
        return true;
    } catch (e) {
        console.error('Error saving config:', e);
        return false;
    }
}

window.AppConfig = {
    get: loadConfig,
    save: saveConfig,
    defaults: DEFAULT_CONFIG,
};
