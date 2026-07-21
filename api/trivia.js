// Vercel serverless function — the only piece of this app that touches
// ANTHROPIC_API_KEY (spec §6). Keeps the key server-side; never shipped to the client.

const MODEL = 'claude-sonnet-5';

// Read lazily (not at module load) so a dev-only middleware that sets
// process.env after import still works — see vite.config.js.
async function callClaude(promptText) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1000,
      messages: [{ role: 'user', content: promptText }],
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Anthropic API error ${resp.status}: ${errText}`);
  }
  const data = await resp.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const cleaned = text.replace(/```json|```/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  try {
    return JSON.parse(match ? match[0] : cleaned);
  } catch (e) {
    return null;
  }
}

function queuePrompt(category) {
  return `You are shaping a Spotify search strategy for a music trivia game category: "${category}". ` +
    `Use Spotify's field-filter search syntax to make results as precisely on-target as possible — plain keyword text alone is too loose and lets in unrelated matches: ` +
    `- If the category names a specific artist or band, every query MUST use artist:"<exact artist name>" (e.g. for "Twenty One Pilots" use artist:"Twenty One Pilots"). ` +
    `- If the category specifies a decade or era (e.g. "1980s", "90s", "the 2000s"), every query MUST include a year:YYYY-YYYY range filter for that exact decade (e.g. "1980s" -> year:1980-1989) — this is required, not optional, otherwise unrelated tracks from any era can match. Combine it with a genre keyword if the category also names one (e.g. "year:1980-1989 rock"). ` +
    `- If the category names a genre without a decade, use genre:"<genre>" combined with relevant keywords. ` +
    `- Otherwise (a theme, mood, etc. with no artist/decade/genre), use plain descriptive keywords. ` +
    `Generate 2-4 queries with a mix of specificity — include at least one broader fallback query (e.g. just the year range plus a simple genre word) alongside more specific ones, so results don't come back too thin. ` +
    `Respond with ONLY JSON (no prose, no markdown fences): ` +
    `{"searchQueries": ["<2-4 good Spotify search query strings that will surface well-known, mainstream, recognizable tracks for this category>"], ` +
    `"framing": "<one short sentence describing the difficulty angle / theme for trivia questions about this category>"}`;
}

const KNOWN_CATEGORIES = ['Song', 'Album', 'Year', 'Featured artist', 'Music video', 'Charts & awards', 'Production', 'Fun fact'];

// Picked server-side (not left to the model's judgment) so question variety
// and per-difficulty accessibility are guaranteed instead of relying on the
// model's own judgment. Some angles (album name, exact year, chart stats,
// production credits) are pure-recall facts — you can't infer them just
// from listening, no matter how gently the question is worded, so they're
// excluded from Easy entirely rather than just "asked more gently." Player
// feedback: Easy was still too hard, and there was too much album/year
// content overall — both are addressed by these tiered, song-weighted pools.
// Song angles are weighted heaviest — lyrics/theme are text the model has
// reliably memorized, whereas music video visuals are a common source of
// confidently-wrong answers (easy to confuse with a different song's video
// or invent plausible-sounding details for). Keeping Music Video to a
// single entry limits how often that riskier angle gets picked.
const EASY_ANGLES = [
  { label: 'Song', angle: 'the song\'s lyrical theme, meaning, or story it tells — something you\'d pick up on just from listening' },
  { label: 'Song', angle: 'the song\'s overall vibe, genre, or a phrase repeated in its hook/chorus' },
  { label: 'Song', angle: 'the general mood or emotion the song conveys, or who/what it seems to be about' },
  { label: 'Music video', angle: 'a visually obvious, memorable moment or scene from the song\'s official music video' },
];

const MEDIUM_ANGLES = [
  { label: 'Song', angle: 'the song\'s lyrical theme, meaning, or story it tells' },
  { label: 'Music video', angle: 'the song\'s official music video — its concept, setting, or a notable visual' },
  { label: 'Album', angle: 'the album it appears on' },
  { label: 'Year', angle: 'the year or era it was released' },
  { label: 'Featured artist', angle: 'another artist who was featured on, sampled, or covered this track' },
  { label: 'Fun fact', angle: 'a surprising or little-known fact about the song or artist' },
];

const HARD_ANGLES = [
  ...MEDIUM_ANGLES,
  { label: 'Charts & awards', angle: 'its chart performance, sales figures, certifications, or awards' },
  { label: 'Production', angle: 'behind-the-scenes writing, production, or recording trivia' },
];

function anglesForDifficulty(difficulty) {
  const level = (difficulty || 'Medium').toLowerCase();
  if (level === 'easy') return EASY_ANGLES;
  if (level === 'hard') return HARD_ANGLES;
  return MEDIUM_ANGLES;
}

// Concrete anchors for what each difficulty actually means — left
// unspecified, the model's idea of "easy" trivia still skewed hard (exact
// years, chart positions, deep-cut facts) even for angles that could be
// made accessible. This is the secondary lever, on top of angle selection.
const DIFFICULTY_GUIDANCE = {
  easy: 'This must be GENUINELY EASY — answerable by a casual listener who has only heard this song a handful of times, or confidently guessable. ' +
    'Stick to the obvious and well-known: the song\'s general mood or genre, what it\'s plainly about, or something stated directly in the lyrics or title. ' +
    'Do NOT ask for an exact date, an exact chart position, a precise number, or any deep-cut/insider fact — that is too hard for easy. ' +
    'The hint can be quite generous here — it\'s fine for it to get the listener most of the way to the answer, since the goal at this level is confidence, not stumping.',
  medium: 'This should be moderately challenging — something a genuine fan of the artist would know, not obscure or insider trivia, but not something a casual listener would necessarily guess either. ' +
    'If this is about the release year, asking for the decade instead of the exact year is fine and often better.',
  hard: 'This should be a real challenge for a superfan — a specific, lesser-known fact: an exact date, number, name, or deep-cut detail that only close followers would know. ' +
    'The hint should still genuinely help, but can stay narrower/subtler than at easier levels — it\'s meant to reward close followers, not hand the answer over.',
};

function questionPrompt(trackName, artist, difficulty, angle) {
  const level = (difficulty || 'Medium').toLowerCase();
  const guidance = DIFFICULTY_GUIDANCE[level] || DIFFICULTY_GUIDANCE.medium;
  return `You are a radio trivia game master. The current song is "${trackName}" by ${artist}. ` +
    `Write one trivia question specifically about: ${angle}. ` +
    `Only write this if you are genuinely confident the facts are correct FOR THIS EXACT TRACK by THIS EXACT ARTIST — do not guess, approximate, or reuse a plausible-sounding detail from a different song, video, or artist. ` +
    `This matters most for visual/production details (music video imagery, behind-the-scenes trivia) — those are the easiest to get wrong or confuse with another song. ` +
    `If you are not confident about this specific angle for this specific track, fall back to the song's lyrical theme or general vibe instead — that is something you can describe accurately just from the song itself. ` +
    `${guidance} ` +
    `The question must ask for exactly ONE specific fact (e.g. a single name, date, place, or number) and must be a single, direct, plainly-worded sentence — ` +
    `no compound or multi-part questions, no run-on clauses stacking extra clues onto the same sentence. ` +
    `State clearly what kind of answer you want (e.g. "Name the album...", "What decade...", "Which city..."). ` +
    `Every question must include at least one specific, concrete supporting detail or piece of context in the question itself — never just a bare "what year/number" ask with nothing else to go on. ` +
    `Never write a circular or self-answering question — one where the answer is already stated or obviously implied by the question's own wording (e.g. don't say "this is a live recording, what kind of performance is shown?" where "live" already gives away "a live performance"). If you don't have a specific, confidently-known fact for this angle, pick a different angle instead of writing a vague or generic question. ` +
    `For the hint: it must add a piece of information that is NOT already present anywhere in the question, and that meaningfully narrows down the answer — never just rephrase or restate the question (that is not a hint, it's noise). ` +
    `Good hints do things like: name a related person/place/thing and how it connects, give a category or range the answer falls into, describe what it sounds/looks/rhymes like, or give a partial version of the answer (e.g. first word, first letter, or how many words it has). ` +
    `For example, if the question is "This track's official video is set against a colorful backdrop covered in artwork — what kind of urban setting is shown?", a bad hint just repeats that ("think about the backdrop") — a good hint adds something new, like "the same city where the video was filmed is mentioned in another one of the band's song titles" or "it's a common feature of West Coast urban art culture." ` +
    `Don't reveal the song title, and don't phrase it in a way that assumes the listener already knows what song is playing. ` +
    `IMPORTANT: if you used the fallback and wrote about something other than "${angle}", the "category" field in your response must match what you ACTUALLY wrote about, not the originally requested angle — the two must never be mismatched. ` +
    `Respond with ONLY JSON: {"question":"<question, under 35 words>","answer":"<short correct answer, a single name/date/number/phrase>","hint":"<a genuinely useful clue that adds new information not in the question, per the rules above>","funfact":"<one extra sentence of context that explains or expands on the answer, written so it makes sense even to someone unfamiliar with the term used in the answer>","category":"<one of: ${KNOWN_CATEGORIES.join(', ')} — whichever actually matches what the question is about>"}`;
}

// Name That Tune mode: the listener guesses the SONG TITLE after hearing a
// clip, not the answer to a trivia question — so unlike questionPrompt(),
// this must produce a declarative statement, never a question with its own
// answer to judge (a question here would invite the listener to answer it
// directly, but nothing checks that answer — only the guessed title matters).
function cluePrompt(trackName, artist, difficulty) {
  const level = (difficulty || 'Medium').toLowerCase();
  const guidance = DIFFICULTY_GUIDANCE[level] || DIFFICULTY_GUIDANCE.medium;
  return `You are a radio DJ setting up a "name that tune" round. The current song (the listener hasn't been told yet) is "${trackName}" by ${artist}. ` +
    `Write ONE short clue about the song as a plain statement of fact — never a question, and never asking the listener to pick between options or supply any answer of its own. ` +
    `Good clues describe things like the song's lyrical theme or story, its overall mood or vibe, or a genuinely well-known fact about it — something that helps someone who knows the song place it, without simply announcing the title or artist outright. ` +
    `${guidance} ` +
    `Only include a detail you are genuinely confident is accurate for this exact track by this exact artist — if unsure, stick to the song's general mood or lyrical theme, which you can describe accurately just from the song itself. ` +
    `Never state or spell out the song's title or the artist's name anywhere in the clue. ` +
    `Keep it to one sentence, under 30 words. ` +
    `Respond with ONLY JSON: {"clue":"<the one-sentence clue, a statement, not a question>","funfact":"<one extra sentence of context revealed after the song is identified — this one may mention the title or artist>","category":"<one of: ${KNOWN_CATEGORIES.join(', ')} — whichever best matches what the clue is about>"}`;
}

function judgePrompt(userText, correctAnswer) {
  return `Trivia answer check. Correct answer: "${correctAnswer}". User said: "${userText}". ` +
    `Are they equivalent in meaning (allow rough phrasing, partial names, misspellings)? Respond with ONLY JSON: {"correct": true|false}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured on the server.' });
    return;
  }

  const { type } = req.body || {};

  try {
    if (type === 'queue') {
      const { category } = req.body;
      if (!category) { res.status(400).json({ error: 'Missing category' }); return; }
      const result = await callClaude(queuePrompt(category));
      res.status(200).json(result || { searchQueries: [category], framing: '' });
      return;
    }

    if (type === 'question') {
      const { trackName, artist, difficulty } = req.body;
      if (!trackName || !artist) { res.status(400).json({ error: 'Missing trackName/artist' }); return; }
      const pool = anglesForDifficulty(difficulty);
      const { label, angle } = pool[Math.floor(Math.random() * pool.length)];
      const result = await callClaude(questionPrompt(trackName, artist, difficulty, angle));
      if (!result) { res.status(502).json({ error: 'Could not generate a question' }); return; }
      // Trust the model's self-reported category over our originally-picked
      // angle — the prompt allows it to fall back to a safer angle when it
      // isn't confident, and the spoken label must match what it actually
      // wrote, not what we asked for.
      const category = KNOWN_CATEGORIES.includes(result.category) ? result.category : label;
      res.status(200).json({ ...result, category });
      return;
    }

    if (type === 'clue') {
      const { trackName, artist, difficulty } = req.body;
      if (!trackName || !artist) { res.status(400).json({ error: 'Missing trackName/artist' }); return; }
      const result = await callClaude(cluePrompt(trackName, artist, difficulty));
      if (!result) { res.status(502).json({ error: 'Could not generate a clue' }); return; }
      const category = KNOWN_CATEGORIES.includes(result.category) ? result.category : 'Song';
      res.status(200).json({ ...result, category });
      return;
    }

    if (type === 'judge') {
      const { userText, correctAnswer } = req.body;
      if (!userText || !correctAnswer) { res.status(400).json({ error: 'Missing userText/correctAnswer' }); return; }
      const result = await callClaude(judgePrompt(userText, correctAnswer));
      res.status(200).json({ correct: result?.correct === true });
      return;
    }

    res.status(400).json({ error: 'Unknown type — expected "queue", "question", "clue", or "judge".' });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
}
