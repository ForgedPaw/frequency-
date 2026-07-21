// SpeechRecognition wrapper.
//
// We do NOT try to precisely auto-detect "the user is done talking" —
// Chrome's Web Speech API endpointing is unreliable enough (premature
// cutoffs in continuous=false, inconsistent result delivery in
// continuous=true) that guessing at timing keeps producing either missed
// captures or truncated phrases. Instead:
//   - Interim (in-progress) text is surfaced live via onInterim() so the UI
//     can show the user exactly what's being heard, in real time.
//   - The mic button itself doubles as the "I'm done" signal: tapping it
//     while a session is active calls finishListening(), which immediately
//     finalizes whatever has been captured so far.
//   - A silence timeout still exists as a hands-free fallback, just longer
//     and no longer the only way to end a turn.
//
// Half-duplex guard: on a single device (or a car mic close to the
// speakers), the mic can pick up the DJ's own TTS voice or the currently
// playing song and misread it as user speech. speak.js handles this by
// aborting any in-flight recognizer before every utterance and waiting a
// beat after it ends before listening again. The abort uses a generation
// counter so a straggling event from an aborted session can't fire a stale
// onResult callback — that counter only ever guards onResult delivery, the
// recActive/UI reset in onend always runs, so an abort can never leave the
// mic stuck showing "listening".

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

const INITIAL_SILENCE_MS = 8000; // grace period to start answering (thinking time)
const SILENCE_MS = 1800;         // once you've started talking, how long a pause means "done"
const MAX_LISTEN_MS = 20000;     // hard cap so a stuck session can't listen forever

let recActive = false;
let activeRecognizer = null;
let activeStopFn = null; // requestStop() of whichever session is currently live
let generation = 0;
let onListenStateChange = null; // (isListening: bool) => void
let onTranscript = null;        // (transcript: string) => void, final result
let onInterim = null;           // (text: string) => void, live in-progress text

export function isSupported() {
  return !!SR;
}

export function onStateChange(callback) {
  onListenStateChange = callback;
}

export function onTranscriptLogged(callback) {
  onTranscript = callback;
}

export function onInterimTranscript(callback) {
  onInterim = callback;
}

// Aborts any in-flight recognizer. Its onend will still fire and reset the
// UI, but generation++ means it won't deliver a stale onResult.
export function abortActive() {
  generation++;
  if (activeRecognizer) {
    try { activeRecognizer.abort(); } catch (e) { /* no-op */ }
    activeRecognizer = null;
  }
  activeStopFn = null;
}

// Called from the mic button while listening — immediately finalizes
// whatever has been captured so far instead of waiting for silence.
export function finishListening() {
  if (activeStopFn) activeStopFn('manual');
}

export function listenOnce(onResult) {
  if (!SR) return;
  if (recActive) return;
  const myGeneration = ++generation;
  const recognizer = new SR();
  recognizer.continuous = true;
  recognizer.interimResults = true;
  recognizer.lang = 'en-US';
  recognizer.maxAlternatives = 1;

  recActive = true;
  activeRecognizer = recognizer;
  if (onListenStateChange) onListenStateChange(true);

  let accumulated = '';
  let stopRequested = false;
  let committed = false;
  let hasHeardSpeech = false;
  let silenceTimer = null;
  let maxTimer = null;

  function requestStop() {
    if (stopRequested) return;
    stopRequested = true;
    activeStopFn = null;
    clearTimeout(silenceTimer);
    clearTimeout(maxTimer);
    try { recognizer.stop(); } catch (e) { /* no-op */ }
  }

  function commit() {
    if (committed) return;
    committed = true;
    if (onInterim) onInterim('');
    const text = accumulated.trim();
    if (text) {
      if (onTranscript) onTranscript(text);
      onResult(text.toLowerCase().trim());
    }
  }

  function resetSilenceTimer() {
    clearTimeout(silenceTimer);
    // Before any speech is detected, give a generous window to start
    // answering (thinking time) — only switch to the short "you paused"
    // window once we know the user has actually started talking.
    silenceTimer = setTimeout(requestStop, hasHeardSpeech ? SILENCE_MS : INITIAL_SILENCE_MS);
  }

  activeStopFn = requestStop;

  recognizer.onspeechstart = () => {
    hasHeardSpeech = true;
  };

  recognizer.onresult = (e) => {
    if (myGeneration !== generation) return; // superseded by abortActive()
    // Rebuild the final transcript from scratch on every event, scanning
    // e.results from 0, rather than incrementally appending from
    // e.resultIndex. resultIndex is unreliable on Android Chrome in
    // continuous mode — it doesn't always advance, so incremental appending
    // re-added already-committed final segments on top of themselves every
    // time a new one arrived (visible as progressively duplicating text:
    // "You" -> "You Shook" -> "You Shook Me" ...). e.results itself doesn't
    // have that problem — each index is a stable, non-duplicated segment.
    let finalText = '';
    let interimChunk = '';
    for (let i = 0; i < e.results.length; i++) {
      if (e.results[i].isFinal) finalText += (finalText ? ' ' : '') + e.results[i][0].transcript;
      else interimChunk += e.results[i][0].transcript;
    }
    if (finalText.trim() || interimChunk.trim()) hasHeardSpeech = true;
    accumulated = finalText.trim();
    if (onInterim) onInterim((accumulated + ' ' + interimChunk).trim());
    // Calling stop() often triggers one last onresult promoting pending
    // interim text to final — keep accepting results even after stop() was
    // requested so that trailing chunk isn't dropped.
    if (!stopRequested) resetSilenceTimer();
  };

  recognizer.onerror = (e) => {
    if (myGeneration !== generation) return;
    requestStop();
  };

  recognizer.onend = () => {
    const wasCurrent = myGeneration === generation;
    recActive = false;
    activeRecognizer = null;
    if (activeStopFn === requestStop) activeStopFn = null;
    if (onListenStateChange) onListenStateChange(false);
    if (wasCurrent) commit(); // skip if this session was superseded by an abort
  };

  try {
    recognizer.start();
    resetSilenceTimer();
    maxTimer = setTimeout(requestStop, MAX_LISTEN_MS);
  } catch (e) {
    recActive = false;
    activeRecognizer = null;
    activeStopFn = null;
    if (onListenStateChange) onListenStateChange(false);
  }
}

export function isListening() {
  return recActive;
}
