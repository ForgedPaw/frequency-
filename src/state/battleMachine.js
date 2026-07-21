// Battle mode: turn-based head-to-head Name That Tune for 2-3 players.
// Category and difficulty are fixed for the whole battle (no adaptive
// difficulty — keeps every player facing genuinely equal songs). Each
// player's turn is a clue + 8-second clip + guess-the-title round, the same
// mechanic as single-player Name That Tune (see nameThatTuneMachine.js),
// scored across a shared queue with turns cycling between players and a
// target-score win condition instead of a personal running total.

const CLIP_MS = 8000;
const HINT_MS = 5000;
// Small buffer past the clip's exact requested duration before we start
// listening — mirrors player.js's own end-of-track buffer for full playback.
const CLIP_BUFFER_MS = 400;

export function createBattle(deps) {
  const {
    speak, listen, triviaClient, player, ui,
    playerNames,   // string[], 2 or 3 entries, in turn order
    targetScore,   // number — first to reach this many correct guesses wins
    difficulty,    // 'Easy' | 'Medium' | 'Hard' — fixed for the whole battle
    category,      // category text, or MY_LIBRARY_KEY
    isMyLibrary,
    onBattleEnd,   // (players) => void — called when the battle is over
  } = deps;

  const players = playerNames.map((name) => ({ name, score: 0 }));
  let state = 'QUESTION';
  let supplier = null;    // paginated track supplier — see spotify/search.js — no fixed queue size
  let roundsAsked = 0;
  let currentQ = null;    // { clue, funfact, category, track, clipMs }
  let activeIndex = 0;
  let busy = false;

  function setBusy(value) {
    busy = value;
    if (ui.setBusy) ui.setBusy(value);
  }

  function matchesAny(text, arr) {
    return arr.some((p) => text.includes(p));
  }

  function activePlayer() {
    return players[activeIndex];
  }

  function setPhase(stateKey, name, sub) {
    state = stateKey;
    ui.setState(stateKey, name, sub);
  }

  function updateScoreboard() {
    ui.setScore({ players, activeIndex });
  }

  function defaultHint() {
    switch (state) {
      case 'QUESTION': return 'Guess the song title, or say "hint" for more of the clip.';
      case 'REVEAL': return 'Say "play song" or "next question".';
      case 'PLAYBACK': return 'Say "skip song" to jump ahead.';
      default: return 'Say "help" any time.';
    }
  }

  function helpText() {
    switch (state) {
      case 'QUESTION': return 'Try to name the song from the clue and the clip. Say hint for five more seconds of audio, play it again to replay the clip, or skip question.';
      case 'REVEAL': return 'You can say play song, or next question.';
      case 'PLAYBACK': return 'You can say skip song to jump ahead.';
      default: return 'Say "help" any time.';
    }
  }

  function promptForState() {
    listen(handleUtterance);
  }

  function handleUtterance(text) {
    if (matchesAny(text, ['help', 'options', 'what can i say'])) {
      speak(helpText(), () => promptForState());
      return;
    }
    if (matchesAny(text, ['quit', 'end game', 'stop game', 'end battle'])) {
      if (state === 'PLAYBACK') player.pause();
      const standings = standingsText();
      speak(`Ending the battle early. Standings: ${standings}.`, finishBattle);
      return;
    }
    switch (state) {
      case 'QUESTION': return onQuestionUtterance(text);
      case 'REVEAL': return onRevealUtterance(text);
      case 'PLAYBACK':
        if (matchesAny(text, ['skip song', 'next song'])) skipSong();
        break;
    }
  }

  function standingsText() {
    return players.slice().sort((a, b) => b.score - a.score)
      .map((p) => `${p.name}, ${p.score}`).join('. ');
  }

  async function start() {
    setBusy(true);
    setPhase('QUESTION', 'Battle', isMyLibrary ? 'My Spotify' : category);
    ui.log('DJ', isMyLibrary ? 'Pulling tracks from your library…' : `Building the ${category} queue…`, true);
    try {
      supplier = await (isMyLibrary ? triviaClient.createMyLibrarySupplier() : triviaClient.createQueueSupplier(category));
    } catch (e) {
      setBusy(false);
      ui.log('DJ', `Queue build failed: ${e.message}`, true);
      speak('Something went wrong building the battle queue. Please try again.');
      if (deps.onSetupFailed) deps.onSetupFailed();
      return;
    }
    setBusy(false);
    updateScoreboard();
    const intro = players.length === 2
      ? `${players[0].name} versus ${players[1].name}`
      : players.map((p) => p.name).join(', ');
    speak(`Let's battle! ${intro}. First to ${targetScore} wins — name that tune. ${activePlayer().name}, you're up first.`, () => askCurrentPlayer());
  }

  async function askCurrentPlayer() {
    if (busy) return;
    setBusy(true);
    // Search calls fail occasionally (network blip, token refresh timing) —
    // retry once before treating it as a real "nothing found" condition.
    let tracks = [];
    for (let attempt = 0; attempt < 2 && !tracks.length; attempt++) {
      try {
        tracks = await supplier.next(1);
      } catch (e) {
        ui.log('DJ', `Track search failed${attempt === 0 ? ' — retrying…' : ''}: ${e.message}`, true);
      }
    }
    if (!tracks.length) {
      setBusy(false);
      if (roundsAsked === 0) {
        speak(isMyLibrary
          ? "I couldn't find any tracks in your library."
          : "I couldn't find enough tracks for that category.");
        if (deps.onSetupFailed) deps.onSetupFailed();
      } else {
        const standings = standingsText();
        speak(`We've run out of songs for this category. Final standings: ${standings}.`, finishBattle);
      }
      return;
    }
    const track = tracks[0];
    roundsAsked++;
    if (ui.setAlbumArt) ui.setAlbumArt(null); // stay spoiler-safe until the reveal
    setPhase('QUESTION', 'Battle', `${activePlayer().name}'s turn`);
    let q;
    for (let attempt = 0; attempt < 2 && !q; attempt++) {
      try {
        q = await triviaClient.generateClue(track, difficulty);
      } catch (e) {
        ui.log('DJ', `Clue generation failed${attempt === 0 ? ' — retrying…' : ''}: ${e.message}`, true);
      }
    }
    setBusy(false);
    if (!q) { askCurrentPlayer(); return; }
    currentQ = { ...q, track, clipMs: CLIP_MS };
    setPhase('QUESTION', 'Battle', `${activePlayer().name} — ${q.category}`);
    speak(clueLine(q), () => playClipThenListen(CLIP_MS, 0));
  }

  function clueLine(q) {
    return `${activePlayer().name}'s turn. ${q.category} clue. ${q.clue}`;
  }

  // Plays `ms` of audio starting at `positionMs`, then waits out that same
  // duration locally before listening for the guess. Deliberately not tied
  // to player.js's global onTrackEnd callback — that's reserved for the
  // optional full-song reveal playback below (state 'PLAYBACK'), and reusing
  // it here would fire songEnded() at the wrong time since this happens
  // while still in 'QUESTION'.
  function playClipThenListen(ms, positionMs) {
    ui.waveMode('playing');
    player.playClip(currentQ.track, ms, positionMs).catch((e) => {
      ui.log('DJ', `Playback error: ${e.message}`, true);
    });
    setTimeout(() => {
      ui.waveMode('idle');
      listen(handleUtterance);
    }, ms + CLIP_BUFFER_MS);
  }

  function advanceTurn() {
    activeIndex = (activeIndex + 1) % players.length;
    askCurrentPlayer();
  }

  function onQuestionUtterance(text) {
    const q = currentQ;
    if (!q) return;
    if (matchesAny(text, ['repeat the clue', 'repeat the question', 'say that again', 'repeat that', 'repeat'])) {
      speak(clueLine(q), () => listen(handleUtterance));
      return;
    }
    if (matchesAny(text, ['play it again', 'play that again', 'replay the clip', 'replay'])) {
      playClipThenListen(q.clipMs, 0);
      return;
    }
    if (matchesAny(text, ['give me a hint', 'hint'])) {
      giveHint();
      return;
    }
    if (matchesAny(text, ['tell me the answer', 'what is the answer', 'what is the song', 'i give up'])) {
      revealAnswer(null);
      return;
    }
    if (matchesAny(text, ['skip question', 'next question', 'skip'])) {
      speak('Skipping.', () => advanceTurn());
      return;
    }
    checkGuess(text);
  }

  function giveHint() {
    const q = currentQ;
    const duration = q.track.durationMs || Infinity;
    if (q.clipMs >= duration) {
      speak("That's already the whole song — take your best guess!", () => listen(handleUtterance));
      return;
    }
    const startMs = q.clipMs;
    const addMs = Math.min(HINT_MS, duration - startMs);
    q.clipMs = startMs + addMs;
    speak("Here's a little more.", () => playClipThenListen(addMs, startMs));
  }

  async function checkGuess(text) {
    if (busy) return;
    setBusy(true);
    setPhase('QUESTION', 'Battle', 'Checking the guess…');
    const q = currentQ;
    // null = the check never actually completed — must not be conflated
    // with "wrong", which would silently penalize a correct guess whenever
    // the judge call fails (network blip, model overload, etc).
    let correct = null;
    for (let attempt = 0; attempt < 2 && correct === null; attempt++) {
      try {
        correct = await triviaClient.judgeAnswer(text, q.track.name);
      } catch (e) {
        ui.log('DJ', `Answer check failed${attempt === 0 ? ' — retrying…' : ''}: ${e.message}`, true);
      }
    }
    setBusy(false);
    if (correct === null) {
      speak("Sorry, I couldn't check that — say your guess again?", () => listen(handleUtterance));
      return;
    }
    if (correct) activePlayer().score++;
    updateScoreboard();
    revealAnswer(correct);
  }

  function revealAnswer(wasCorrect) {
    const q = currentQ;
    const name = activePlayer().name;
    setPhase('REVEAL', 'Reveal', `${q.track.name} — ${q.track.artist}`);

    if (wasCorrect === true && activePlayer().score >= targetScore) {
      const opener = `Correct! That was "${q.track.name}" by ${q.track.artist}. ${q.funfact}`;
      speak(`${opener} And that's the game — ${name} wins with ${activePlayer().score}!`, finishBattle);
      return;
    }

    const opener = wasCorrect === true ? `Correct, ${name}! That was "${q.track.name}" by ${q.track.artist}.`
      : wasCorrect === false ? `Not quite, ${name} — that was "${q.track.name}" by ${q.track.artist}.`
      : `Here it is, ${name}: "${q.track.name}" by ${q.track.artist}.`;

    const text = `${opener} ${q.funfact} Play the full song, or next question?`;
    speak(text, () => listen(handleUtterance));
  }

  function onRevealUtterance(text) {
    if (matchesAny(text, ['play song', 'play the song', 'play it', 'play full song'])) {
      playCurrentTrack();
      return;
    }
    if (matchesAny(text, ['next question', 'skip'])) {
      advanceTurn();
      return;
    }
    playCurrentTrack();
  }

  // ---------- PLAYBACK (optional full song after the reveal) ----------
  function playCurrentTrack() {
    const q = currentQ;
    setPhase('PLAYBACK', 'Playback', `${q.track.name} — ${q.track.artist}`);
    ui.waveMode('playing');
    if (ui.setAlbumArt) ui.setAlbumArt(q.track.albumArt);
    player.play(q.track);
  }

  function skipSong() {
    if (state !== 'PLAYBACK') return;
    player.pause();
    advanceTurn();
  }

  // Called by main.js when player.js reports natural track end. Only
  // meaningful during the optional full-song reveal playback — the
  // clip-guessing phase manages its own timing (see playClipThenListen) and
  // never enters 'PLAYBACK' state, so this is a no-op the rest of the time.
  // That report is a client-side timer based on the track's expected
  // duration, not a real "Spotify actually stopped" signal — the /play call
  // has network/buffering start-latency the timer doesn't account for, so
  // it can fire slightly before the track truly finishes. Explicitly pause
  // here (same as skipSong()) so leftover audio never bleeds into the next
  // turn instead of just assuming it already stopped.
  function songEnded() {
    if (state !== 'PLAYBACK') return;
    player.pause();
    setTimeout(() => advanceTurn(), 600);
  }

  function finishBattle() {
    setPhase('MENU', 'Battle over', 'Thanks for playing!');
    ui.waveMode('idle');
    if (onBattleEnd) onBattleEnd(players.slice());
  }

  return {
    start,
    handleUtterance,
    skipSong,
    songEnded,
    defaultHint,
    getState: () => state,
    isBusy: () => busy,
  };
}
