import './style.css';
import { createDial } from './ui/dial.js';
import { createSettings } from './ui/settings.js';
import { createBattleSetup } from './ui/battleSetup.js';
import { createGame, MY_LIBRARY_KEY } from './state/gameMachine.js';
import { createBattle } from './state/battleMachine.js';
import { createNameThatTune } from './state/nameThatTuneMachine.js';
import { setupSpeech, speak, onSpeak } from './voice/speak.js';
import { listenOnce, onStateChange as onListenStateChange, onTranscriptLogged, onInterimTranscript, isSupported as isSpeechSupported, isListening, finishListening } from './voice/recognize.js';
import * as spotifyAuth from './spotify/auth.js';
import * as spotifyPlayer from './spotify/player.js';
import * as triviaClient from './trivia/triviaClient.js';

const app = document.getElementById('app');

const CATEGORIES = [
  { label: 'Genre: Classic Rock', value: 'classic rock genre' },
  { label: 'Era: The 90s', value: '1990s hits era' },
  { label: 'Band: Fleetwood Mac', value: 'Fleetwood Mac' },
  { label: 'My Spotify', value: MY_LIBRARY_KEY },
  { label: 'Custom (say it)', value: 'custom' },
];

// Populated once on load so the landing page's settings gear has a voice
// list ready immediately, and boot()/battle setup don't need to re-run
// setupSpeech() themselves.
let voiceSetup = null;

// Spotify playback can fail transiently — a backgrounded mobile tab losing
// its device momentarily, another Spotify Connect client briefly taking
// over, a network blip — none of which the search/question/judge retry
// logic elsewhere in the app covers, since this is a separate call. Retries
// once before giving up, same pattern as those other call sites.
async function playWithRetry(playFn, addLog) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await playFn();
      return;
    } catch (e) {
      if (attempt === 0) {
        addLog('DJ', `Playback error — retrying…`, true);
      } else {
        addLog('DJ', `Playback error: ${e.message}`, true);
      }
    }
  }
}

async function main() {
  if (window.location.pathname === '/callback') {
    await handleCallbackRoute();
    return;
  }

  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    // Dev-only exclusion: the SW's cache-first strategy would otherwise
    // silently serve stale JS across reloads while iterating locally.
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  } else if ('serviceWorker' in navigator) {
    // Clean up any SW registered by an earlier dev session so it stops
    // intercepting requests on this origin.
    navigator.serviceWorker.getRegistrations().then((regs) => {
      regs.forEach((r) => r.unregister());
    });
  }

  renderShell();

  if (!spotifyAuth.isSpotifyConfigured()) {
    document.getElementById('startOverlay').innerHTML = `
      <h2>Frequency</h2>
      <p>Spotify isn't configured yet. Add <code>VITE_SPOTIFY_CLIENT_ID</code> to a <code>.env</code> file and restart the dev server.</p>
      <div class="config-warning">See the Spotify Developer Dashboard to create a Client ID (no secret needed for PKCE).</div>
    `;
    return;
  }

  voiceSetup = await setupSpeech();
  renderLandingPage();
}

async function handleCallbackRoute() {
  app.innerHTML = `<div class="unit"><div class="start-overlay" style="position:static;"><h2>Frequency</h2><p id="callbackMsg">Connecting to Spotify…</p></div></div>`;
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const error = params.get('error');
  const msgEl = document.getElementById('callbackMsg');
  if (error) {
    msgEl.textContent = `Spotify authorization failed: ${error}`;
    return;
  }
  if (!code) {
    msgEl.textContent = 'Missing authorization code from Spotify.';
    return;
  }
  try {
    await spotifyAuth.handleAuthCallback(code);
    window.location.href = '/';
  } catch (e) {
    msgEl.textContent = `Could not complete Spotify login: ${e.message}`;
  }
}

function renderShell() {
  app.innerHTML = `
    <div class="unit" id="unit">
      <div class="start-overlay" id="startOverlay"></div>

      <div class="hdr">
        <div class="brand">Frequency<small>voice trivia · on air</small></div>
        <div class="hdr-right">
          <button class="gear-btn" id="gearBtn" aria-label="Settings">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </button>
          <div class="score-box" id="scoreBox">
            <div class="score-num" id="scoreNum">0/0</div>
            <div class="score-lbl">Score</div>
          </div>
        </div>
      </div>

      <div class="scoreboard" id="scoreboard" style="display:none;"></div>

      <div id="dialMount"></div>

      <div class="log" id="log"></div>

      <div class="controls">
        <button class="mic-btn" id="micBtn" title="Push to talk">
          <svg viewBox="0 0 24 24" fill="none" stroke-width="1.6" stroke-linecap="round">
            <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
            <path d="M19 10v1a7 7 0 0 1-14 0v-1"/>
            <line x1="12" y1="18" x2="12" y2="22"/>
          </svg>
        </button>
        <div class="hint-row" id="hintRow"><b>Say</b> a category, or "help" any time for options.</div>
      </div>

      <div class="categories" id="categories">
        ${CATEGORIES.map((c) => `<button class="cat-btn" data-cat="${c.value}">${c.label}</button>`).join('')}
      </div>

      <button class="skip-btn" id="skipBtn" style="display:none;">Skip song ▶▶</button>
    </div>

    <div class="settings-panel-backdrop" id="settingsBackdrop">
      <div id="settingsMount"></div>
    </div>
  `;
}

// Single consolidated landing screen: mode + difficulty selection, with a
// settings gear (Spotify connect/reconnect + DJ voice) right on the page —
// no more separate Start engine / Connect Spotify / mode-select screens.
let selectedDifficulty = 'Medium';

function renderLandingPage() {
  const overlay = document.getElementById('startOverlay');
  overlay.innerHTML = `
    <div class="landing-gear-row">
      <button class="gear-btn" id="landingGearBtn" aria-label="Settings">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
      </button>
    </div>
    <h2>Frequency</h2>
    <p>How do you want to play?</p>
    <button class="start-btn stacked-btn" id="standardModeBtn">Standard mode</button>
    <button class="start-btn spotify stacked-btn" id="battleModeBtn">Battle mode (2-3 players)</button>
    <button class="start-btn stacked-btn" id="nameThatTuneModeBtn">Name That Tune</button>

    <p class="setup-step-label">Difficulty</p>
    <div class="setup-row" id="landingDifficultyRow">
      ${['Easy', 'Medium', 'Hard'].map((d) => `<button class="cat-btn setup-choice${d === selectedDifficulty ? ' active' : ''}" data-diff="${d}">${d}</button>`).join('')}
    </div>

    <p class="landing-hint">Tap a mode to begin — you'll be asked for microphone access once, then everything runs by voice.</p>
    ${!isSpeechSupported() ? '<div class="config-warning">This browser doesn\'t support voice recognition — try Chrome on Android or desktop.</div>' : ''}
  `;

  document.getElementById('landingDifficultyRow').addEventListener('click', (e) => {
    const btn = e.target.closest('.setup-choice');
    if (!btn) return;
    selectedDifficulty = btn.dataset.diff;
    document.querySelectorAll('#landingDifficultyRow .setup-choice').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
  });

  wireLandingSettings();

  document.getElementById('standardModeBtn').addEventListener('click', () => {
    if (!spotifyAuth.isAuthenticated()) { openLandingSettings(); return; }
    boot(selectedDifficulty);
  });
  document.getElementById('battleModeBtn').addEventListener('click', () => {
    if (!spotifyAuth.isAuthenticated()) { openLandingSettings(); return; }
    startBattleSetupFlow(selectedDifficulty);
  });
  document.getElementById('nameThatTuneModeBtn').addEventListener('click', () => {
    if (!spotifyAuth.isAuthenticated()) { openLandingSettings(); return; }
    bootNameThatTune(selectedDifficulty);
  });
}

function openLandingSettings() {
  document.getElementById('landingGearBtn').click();
}

function wireLandingSettings() {
  const gearBtn = document.getElementById('landingGearBtn');
  const backdrop = document.getElementById('settingsBackdrop');
  const mount = document.getElementById('settingsMount');

  gearBtn.addEventListener('click', () => {
    createSettings(mount, {
      voices: voiceSetup.voices,
      activeVoiceURI: localStorage.getItem('frequency.voiceURI'),
      notice: null,
      onClose: () => {
        backdrop.classList.remove('open');
        // Re-render so mode buttons pick up a freshly connected Spotify session.
        renderLandingPage();
      },
    });
    backdrop.classList.add('open');
  });

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) {
      backdrop.classList.remove('open');
      renderLandingPage();
    }
  });
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

let booted = false;

// Shared by both standard and battle mode: mic button, listening indicator,
// live interim transcript, skip button, and track-end wiring. Both game
// objects expose the same { handleUtterance, isBusy, defaultHint, skipSong }
// shape, so this works identically regardless of mode.
function wireGameControls(controller) {
  const micBtn = document.getElementById('micBtn');
  const hintRow = document.getElementById('hintRow');
  const skipBtn = document.getElementById('skipBtn');

  onListenStateChange((listening) => {
    micBtn.classList.toggle('live', listening);
    if (listening) {
      hintRow.textContent = 'Listening… (tap mic when done)';
    } else {
      hintRow.textContent = controller.defaultHint();
    }
  });

  onInterimTranscript((text) => {
    if (text) hintRow.textContent = `"${text}"`;
  });

  micBtn.addEventListener('click', () => {
    if (controller.isBusy()) return;
    if (isListening()) {
      finishListening();
    } else {
      listenOnce((text) => controller.handleUtterance(text));
    }
  });

  skipBtn.addEventListener('click', () => controller.skipSong());
  spotifyPlayer.onTrackEnd(() => controller.songEnded());
}

async function boot(difficulty) {
  if (booted) return;
  booted = true;

  // Rebuild the shell fresh (same as bootBattle()) rather than reusing the
  // landing page's elements — otherwise the landing page's settings-close
  // handler stays bound to the shared backdrop and fires during gameplay,
  // trying to re-render the landing page over an active game.
  renderShell();
  document.getElementById('startOverlay').remove();

  const dial = createDial(document.getElementById('dialMount'));
  const logEl = document.getElementById('log');
  const scoreNumEl = document.getElementById('scoreNum');
  const categoriesEl = document.getElementById('categories');

  function addLog(who, text, dim) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<span class="who ${who === 'DJ' ? 'dj' : 'you'}">${who}</span><span class="txt${dim ? ' dim' : ''}">${escapeHtml(text)}</span>`;
    logEl.appendChild(row);
    logEl.scrollTop = logEl.scrollHeight;
  }

  if (voiceSetup.notice) addLog('DJ', voiceSetup.notice, true);
  onSpeak((text) => addLog('DJ', text));
  onTranscriptLogged((text) => addLog('You', text));

  try {
    await spotifyPlayer.initPlayer();
  } catch (e) {
    addLog('DJ', `Spotify playback couldn't start: ${e.message}`, true);
  }

  const game = createGame({
    speak,
    listen: (onResult) => listenOnce(onResult),
    triviaClient,
    initialDifficulty: difficulty,
    player: {
      play: (track) => playWithRetry(() => spotifyPlayer.play(track), addLog),
      pause: () => spotifyPlayer.pause(),
    },
    ui: {
      setState: (stateKey, name, sub) => {
        dial.setNeedle(stateKey);
        dial.setReadout(name, sub);
        document.getElementById('skipBtn').style.display = stateKey === 'PLAYBACK' ? 'block' : 'none';
      },
      setScore: ({ correct, total }) => { scoreNumEl.textContent = `${correct}/${total}`; },
      log: addLog,
      waveMode: (mode) => dial.waveMode(mode),
      setAlbumArt: (url) => dial.setAlbumArt(url),
      showCategories: (show) => { categoriesEl.style.display = show ? 'grid' : 'none'; },
      setBusy: (isBusy) => {
        document.getElementById('micBtn').disabled = isBusy;
        document.getElementById('micBtn').classList.toggle('busy', isBusy);
        if (isBusy) {
          document.getElementById('hintRow').textContent = 'Thinking…';
          dial.waveMode('thinking');
        } else {
          dial.waveMode('idle');
        }
      },
    },
  });

  wireGameControls(game);

  categoriesEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.cat-btn');
    if (!btn) return;
    if (btn.dataset.cat === 'custom') {
      game.customCategoryPrompt();
    } else {
      game.startCategory(btn.dataset.cat);
    }
  });

  wireSettings();

  game.boot();
}

async function bootNameThatTune(difficulty) {
  if (booted) return;
  booted = true;

  renderShell();
  document.getElementById('startOverlay').remove();

  const dial = createDial(document.getElementById('dialMount'));
  const logEl = document.getElementById('log');
  const scoreNumEl = document.getElementById('scoreNum');
  const categoriesEl = document.getElementById('categories');

  function addLog(who, text, dim) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<span class="who ${who === 'DJ' ? 'dj' : 'you'}">${who}</span><span class="txt${dim ? ' dim' : ''}">${escapeHtml(text)}</span>`;
    logEl.appendChild(row);
    logEl.scrollTop = logEl.scrollHeight;
  }

  if (voiceSetup.notice) addLog('DJ', voiceSetup.notice, true);
  onSpeak((text) => addLog('DJ', text));
  onTranscriptLogged((text) => addLog('You', text));

  try {
    await spotifyPlayer.initPlayer();
  } catch (e) {
    addLog('DJ', `Spotify playback couldn't start: ${e.message}`, true);
  }

  const nameThatTune = createNameThatTune({
    speak,
    listen: (onResult) => listenOnce(onResult),
    triviaClient,
    initialDifficulty: difficulty,
    player: {
      play: (track) => playWithRetry(() => spotifyPlayer.play(track), addLog),
      pause: () => spotifyPlayer.pause(),
      playClip: (track, ms, positionMs) => playWithRetry(() => spotifyPlayer.playSample(track, ms, positionMs), addLog),
    },
    ui: {
      setState: (stateKey, name, sub) => {
        dial.setNeedle(stateKey);
        dial.setReadout(name, sub);
        document.getElementById('skipBtn').style.display = stateKey === 'PLAYBACK' ? 'block' : 'none';
      },
      setScore: ({ correct, total }) => { scoreNumEl.textContent = `${correct}/${total}`; },
      log: addLog,
      waveMode: (mode) => dial.waveMode(mode),
      setAlbumArt: (url) => dial.setAlbumArt(url),
      showCategories: (show) => { categoriesEl.style.display = show ? 'grid' : 'none'; },
      setBusy: (isBusy) => {
        document.getElementById('micBtn').disabled = isBusy;
        document.getElementById('micBtn').classList.toggle('busy', isBusy);
        if (isBusy) {
          document.getElementById('hintRow').textContent = 'Thinking…';
          dial.waveMode('thinking');
        } else {
          dial.waveMode('idle');
        }
      },
    },
  });

  wireGameControls(nameThatTune);

  categoriesEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.cat-btn');
    if (!btn) return;
    if (btn.dataset.cat === 'custom') {
      nameThatTune.customCategoryPrompt();
    } else {
      nameThatTune.startCategory(btn.dataset.cat);
    }
  });

  wireSettings();

  nameThatTune.boot();
}

async function startBattleSetupFlow(difficulty) {
  const overlay = document.getElementById('startOverlay');
  if (overlay) overlay.remove();

  app.innerHTML = `<div class="unit" id="battleSetupUnit"></div>`;
  const setupRoot = document.getElementById('battleSetupUnit');

  createBattleSetup(setupRoot, {
    speak,
    listen: (onResult) => listenOnce(onResult),
    difficulty,
    onComplete: (result) => bootBattle(result),
  });
}

async function bootBattle({ playerNames, targetScore, difficulty, category, isMyLibrary }) {
  renderShell();
  document.getElementById('startOverlay').remove();

  const dial = createDial(document.getElementById('dialMount'));
  const logEl = document.getElementById('log');
  const categoriesEl = document.getElementById('categories');
  const scoreBox = document.getElementById('scoreBox');
  const scoreboardEl = document.getElementById('scoreboard');

  categoriesEl.style.display = 'none';
  scoreBox.style.display = 'none';
  scoreboardEl.style.display = 'flex';

  function addLog(who, text, dim) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<span class="who ${who === 'DJ' ? 'dj' : 'you'}">${who}</span><span class="txt${dim ? ' dim' : ''}">${escapeHtml(text)}</span>`;
    logEl.appendChild(row);
    logEl.scrollTop = logEl.scrollHeight;
  }

  if (voiceSetup.notice) addLog('DJ', voiceSetup.notice, true);
  onSpeak((text) => addLog('DJ', text));
  onTranscriptLogged((text) => addLog('You', text));

  try {
    await spotifyPlayer.initPlayer();
  } catch (e) {
    addLog('DJ', `Spotify playback couldn't start: ${e.message}`, true);
  }

  function renderScoreboard({ players, activeIndex }) {
    scoreboardEl.innerHTML = players.map((p, i) =>
      `<div class="score-chip${i === activeIndex ? ' active' : ''}"><span class="score-chip-name">${escapeHtml(p.name)}</span><span class="score-chip-num">${p.score}</span></div>`
    ).join('');
  }

  const battle = createBattle({
    speak,
    listen: (onResult) => listenOnce(onResult),
    triviaClient,
    player: {
      play: (track) => playWithRetry(() => spotifyPlayer.play(track), addLog),
      pause: () => spotifyPlayer.pause(),
    },
    ui: {
      setState: (stateKey, name, sub) => {
        dial.setNeedle(stateKey);
        dial.setReadout(name, sub);
        document.getElementById('skipBtn').style.display = stateKey === 'PLAYBACK' ? 'block' : 'none';
      },
      setScore: renderScoreboard,
      log: addLog,
      waveMode: (mode) => dial.waveMode(mode),
      setAlbumArt: (url) => dial.setAlbumArt(url),
      setBusy: (isBusy) => {
        document.getElementById('micBtn').disabled = isBusy;
        document.getElementById('micBtn').classList.toggle('busy', isBusy);
        if (isBusy) {
          document.getElementById('hintRow').textContent = 'Thinking…';
          dial.waveMode('thinking');
        } else {
          dial.waveMode('idle');
        }
      },
    },
    playerNames,
    targetScore,
    difficulty,
    category,
    isMyLibrary,
    onSetupFailed: () => {
      setTimeout(() => startBattleSetupFlow(difficulty), 1500);
    },
    onBattleEnd: () => {
      addLog('DJ', 'Battle over — starting a new setup so you can play again.', true);
      setTimeout(() => startBattleSetupFlow(difficulty), 2500);
    },
  });

  wireGameControls(battle);
  wireSettings();

  battle.start();
}

function wireSettings() {
  const gearBtn = document.getElementById('gearBtn');
  const backdrop = document.getElementById('settingsBackdrop');
  const mount = document.getElementById('settingsMount');

  gearBtn.addEventListener('click', () => {
    createSettings(mount, {
      voices: voiceSetup.voices,
      activeVoiceURI: localStorage.getItem('frequency.voiceURI'),
      notice: null,
      onClose: () => backdrop.classList.remove('open'),
    });
    backdrop.classList.add('open');
  });

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) backdrop.classList.remove('open');
  });
}

main();
