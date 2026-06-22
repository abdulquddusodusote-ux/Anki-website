// --- Data Layer ---
let cards = JSON.parse(localStorage.getItem('flashcards')) || [];
let dailyGoal = parseInt(localStorage.getItem('dailyGoal')) || 20;
let currentReviewQueue = [];
let currentReviewIndex = 0;
let showingAnswer = false;
let selectedDeckForEdit = null;

// --- Utilities ---
function save() {
  localStorage.setItem('flashcards', JSON.stringify(cards));
  updateUI();
}

function generateId() { return Date.now() + '_' + Math.random().toString(36).slice(2, 6); }

function today() { return new Date().toISOString().split('T')[0]; }

function getDueCards() {
  const now = new Date();
  return cards.filter(c => new Date(c.due) <= now);
}

function getDeckHierarchy(deckName) {
  return deckName ? deckName.split('::').filter(s => s.trim()) : [];
}

function getParentDeck(deckName) {
  const parts = getDeckHierarchy(deckName);
  return parts.slice(0, -1).join('::');
}

// --- UI Updates ---
function updateUI() {
  renderDashboard();
  renderDeckTree();
  populateDeckSelect();
  renderStats();
}

function renderDashboard() {
  document.getElementById('totalCards').textContent = cards.length;
  const due = getDueCards().length;
  document.getElementById('dueToday').textContent = due;
  document.getElementById('newCards').textContent = cards.filter(c => c.reps === 0).length;

  // Streak
  const lastDate = localStorage.getItem('lastStudyDate');
  let streak = parseInt(localStorage.getItem('streak')) || 0;
  if (lastDate === today()) { /* keep */ } 
  else if (lastDate) {
    const diff = (new Date() - new Date(lastDate)) / (1000*60*60*24);
    if (diff <= 1.5) { /* same or next day ok */ } 
    else if (diff > 1.5) { streak = 0; localStorage.setItem('streak', '0'); }
  }
  document.getElementById('streak').textContent = streak + ' days';

  // Goal progress
  const goal = dailyGoal;
  const reviewedToday = parseInt(localStorage.getItem('reviewedToday')) || 0;
  const pct = Math.min(100, (reviewedToday / goal) * 100);
  document.getElementById('goalText').textContent = `${reviewedToday} / ${goal}`;
  document.getElementById('goalRing').style.background = `conic-gradient(var(--primary) ${pct}%, var(--border) ${pct}%)`;

  // Retention
  const logs = JSON.parse(localStorage.getItem('reviewLogs')) || [];
  const last7 = logs.filter(l => (new Date() - new Date(l.date)) < 7*86400000);
  const correct = last7.filter(l => l.quality >= 2).length;
  const rate = last7.length ? Math.round((correct/last7.length)*100) : 0;
  document.getElementById('retentionRate').textContent = rate + '%';
  document.getElementById('retentionBar').style.width = rate + '%';
  document.getElementById('retentionBar').style.background = rate > 70 ? '#2ecc71' : rate > 40 ? '#f39c12' : '#e74c3c';

  // Deck distribution
  const dist = {};
  cards.forEach(c => { const d = c.deck || 'General'; dist[d] = (dist[d]||0)+1; });
  const el = document.getElementById('deckDistList');
  el.innerHTML = Object.entries(dist).sort((a,b)=>b[1]-a[1]).map(([d,n]) => 
    `<span class="deck-tag">${d} (${n})</span>`
  ).join(' ');
}

function renderDeckTree() {
  const tree = buildDeckTree();
  const container = document.getElementById('deckTree');
  container.innerHTML = renderTreeNodes(tree);
  // Attach click events to select deck and show cards
  document.querySelectorAll('.deck-item').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const deck = el.dataset.deck;
      selectedDeckForEdit = deck;
      showCardsInDeck(deck);
      // highlight
      document.querySelectorAll('.deck-item').forEach(d => d.classList.remove('highlight'));
      el.classList.add('highlight');
    });
  });
}

function buildDeckTree() {
  const tree = {};
  cards.forEach(c => {
    const parts = getDeckHierarchy(c.deck || 'General');
    let current = tree;
    parts.forEach((part, idx) => {
      if (!current[part]) current[part] = {};
      if (idx === parts.length - 1) {
        if (!current[part]._cards) current[part]._cards = [];
        current[part]._cards.push(c);
      } else {
        current = current[part];
      }
    });
    if (parts.length === 0) {
      if (!tree['General']) tree['General'] = { _cards: [] };
      tree['General']._cards.push(c);
    }
  });
  return tree;
}

function renderTreeNodes(node, path = '') {
  let html = '<ul>';
  for (const [key, value] of Object.entries(node)) {
    if (key === '_cards') continue;
    const deckPath = path ? path + '::' + key : key;
    const count = value._cards ? value._cards.length : 0;
    html += `<li><div class="deck-item" data-deck="${deckPath}"><span><i class="fas fa-folder"></i> ${key}</span><span class="badge">${count}</span></div>`;
    if (Object.keys(value).filter(k => k !== '_cards').length > 0) {
      html += renderTreeNodes(value, deckPath);
    }
    html += '</li>';
  }
  html += '</ul>';
  return html;
}

function showCardsInDeck(deck) {
  const container = document.getElementById('deckCardList');
  const filtered = cards.filter(c => (c.deck || 'General') === deck);
  if (filtered.length === 0) {
    container.innerHTML = `<p style="color:var(--text-muted);">No cards in this deck.</p>`;
    return;
  }
  let html = `<h4>${deck} (${filtered.length} cards) <button onclick="addToDeck('${deck}')" class="btn-primary" style="font-size:0.8rem;"><i class="fas fa-plus"></i> Add</button></h4><div style="max-height:400px; overflow-y:auto;">`;
  filtered.forEach(c => {
    html += `<div style="display:flex; align-items:center; gap:8px; padding:8px 0; border-bottom:1px solid var(--border);">
      <span style="flex:1;"><strong>${c.front}</strong> → ${c.back}</span>
      <button onclick="editCard('${c.id}')" style="padding:4px 12px;"><i class="fas fa-edit"></i></button>
      <button onclick="deleteCard('${c.id}')" style="padding:4px 12px; color:var(--danger);"><i class="fas fa-trash"></i></button>
    </div>`;
  });
  html += '</div>';
  container.innerHTML = html;
}

function populateDeckSelect() {
  const select = document.getElementById('reviewDeckSelect');
  const decks = [...new Set(cards.map(c => c.deck || 'General'))];
  select.innerHTML = `<option value="all">-- All Decks --</option>` + 
    decks.map(d => `<option value="${d}">${d}</option>`).join('');
}

// --- Decks ---
function createDeck() {
  const name = document.getElementById('newDeckName').value.trim();
  if (!name) return alert('Enter a deck name.');
  if (cards.some(c => c.deck === name)) return alert('Deck already exists.');
  // Add a dummy card to create the deck? Better: just create an empty deck by adding a placeholder card? 
  // Instead, we allow adding cards directly to it. We'll just save and refresh.
  alert(`Deck "${name}" created. You can now add cards to it via the "Add Card" in the deck view.`);
  document.getElementById('newDeckName').value = '';
  // We need to let user add card to this deck. The "Add" button in showCardsInDeck will handle it.
}

function addToDeck(deck) {
  const front = prompt('Enter question:');
  if (!front) return;
  const back = prompt('Enter answer:');
  if (!back) return;
  cards.push({
    id: generateId(),
    front, back,
    deck: deck,
    due: new Date().toISOString(),
    interval: 1/1440, // 1 minute as learning step
    ease: 2.5,
    reps: 0,
    lapses: 0
  });
  save();
  showCardsInDeck(deck);
}

// --- Edit / Delete ---
function editCard(id) {
  const card = cards.find(c => c.id === id);
  if (!card) return;
  const newFront = prompt('Edit question:', card.front);
  if (newFront !== null) card.front = newFront;
  const newBack = prompt('Edit answer:', card.back);
  if (newBack !== null) card.back = newBack;
  save();
  if (selectedDeckForEdit) showCardsInDeck(selectedDeckForEdit);
}

function deleteCard(id) {
  if (!confirm('Delete this card?')) return;
  cards = cards.filter(c => c.id !== id);
  save();
  if (selectedDeckForEdit) showCardsInDeck(selectedDeckForEdit);
}

// --- Review Engine (Anki SM-2 with Minutes) ---
function startReview(deck) {
  let queue = getDueCards();
  if (deck !== 'all') {
    queue = queue.filter(c => (c.deck || 'General') === deck);
  }
  // Sort by lapses (high priority first) and then by due date
  queue.sort((a,b) => (b.lapses - a.lapses) || (new Date(a.due) - new Date(b.due)));
  
  if (queue.length === 0) {
    document.getElementById('cardDisplay').innerHTML = '🎉 No cards due in this selection!';
    document.getElementById('reviewButtons').querySelectorAll('button').forEach(b => b.classList.add('hidden'));
    document.getElementById('reviewProgress').textContent = '';
    return;
  }
  
  currentReviewQueue = queue;
  currentReviewIndex = 0;
  showingAnswer = false;
  renderReviewCard();
}

function renderReviewCard() {
  if (currentReviewIndex >= currentReviewQueue.length) {
    document.getElementById('cardDisplay').innerHTML = '✅ Review complete! Great job.';
    document.getElementById('reviewButtons').querySelectorAll('button').forEach(b => b.classList.add('hidden'));
    document.getElementById('reviewProgress').textContent = '';
    // Update streak
    const lastDate = localStorage.getItem('lastStudyDate');
    let streak = parseInt(localStorage.getItem('streak')) || 0;
    if (lastDate !== today()) {
      if (lastDate) {
        const diff = (new Date() - new Date(lastDate)) / (1000*60*60*24);
        if (diff <= 1.5) { streak += 1; } else { streak = 1; }
      } else { streak = 1; }
    }
    localStorage.setItem('streak', streak);
    localStorage.setItem('lastStudyDate', today());
    save();
    return;
  }
  
  const card = currentReviewQueue[currentReviewIndex];
  document.getElementById('cardDisplay').innerHTML = `<strong>${card.front}</strong><br><br><span style="color:var(--text-muted);">(Click "Show Answer")</span>`;
  document.getElementById('showBtn').classList.remove('hidden');
  document.getElementById('againBtn').classList.add('hidden');
  document.getElementById('hardBtn').classList.add('hidden');
  document.getElementById('goodBtn').classList.add('hidden');
  document.getElementById('easyBtn').classList.add('hidden');
  document.getElementById('reviewProgress').textContent = `${currentReviewIndex+1} / ${currentReviewQueue.length}`;
  showingAnswer = false;
}

function showAnswer() {
  const card = currentReviewQueue[currentReviewIndex];
  document.getElementById('cardDisplay').innerHTML = `<strong>${card.front}</strong><br><br>${card.back}`;
  document.getElementById('showBtn').classList.add('hidden');
  document.getElementById('againBtn').classList.remove('hidden');
  document.getElementById('hardBtn').classList.remove('hidden');
  document.getElementById('goodBtn').classList.remove('hidden');
  document.getElementById('easyBtn').classList.remove('hidden');
  showingAnswer = true;
}

function rateCard(quality) {
  if (!showingAnswer) return;
  const card = currentReviewQueue[currentReviewIndex];
  const original = cards.find(c => c.id === card.id);
  if (!original) return;

  // Log for retention
  const logs = JSON.parse(localStorage.getItem('reviewLogs')) || [];
  logs.push({ date: new Date().toISOString(), quality });
  localStorage.setItem('reviewLogs', JSON.stringify(logs));
  
  // Increment daily reviewed count
  let reviewed = parseInt(localStorage.getItem('reviewedToday')) || 0;
  reviewed += 1;
  localStorage.setItem('reviewedToday', reviewed);

  // --- Anki SM-2 with Learning Steps (Minutes) ---
  let interval = original.interval || 1/1440;
  let ease = original.ease || 2.5;
  let reps = original.reps || 0;
  let lapses = original.lapses || 0;

  // Learning phase: if reps < 2, we handle minutes
  const isLearning = reps < 2;
  
  if (isLearning) {
    if (quality === 0) { // Again
      interval = 1/1440; // 1 minute
      lapses += 1;
    } else if (quality === 1) { // Hard
      interval = 5/1440; // 5 minutes
    } else if (quality === 2) { // Good
      if (reps === 0) interval = 10/1440; // 10 minutes
      else { interval = 1; } // Graduate to 1 day
    } else if (quality === 3) { // Easy
      interval = 4; // 4 days
      reps = 2; // Force graduation
    }
    reps += 1;
  } else {
    // Graduated (Review phase)
    if (quality === 0) { // Again
      interval = 1/1440; // Reset to 1 minute
      lapses += 1;
      ease = Math.max(1.3, ease - 0.2);
      reps = 0; // Reset to learning
    } else if (quality === 1) { // Hard
      interval = Math.max(1, interval * 0.8);
      ease = Math.max(1.3, ease - 0.15);
    } else if (quality === 2) { // Good
      interval = interval * ease;
      ease = ease + 0.0;
    } else if (quality === 3) { // Easy
      interval = interval * ease * 1.3;
      ease = Math.max(1.3, ease + 0.15);
    }
    // Cap interval at 365 days
    if (interval > 365) interval = 365;
    reps += 1;
  }

  // If lapses > 2, flag as high priority (we just sort by lapses later)
  if (lapses > 2) {
    // Reduce ease heavily to make it appear more often
    ease = Math.min(ease, 1.5);
  }

  const now = new Date();
  const dueDate = new Date(now.getTime() + interval * 24 * 60 * 60 * 1000);
  
  original.interval = interval;
  original.ease = ease;
  original.reps = reps;
  original.lapses = lapses;
  original.due = dueDate.toISOString();

  save();
  currentReviewIndex++;
  renderReviewCard();
}

// --- Import (Strict Semicolon) ---
function importFile() {
  const fileInput = document.getElementById('fileInput');
  const file = fileInput.files[0];
  if (!file) return alert('Select a file.');
  const reader = new FileReader();
  reader.onload = function(e) {
    const text = e.target.result;
    const lines = text.split(/\r?\n/).filter(line => line.trim() !== '');
    let count = 0;
    for (let line of lines) {
      const parts = line.split(';');
      if (parts.length < 2) continue;
      const front = parts[0].trim();
      const back = parts.slice(1).join(';').trim();
      if (!front || !back) continue;
      cards.push({
        id: generateId(),
        front, back,
        deck: 'Imported',
        due: new Date().toISOString(),
        interval: 1/1440,
        ease: 2.5,
        reps: 0,
        lapses: 0
      });
      count++;
    }
    save();
    document.getElementById('importStatus').innerHTML = `<span style="color:var(--success);">✅ Imported ${count} cards into "Imported" deck.</span>`;
    fileInput.value = '';
  };
  reader.readAsText(file);
}

// --- Export ---
function exportFile() {
  let text = '';
  cards.forEach(c => {
    text += `${c.front};${c.back};${c.deck || 'General'}\n`;
  });
  const blob = new Blob([text], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `flashcards_export_${today()}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// --- Daily Goal ---
function setGoal() {
  const val = parseInt(document.getElementById('goalInput').value);
  if (val > 0) {
    dailyGoal = val;
    localStorage.setItem('dailyGoal', val);
    document.getElementById('goalDisplay').textContent = `Goal set to ${val} cards/day.`;
    renderDashboard();
  }
}

// --- Stats Page (Detailed) ---
function renderStats() {
  const deckBreak = document.getElementById('statsDeckBreakdown');
  const maturity = document.getElementById('statsMaturity');
  const dueDist = document.getElementById('statsDueDistribution');

  // Deck breakdown
  const dist = {};
  cards.forEach(c => { const d = c.deck || 'General'; dist[d] = (dist[d]||0)+1; });
  deckBreak.innerHTML = Object.entries(dist).sort((a,b)=>b[1]-a[1]).map(([d,n]) => 
    `<div style="display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px solid var(--border);"><span>${d}</span><span>${n}</span></div>`
  ).join('') || '<span style="color:var(--text-muted);">No decks yet.</span>';

  // Maturity
  const newC = cards.filter(c => c.reps === 0).length;
  const learning = cards.filter(c => c.reps > 0 && c.reps < 3).length;
  const mature = cards.filter(c => c.interval > 21).length;
  maturity.innerHTML = `
    <div><span class="badge" style="background:#f39c12;">New: ${newC}</span></div>
    <div><span class="badge" style="background:#3498db;">Learning: ${learning}</span></div>
    <div><span class="badge" style="background:#2ecc71;">Mature: ${mature}</span></div>
    <div><span class="badge" style="background:#e74c3c;">Lapsed (High Priority): ${cards.filter(c => c.lapses > 2).length}</span></div>
  `;

  // Due distribution (next 7 days)
  const now = new Date();
  let distHtml = '';
  for (let i=0; i<7; i++) {
    const target = new Date(now.getTime() + i*86400000);
    const targetStr = target.toISOString().split('T')[0];
    const count = cards.filter(c => c.due.split('T')[0] === targetStr).length;
    distHtml += `<div style="display:flex; align-items:center; gap:8px; margin:4px 0;"><span style="width:80px;">${i===0?'Today':'Day '+i}:</span><div style="flex:1; background:var(--border); height:8px; border-radius:4px;"><div style="height:100%; width:${Math.min(100, count*5)}%; background:var(--primary); border-radius:4px;"></div></div><span>${count}</span></div>`;
  }
  dueDist.innerHTML = distHtml || 'No cards scheduled.';
}

// --- Navigation Tabs ---
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.getElementById(btn.dataset.tab).classList.add('active');
  });
});

// --- Theme Toggle ---
const themeToggle = document.getElementById('themeToggle');
themeToggle.addEventListener('click', () => {
  const html = document.documentElement;
  const current = html.getAttribute('data-theme');
  const next = current === 'light' ? 'dark' : 'light';
  html.setAttribute('data-theme', next);
  themeToggle.innerHTML = next === 'light' ? '<i class="fas fa-moon"></i>' : '<i class="fas fa-sun"></i>';
  localStorage.setItem('theme', next);
});

// --- Load Theme ---
const savedTheme = localStorage.getItem('theme') || 'light';
document.documentElement.setAttribute('data-theme', savedTheme);
themeToggle.innerHTML = savedTheme === 'light' ? '<i class="fas fa-moon"></i>' : '<i class="fas fa-sun"></i>';

// --- Init ---
setGoal();
updateUI();