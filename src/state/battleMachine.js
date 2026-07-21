// Battle mode: turn-based head-to-head trivia for 2-3 players.
// Category and difficulty are fixed for the whole battle (no adaptive
// difficulty — keeps every player facing genuinely equal questions).
// First player to reach targetScore wins. Each question allows exactly one
// hint. Mirrors gameMachine.js's QUESTION/REVEAL/PLAYBACK flow but turn-based.

// Context scaffolding — see the matching comment in gameMachine.js. Title
// always stays hidden; artist/album/year (from Spotify's own metadata) are
// safe to reveal except whichever is literally the current answer, and how
// much of that gets said upfront vs. saved for the one hint scales with
// the battle's fixed difficulty.
const CONTEXT_FIELDS = ['artist', 'album', 'year'];

function safeContextFields(track, category) {
  return CONTEXT_FIELDS.filter((field) => {
    if (field === 'album' && category === 'Album') return false;
    if (field === 'year' && category === 'Year') return false;
    return !!track[field];
  });
}

function upfrontContextFields(track, category, difficulty) {
  const safe = safeContextFields(track, category);
  if (difficulty === 'Easy') return safe;
  if (difficulty === 'Medium') return safe.filter((f) => f === 'artist');
  return [];
}

function contextSentence(fields, track) {
  if (!fields.length) return '';
  const parts = [];
  if (fields.includes('artist')) parts.push(`by ${track.artist}`);
  if (fields.includes('album')) parts.push(`from the album ${track.album}`);
  if (fields.includes('year')) parts.push(`released in ${track.year}`);
  return ` This track is ${parts.join(', ')}.`;
}

export function createBattle(deps) {
  const {
    speak, listen, triviaClient, player, ui,
    playerNames,   // string[], 2 or 3 entries, in turn order
    targetScore,   // number — first to reach this many correct answers wins
    difficulty,    // 'Easy' | 'Medium' | 'Hard' — fixed for the whole battle
    category,      // category text, or MY_LIBRARY_KEY
    isMyLibrary,
    onBattleEnd,   // (players) => void — called when the battle is over
  } = deps;

  const players = playerNames.map((name) => ({ name, score: 0 }));
  let state = 'QUESTION';
  let supplier = null;    // paginated track supplier — see spotify/search.js — no fixed queue size
  let roundsAsked = 0;
  let currentQ = null;
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
      case 'QUESTION': return 'Answer, or say "hint", "repeat", or "skip".';
      case 'REVEAL': return 'Say "play song" or "next question".';
      case 'PLAYBACK': return 'Say "skip song" to jump ahead.';
      default: return 'Say "help" any time.';
    }
  }

  function helpText() {
    switch (state) {
      case 'QUESTION': return 'You can say repeat the question, give me a hint, tell me the answer, or skip question.';
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
    speak(`Let's battle! ${intro}. First to ${targetScore} wins. ${activePlayer().name}, you're up first.`, () => askCurrentPlayer());
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
    if (ui.setAlbumArt) ui.setAlbumArt(null); // clear any art shown during the previous track's playback
    setPhase('QUESTION', 'Battle', `${activePlayer().name}'s turn`);
    let q;
    for (let attempt = 0; attempt < 2 && !q; attempt++) {
      try {
        q = await triviaClient.generateQuestion(track, difficulty);
      } catch (e) {
        ui.log('DJ', `Question generation failed${attempt === 0 ? ' — retrying…' : ''}: ${e.message}`, true);
      }
    }
    setBusy(false);
    if (!q) { askCurrentPlayer(); return; }
    currentQ = { ...q, track, hintUsed: false };
    setPhase('QUESTION', 'Battle', `${activePlayer().name} — ${q.category}`);
    speak(questionLine(q), () => listen(handleUtterance));
  }

  function questionLine(q) {
    const shown = upfrontContextFields(q.track, q.category, difficulty);
    return `${activePlayer().name}'s turn. ${q.category} trivia.${contextSentence(shown, q.track)} ${q.question}`;
  }

  function advanceTurn() {
    activeIndex = (activeIndex + 1) % players.length;
    askCurrentPlayer();
  }

  function onQuestionUtterance(text) {
    const q = currentQ;
    if (!q) return;
    if (matchesAny(text, ['repeat the question', 'say that again', 'repeat that', 'repeat'])) {
      speak(questionLine(q), () => listen(handleUtterance));
      return;
    }
    if (matchesAny(text, ['give me a hint', 'hint'])) {
      if (q.hintUsed) {
        speak("You've already used your hint for this one — take your best guess!", () => listen(handleUtterance));
      } else {
        q.hintUsed = true;
        const shown = upfrontContextFields(q.track, q.category, difficulty);
        const safe = safeContextFields(q.track, q.category);
        const extra = safe.filter((f) => !shown.includes(f));
        speak(`${q.hint}${contextSentence(extra, q.track)}`, () => listen(handleUtterance));
      }
      return;
    }
    if (matchesAny(text, ['tell me the answer', 'what is the answer', 'i give up'])) {
      revealAnswer(null);
      return;
    }
    if (matchesAny(text, ['skip question', 'next question', 'skip'])) {
      speak('Skipping.', () => advanceTurn());
      return;
    }
    checkAnswer(text);
  }

  async function checkAnswer(text) {
    if (busy) return;
    setBusy(true);
    setPhase('QUESTION', 'Battle', 'Checking the answer…');
    const q = currentQ;
    // null = the check never actually completed — must not be conflated
    // with "wrong", which would silently penalize a correct answer whenever
    // the judge call fails (network blip, model overload, etc).
    let correct = null;
    for (let attempt = 0; attempt < 2 && correct === null; attempt++) {
      try {
        correct = await triviaClient.judgeAnswer(text, q.answer);
      } catch (e) {
        ui.log('DJ', `Answer check failed${attempt === 0 ? ' — retrying…' : ''}: ${e.message}`, true);
      }
    }
    setBusy(false);
    if (correct === null) {
      speak("Sorry, I couldn't check that — say your answer again?", () => listen(handleUtterance));
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
    const categoryLower = q.category.toLowerCase();

    if (wasCorrect === true && activePlayer().score >= targetScore) {
      const opener = `Correct! The ${categoryLower} answer was ${q.answer}. ${q.funfact} That was "${q.track.name}" by ${q.track.artist}.`;
      speak(`${opener} And that's the game — ${name} wins with ${activePlayer().score}!`, finishBattle);
      return;
    }

    const opener = wasCorrect === true ? `Correct, ${name}! The ${categoryLower} answer was ${q.answer}.`
      : wasCorrect === false ? `Not quite, ${name} — the ${categoryLower} answer was ${q.answer}.`
      : `Here's the ${categoryLower} answer, ${name}: ${q.answer}.`;

    const text = `${opener} ${q.funfact} That was "${q.track.name}" by ${q.track.artist}. Play the song, or next question?`;
    speak(text, () => listen(handleUtterance));
  }

  function onRevealUtterance(text) {
    if (matchesAny(text, ['play song', 'play the song', 'play it'])) {
      playCurrentTrack();
      return;
    }
    if (matchesAny(text, ['next question', 'skip'])) {
      advanceTurn();
      return;
    }
    playCurrentTrack();
  }

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

  // Called by main.js when player.js reports natural track end. That
  // report is a client-side timer based on the track's expected duration,
  // not a real "Spotify actually stopped" signal — the /play call has
  // network/buffering start-latency the timer doesn't account for, so the
  // timer can fire slightly before the track truly finishes. Explicitly
  // pause here (same as skipSong()) so leftover audio never bleeds into
  // the next turn instead of just assuming it already stopped.
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
