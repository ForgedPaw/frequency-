// Game state machine: MENU / QUESTION / REVEAL / PLAYBACK
// Ported from the frequency-trivia.html prototype, decoupled from the DOM.
// All I/O (speech, trivia generation, playback) is injected via `deps` so
// this module stays a pure orchestrator of state transitions.

export const ZONES = { MENU: 0, QUESTION: 90, REVEAL: 180, PLAYBACK: 270 };

// Sentinel category value for "pull from my Spotify library" instead of a
// keyword-searched category — recognized both from the category button
// (main.js) and from spoken input.
export const MY_LIBRARY_KEY = '__my_library__';

const DIFFICULTY_LEVELS = ['Easy', 'Medium', 'Hard'];

// Context scaffolding: song title always stays hidden (that's the core
// guessing mechanic), but artist/album/year come straight from Spotify's
// own metadata and are safe to reveal *except* whichever one is literally
// the current question's answer. How much of that safe set gets said
// upfront vs. saved for a hint scales with difficulty — Easy gives it all
// away since the goal there is confidence, Hard gives away nothing until
// asked, Medium sits in between with just the artist.
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

export function createGame(deps) {
  const {
    speak,            // (text, onDone?) => void
    listen,           // (onResult) => void  — one-shot recognition
    triviaClient,     // { createQueueSupplier, createMyLibrarySupplier, generateQuestion, judgeAnswer }
    player,           // { play(track), pause(), skip() }
    ui,               // { setState(stateKey, name, sub), setScore({correct,total}), log(who,text,dim), waveMode(mode), showCategories(bool), setBusy(bool)? }
    initialDifficulty, // 'Easy' | 'Medium' | 'Hard' — chosen on the landing page, defaults to Medium
  } = deps;

  let game = {
    state: 'MENU',
    category: null,
    difficulty: initialDifficulty || 'Medium',
    supplier: null,   // paginated track supplier — see spotify/search.js — no fixed queue size
    roundCount: 0,
    currentQ: null,
    score: { correct: 0, total: 0 },
    streak: 0,
    bestStreak: 0,
    recentResults: [], // rolling window of true/false, drives adaptive difficulty
  };

  // Guards against overlapping voice input while a network call (queue
  // build, question generation, answer judging) is in flight — without
  // this, a user repeating themselves while the app "thinks" fires multiple
  // concurrent trivia flows that race and corrupt shared game state.
  let busy = false;
  function setBusy(value) {
    busy = value;
    if (ui.setBusy) ui.setBusy(value);
  }

  function setState(stateKey, name, sub) {
    game.state = stateKey;
    ui.setState(stateKey, name, sub);
  }

  function updateScore() {
    ui.setScore(game.score);
  }

  function matchesAny(text, arr) {
    return arr.some((p) => text.includes(p));
  }

  function defaultHint() {
    switch (game.state) {
      case 'MENU': return 'Say a category, e.g. "classic rock" or "the 90s".';
      case 'QUESTION': return 'Answer, or say "hint", "repeat", or "skip".';
      case 'REVEAL': return 'Say "play song" or "next question".';
      case 'PLAYBACK': return 'Say "skip song" to jump ahead.';
      default: return 'Say "help" any time.';
    }
  }

  function helpText() {
    switch (game.state) {
      case 'MENU': return 'You can say a genre, a decade, or a band name, or say custom category.';
      case 'QUESTION': return 'You can say repeat the question, give me a hint, tell me the answer, or skip question.';
      case 'REVEAL': return 'You can say play song, or next question.';
      case 'PLAYBACK': return 'You can say skip song to jump ahead.';
      default: return 'Say a category to get started.';
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
    if (matchesAny(text, ['pause game', 'pause the game'])) {
      speak("Game paused. Say resume when you're ready.");
      return;
    }
    if (matchesAny(text, ['resume'])) {
      speak('Back in it.', () => promptForState());
      return;
    }
    if (matchesAny(text, ['change difficulty', 'make it easier', 'make it harder', 'easy mode', 'hard mode'])) {
      game.difficulty = text.includes('hard') ? 'Hard' : text.includes('easy') ? 'Easy' : 'Medium';
      game.recentResults = []; // don't let stale history immediately override a manual choice
      speak(`Difficulty set to ${game.difficulty}.`, () => promptForState());
      return;
    }
    if (matchesAny(text, ['new category', 'change category'])) {
      resetToMenu();
      return;
    }
    if (matchesAny(text, ['quit', 'end game', 'stop game'])) {
      speak(`Final score: ${game.score.correct} out of ${game.score.total}. Thanks for playing Frequency!`);
      setState('MENU', 'Menu', 'Game ended — pick a new category to play again.');
      return;
    }

    switch (game.state) {
      case 'MENU': return onMenuUtterance(text);
      case 'QUESTION': return onQuestionUtterance(text);
      case 'REVEAL': return onRevealUtterance(text);
      case 'PLAYBACK':
        if (matchesAny(text, ['skip song', 'next song'])) skipSong();
        break;
    }
  }

  // ---------- MENU ----------
  function onMenuUtterance(text) {
    if (matchesAny(text, ['my library', 'my spotify', 'my music'])) {
      startCategory(MY_LIBRARY_KEY);
      return;
    }
    startCategory(text);
  }

  async function startCategory(categoryText) {
    if (busy) return;
    setBusy(true);
    const isMyLibrary = categoryText === MY_LIBRARY_KEY;
    game.category = categoryText;
    ui.showCategories(false);
    setState('MENU', 'Menu', isMyLibrary ? 'My Spotify' : `Category: ${categoryText}`);
    ui.log('DJ', isMyLibrary ? 'Pulling tracks from your library…' : `Building the ${categoryText} queue…`, true);
    let supplier;
    try {
      supplier = await (isMyLibrary ? triviaClient.createMyLibrarySupplier() : triviaClient.createQueueSupplier(categoryText));
    } catch (e) {
      ui.log('DJ', `Queue build failed: ${e.message}`, true);
      setBusy(false);
      speak("Something went wrong building that queue. Try another category.", () => {
        ui.showCategories(true);
        promptForState();
      });
      return;
    }
    game.supplier = supplier;
    game.roundCount = 0;
    setBusy(false);
    speak(`Got it — ${isMyLibrary ? 'your library' : categoryText}. First question coming up.`, () => nextRound());
  }

  function customCategoryPrompt() {
    speak('What category would you like? Say a genre, decade, or band.', () => listen(startCategory));
  }

  // ---------- QUESTION ----------
  async function nextRound() {
    if (busy) return;
    setBusy(true);
    setState('QUESTION', 'Question', 'Finding a song…');
    // Search calls fail occasionally (network blip, token refresh timing) —
    // retry once before treating it as a real "nothing found" condition.
    let tracks = [];
    for (let attempt = 0; attempt < 2 && !tracks.length; attempt++) {
      try {
        tracks = await game.supplier.next(1);
      } catch (e) {
        ui.log('DJ', `Track search failed${attempt === 0 ? ' — retrying…' : ''}: ${e.message}`, true);
      }
    }
    if (!tracks.length) {
      setBusy(false);
      if (game.roundCount === 0) {
        speak(game.category === MY_LIBRARY_KEY
          ? "I couldn't find any tracks in your library. Try a different category."
          : "I couldn't find enough tracks for that one. Try another category.", () => {
          ui.showCategories(true);
          promptForState();
        });
      } else {
        speak(`We've run out of songs for this category! Final score: ${game.score.correct} out of ${game.score.total}.`);
        resetToMenu();
      }
      return;
    }
    const track = tracks[0];
    game.roundCount++;
    if (ui.setAlbumArt) ui.setAlbumArt(null); // clear any art shown during the previous track's playback
    setState('QUESTION', 'Question', 'Generating question…');
    // These calls fail occasionally (content filter, malformed model
    // output, rate limits) — retry once before giving up on this track.
    let q;
    for (let attempt = 0; attempt < 2 && !q; attempt++) {
      try {
        q = await triviaClient.generateQuestion(track, game.difficulty);
      } catch (e) {
        ui.log('DJ', `Question generation failed${attempt === 0 ? ' — retrying…' : ''}: ${e.message}`, true);
      }
    }
    setBusy(false);
    if (!q) { nextRound(); return; }
    game.currentQ = { ...q, track };
    setState('QUESTION', 'Question', `${q.category} — ${track.artist}`);
    speak(questionLine(game.currentQ), () => listen(handleUtterance));
  }

  function questionLine(q) {
    const shown = upfrontContextFields(q.track, q.category, game.difficulty);
    return `${q.category} trivia.${contextSentence(shown, q.track)} ${q.question}`;
  }

  function onQuestionUtterance(text) {
    const q = game.currentQ;
    if (!q) return;
    if (matchesAny(text, ['repeat the question', 'say that again', 'repeat that', 'repeat'])) {
      speak(questionLine(q), () => listen(handleUtterance));
      return;
    }
    if (matchesAny(text, ['give me a hint', 'hint'])) {
      const shown = upfrontContextFields(q.track, q.category, game.difficulty);
      const safe = safeContextFields(q.track, q.category);
      const extra = safe.filter((f) => !shown.includes(f));
      speak(`${q.hint}${contextSentence(extra, q.track)}`, () => listen(handleUtterance));
      return;
    }
    if (matchesAny(text, ['tell me the answer', 'what is the answer', 'i give up'])) {
      revealAnswer(null);
      return;
    }
    if (matchesAny(text, ['skip question', 'next question', 'skip'])) {
      speak('Skipping.', () => nextRound());
      return;
    }
    checkAnswer(text);
  }

  async function checkAnswer(text) {
    if (busy) return;
    setBusy(true);
    setState('QUESTION', 'Question', 'Checking your answer…');
    const q = game.currentQ;
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
    game.score.total++;
    if (correct) game.score.correct++;
    updateScore();
    revealAnswer(correct);
  }

  function streakCallout(streak) {
    if (streak < 3) return '';
    if (streak === 3) return ' Three in a row!';
    if (streak < 6) return ` ${streak} in a row — you're on fire!`;
    return ` ${streak} in a row?! Unstoppable!`;
  }

  // Auto-adjusts difficulty based on a rolling window of recent results —
  // 3 correct in a row bumps it up, 2 wrong in a row eases it back down.
  // Manual "make it harder/easier" still works and just resets the baseline.
  function maybeAdaptDifficulty() {
    const idx = DIFFICULTY_LEVELS.indexOf(game.difficulty);
    const r = game.recentResults;
    if (r.length >= 3 && r.slice(-3).every(Boolean) && idx < DIFFICULTY_LEVELS.length - 1) {
      game.difficulty = DIFFICULTY_LEVELS[idx + 1];
      game.recentResults = [];
      return ` You're on a roll — bumping up to ${game.difficulty}.`;
    }
    if (r.length >= 2 && r.slice(-2).every((v) => v === false) && idx > 0) {
      game.difficulty = DIFFICULTY_LEVELS[idx - 1];
      game.recentResults = [];
      return ` Let's ease back to ${game.difficulty}.`;
    }
    return '';
  }

  function revealAnswer(wasCorrect) {
    const q = game.currentQ;
    setState('REVEAL', 'Reveal', `${q.track.name} — ${q.track.artist}`);

    if (wasCorrect === true) {
      game.streak++;
      game.bestStreak = Math.max(game.bestStreak, game.streak);
    } else {
      game.streak = 0;
    }
    game.recentResults.push(wasCorrect === true);
    if (game.recentResults.length > 3) game.recentResults.shift();

    const categoryLower = q.category.toLowerCase();
    let opener = wasCorrect === true ? `Correct! The ${categoryLower} answer was ${q.answer}.`
      : wasCorrect === false ? `Not quite — the ${categoryLower} answer was ${q.answer}.`
      : `Here's the ${categoryLower} answer: ${q.answer}.`;
    if (wasCorrect === true) opener += streakCallout(game.streak);

    const difficultyNote = maybeAdaptDifficulty();

    const text = `${opener} ${q.funfact} That was "${q.track.name}" by ${q.track.artist}.${difficultyNote} Play the song, or next question?`;
    speak(text, () => listen(handleUtterance));
  }

  function onRevealUtterance(text) {
    if (matchesAny(text, ['more trivia', 'tell me more', 'another fact'])) {
      // The fun fact is already given in the reveal by default now.
      speak("That's everything I've got on this one — play the song, or next question?", () => listen(handleUtterance));
      return;
    }
    if (matchesAny(text, ['play song', 'play the song', 'play it'])) {
      playCurrentTrack();
      return;
    }
    if (matchesAny(text, ['next question', 'skip'])) {
      nextRound();
      return;
    }
    // fallback: assume they want to hear it
    playCurrentTrack();
  }

  function playCurrentTrack() {
    const q = game.currentQ;
    setState('PLAYBACK', 'Playback', `${q.track.name} — ${q.track.artist}`);
    ui.waveMode('playing');
    if (ui.setAlbumArt) ui.setAlbumArt(q.track.albumArt);
    player.play(q.track);
  }

  function skipSong() {
    if (game.state !== 'PLAYBACK') return;
    player.pause();
    nextRound();
  }

  // Called by main.js when player.js reports natural track end.
  function songEnded() {
    if (game.state !== 'PLAYBACK') return;
    setTimeout(() => nextRound(), 600);
  }

  function resetToMenu() {
    game = {
      state: 'MENU', category: null, difficulty: game.difficulty, supplier: null, roundCount: 0, currentQ: null,
      score: game.score, streak: 0, bestStreak: game.bestStreak, recentResults: [],
    };
    setState('MENU', 'Menu', 'Choose a category to start');
    ui.waveMode('idle');
    ui.showCategories(true);
  }

  function boot() {
    setState('MENU', 'Menu', 'Choose a category to start');
    updateScore();
    speak('Welcome to Frequency. Pick a category — genre, decade, band, or say custom.', () => promptForState());
  }

  return {
    boot,
    handleUtterance,
    startCategory,
    customCategoryPrompt,
    songEnded,
    skipSong,
    defaultHint,
    getState: () => game.state,
    getDifficulty: () => game.difficulty,
    setDifficulty: (d) => { game.difficulty = d; },
    isBusy: () => busy,
  };
}
