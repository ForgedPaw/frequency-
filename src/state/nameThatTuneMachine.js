// Name That Tune mode: pick a category, hear a spoken clue, hear an 8-second
// clip of the track, then guess the song title. "Hint" extends the clip by
// 5 more seconds (resuming from where it left off) instead of speaking more
// information — the audio itself is the hint. The single-player mode; battle
// mode (battleMachine.js) runs the same clue/clip/guess mechanic per player
// turn, sharing its MENU/category-picking structure with this file (each
// duplicates its own copy rather than sharing one, since the two flows'
// surrounding state — a personal running score vs. per-player turns and a
// target-score win condition — differ enough that sharing would mean
// threading mode-specific branches through otherwise-simple functions).

import { MY_LIBRARY_KEY } from './constants.js';

export const ZONES = { MENU: 0, QUESTION: 90, REVEAL: 180, PLAYBACK: 270 };
export { MY_LIBRARY_KEY };

const CLIP_MS = 8000;
const HINT_MS = 5000;
// Small buffer past the clip's exact requested duration before we start
// listening — mirrors player.js's own end-of-track buffer for full playback.
const CLIP_BUFFER_MS = 400;

export function createNameThatTune(deps) {
  const {
    speak,            // (text, onDone?) => void
    listen,           // (onResult) => void — one-shot recognition
    triviaClient,     // { createQueueSupplier, createMyLibrarySupplier, generateClue, judgeAnswer }
    player,           // { play(track), pause(), playClip(track, ms, positionMs) }
    ui,               // { setState, setScore, log, waveMode, showCategories, setBusy, setAlbumArt }
    initialDifficulty, // 'Easy' | 'Medium' | 'Hard'
  } = deps;

  let game = {
    state: 'MENU',
    category: null,
    difficulty: initialDifficulty || 'Medium',
    supplier: null,
    roundCount: 0,
    currentQ: null, // { clue, funfact, category, track, clipMs }
    score: { correct: 0, total: 0 },
  };

  // Guards network calls (queue build, clue generation, guess judging) from
  // overlapping voice input — same pattern as battleMachine.js. Deliberately
  // NOT held while a clip plays: the mic isn't listening again until the
  // clip's own timer finishes (see playClipThenListen), so there's no
  // overlapping-input window to guard there.
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
      case 'QUESTION': return 'Guess the song title, or say "hint" for more of the clip.';
      case 'REVEAL': return 'Say "play song" or "next question".';
      case 'PLAYBACK': return 'Say "skip song" to jump ahead.';
      default: return 'Say "help" any time.';
    }
  }

  function helpText() {
    switch (game.state) {
      case 'MENU': return 'You can say a genre, a decade, or a band name, or say custom category.';
      case 'QUESTION': return 'Try to name the song from the clue and the clip. Say hint for five more seconds of audio, play it again to replay the clip, or skip question.';
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
    if (matchesAny(text, ['change difficulty', 'make it easier', 'make it harder', 'easy mode', 'hard mode'])) {
      game.difficulty = text.includes('hard') ? 'Hard' : text.includes('easy') ? 'Easy' : 'Medium';
      speak(`Difficulty set to ${game.difficulty}.`, () => promptForState());
      return;
    }
    if (matchesAny(text, ['new category', 'change category'])) {
      if (game.state === 'PLAYBACK') player.pause();
      resetToMenu();
      return;
    }
    if (matchesAny(text, ['quit', 'end game', 'stop game'])) {
      if (game.state === 'PLAYBACK') player.pause();
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
      speak('Something went wrong building that queue. Try another category.', () => {
        ui.showCategories(true);
        promptForState();
      });
      return;
    }
    game.supplier = supplier;
    game.roundCount = 0;
    setBusy(false);
    speak(`Got it — ${isMyLibrary ? 'your library' : categoryText}. First song coming up.`, () => nextRound());
  }

  function customCategoryPrompt() {
    speak('What category would you like? Say a genre, decade, or band.', () => listen(startCategory));
  }

  // ---------- QUESTION (clue + clip + guess) ----------
  async function nextRound() {
    if (busy) return;
    setBusy(true);
    setState('QUESTION', 'Question', 'Finding a song…');
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
    if (ui.setAlbumArt) ui.setAlbumArt(null); // stay spoiler-safe until the reveal
    setState('QUESTION', 'Question', 'Generating a clue…');
    let q;
    for (let attempt = 0; attempt < 2 && !q; attempt++) {
      try {
        q = await triviaClient.generateClue(track, game.difficulty);
      } catch (e) {
        ui.log('DJ', `Clue generation failed${attempt === 0 ? ' — retrying…' : ''}: ${e.message}`, true);
      }
    }
    setBusy(false);
    if (!q) { nextRound(); return; }
    game.currentQ = { ...q, track, clipMs: CLIP_MS };
    setState('QUESTION', 'Name that tune', q.category);
    speak(clueLine(q), () => playClipThenListen(CLIP_MS, 0));
  }

  function clueLine(q) {
    return `${q.category} clue. ${q.clue}`;
  }

  // Plays `ms` of audio starting at `positionMs`, then waits out that same
  // duration locally before listening for the guess. Deliberately not tied
  // to player.js's global onTrackEnd callback — that's reserved for the
  // optional full-song reveal playback below (state 'PLAYBACK'), and reusing
  // it here would fire songEnded() at the wrong time since this happens
  // while still in 'QUESTION'.
  //
  // Explicitly pauses before listening rather than trusting player.js's own
  // internal pause-after-`ms` timer to have already landed: that timer only
  // starts counting once the /play network call resolves, not from when
  // audio actually starts, so under real latency it can still be pending
  // when this fires — leaving the clip audibly playing (or restarting mid
  // hint) right as the mic opens for the guess.
  function playClipThenListen(ms, positionMs) {
    ui.waveMode('playing');
    player.playClip(game.currentQ.track, ms, positionMs).catch((e) => {
      ui.log('DJ', `Playback error: ${e.message}`, true);
    });
    setTimeout(() => {
      ui.waveMode('idle');
      player.pause();
      listen(handleUtterance);
    }, ms + CLIP_BUFFER_MS);
  }

  function onQuestionUtterance(text) {
    const q = game.currentQ;
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
      speak('Skipping.', () => nextRound());
      return;
    }
    checkGuess(text);
  }

  function giveHint() {
    const q = game.currentQ;
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
    setState('QUESTION', 'Name that tune', 'Checking your guess…');
    const q = game.currentQ;
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
    game.score.total++;
    if (correct) game.score.correct++;
    updateScore();
    revealAnswer(correct);
  }

  // ---------- REVEAL ----------
  function revealAnswer(wasCorrect) {
    const q = game.currentQ;
    setState('REVEAL', 'Reveal', `${q.track.name} — ${q.track.artist}`);

    const opener = wasCorrect === true ? `Correct! That was "${q.track.name}" by ${q.track.artist}.`
      : wasCorrect === false ? `Not quite — that was "${q.track.name}" by ${q.track.artist}.`
      : `Here it is: "${q.track.name}" by ${q.track.artist}.`;

    const text = `${opener} ${q.funfact} Play the full song, or next question?`;
    speak(text, () => listen(handleUtterance));
  }

  function onRevealUtterance(text) {
    if (matchesAny(text, ['play song', 'play the song', 'play it', 'play full song'])) {
      playCurrentTrack();
      return;
    }
    if (matchesAny(text, ['next question', 'skip'])) {
      nextRound();
      return;
    }
    playCurrentTrack();
  }

  // ---------- PLAYBACK (optional full song after the reveal) ----------
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

  // Called by main.js when player.js reports natural track end. Only
  // meaningful during the optional full-song reveal playback — the
  // clip-guessing phase manages its own timing (see playClipThenListen) and
  // never enters 'PLAYBACK' state, so this is a no-op the rest of the time.
  // That report is a client-side timer based on the track's expected
  // duration, not a real "Spotify actually stopped" signal — the /play call
  // has network/buffering start-latency the timer doesn't account for, so
  // it can fire slightly before the track truly finishes. Explicitly pause
  // here (same as skipSong()) so leftover audio never bleeds into the next
  // question instead of just assuming it already stopped.
  function songEnded() {
    if (game.state !== 'PLAYBACK') return;
    player.pause();
    setTimeout(() => nextRound(), 600);
  }

  function resetToMenu() {
    game = {
      state: 'MENU', category: null, difficulty: game.difficulty, supplier: null, roundCount: 0, currentQ: null,
      score: game.score,
    };
    setState('MENU', 'Menu', 'Choose a category to start');
    ui.waveMode('idle');
    ui.showCategories(true);
  }

  function boot() {
    setState('MENU', 'Menu', 'Choose a category to start');
    updateScore();
    speak("Welcome to Name That Tune. Pick a category — genre, decade, band, or say custom. You'll get a clue and a clip, then guess the song.", () => promptForState());
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
