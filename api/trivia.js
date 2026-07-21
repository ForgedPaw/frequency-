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

// Name That Tune mode: the listener guesses the SONG TITLE after hearing a
// clip, not the answer to a trivia question — so this must produce a
// declarative statement, never a question with its own answer to judge (a
// question here would invite the listener to answer it directly, but
// nothing checks that answer — only the guessed title matters).
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

    res.status(400).json({ error: 'Unknown type — expected "queue", "clue", or "judge".' });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
}
