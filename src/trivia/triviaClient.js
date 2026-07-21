// Calls /api/trivia — never calls Anthropic directly from the browser (spec §6).

import { createCategorySupplier, createLibrarySupplier } from '../spotify/search.js';

async function callTrivia(type, payload) {
  const resp = await fetch('/api/trivia', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, ...payload }),
  });
  if (!resp.ok) {
    // Surface the server's actual reason (content filter, malformed model
    // output, rate limit, etc.) instead of just the generic HTTP status.
    let reason = `HTTP ${resp.status}`;
    try {
      const body = await resp.json();
      if (body?.error) reason = body.error;
    } catch (e) { /* body wasn't JSON, stick with the status */ }
    throw new Error(`/api/trivia (${type}) failed: ${reason}`);
  }
  return resp.json();
}

// type: "queue" — Claude turns a category into good Spotify search terms
// (once), then the returned supplier pages through Spotify search results
// on demand — no fixed queue size, keeps going until the category's
// catalog is genuinely exhausted.
export async function createQueueSupplier(categoryText) {
  const shaped = await callTrivia('queue', { category: categoryText });
  const queries = shaped?.searchQueries?.length ? shaped.searchQueries : [categoryText];
  return createCategorySupplier(queries);
}

// "My Spotify" category — no Claude call needed, pages through the user's own library.
export function createMyLibrarySupplier() {
  return createLibrarySupplier();
}

// type: "question" — given track name/artist, returns {question, answer, hint, funfact}
export async function generateQuestion(track, difficulty) {
  return callTrivia('question', {
    trackName: track.name,
    artist: track.artist,
    difficulty,
  });
}

// type: "clue" — Name That Tune mode. Returns {clue, funfact, category}: a
// declarative fact about the track (never a question with its own answer —
// the thing being guessed here is the song title, not a trivia sub-answer).
export async function generateClue(track, difficulty) {
  return callTrivia('clue', {
    trackName: track.name,
    artist: track.artist,
    difficulty,
  });
}

// type: "judge" — given user transcript + correct answer, returns {correct: bool}
export async function judgeAnswer(userText, correctAnswer) {
  const result = await callTrivia('judge', { userText, correctAnswer });
  return result?.correct === true;
}
