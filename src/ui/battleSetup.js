// Battle mode setup wizard: player count + names (typed) → target score →
// category. Difficulty is chosen on the landing page and passed in via
// deps.difficulty. Calls onComplete once all choices are made.

import { MY_LIBRARY_KEY } from '../state/gameMachine.js';

const CATEGORIES = [
  { label: 'Genre: Classic Rock', value: 'classic rock genre' },
  { label: 'Era: The 90s', value: '1990s hits era' },
  { label: 'Band: Fleetwood Mac', value: 'Fleetwood Mac' },
  { label: 'My Spotify', value: MY_LIBRARY_KEY },
  { label: 'Custom (say it)', value: 'custom' },
];

export function createBattleSetup(root, deps) {
  const { speak, listen, difficulty, onComplete } = deps;

  const choice = { playerCount: 2, targetScore: 5 };

  renderPlayerStep();

  function renderPlayerStep() {
    root.innerHTML = `
      <h2>Frequency</h2>
      <p class="setup-step-label">How many players?</p>
      <div class="setup-row" id="playerCountRow">
        <button class="cat-btn setup-choice${choice.playerCount === 2 ? ' active' : ''}" data-count="2">2 players</button>
        <button class="cat-btn setup-choice${choice.playerCount === 3 ? ' active' : ''}" data-count="3">3 players</button>
      </div>
      <p class="setup-step-label">Names</p>
      <div id="nameFields"></div>
      <button class="start-btn stacked-btn" id="namesContinueBtn" type="button">Continue</button>
    `;

    const nameFields = root.querySelector('#nameFields');
    let inputs = [];

    function renderInputs() {
      const prevValues = inputs.map((inp) => inp.value);
      nameFields.innerHTML = '';
      inputs = [];
      for (let i = 0; i < choice.playerCount; i++) {
        const row = document.createElement('div');
        row.className = 'setup-name-row';
        row.innerHTML = `<input type="text" class="text-input" placeholder="Player ${i + 1} name" maxlength="24" />`;
        nameFields.appendChild(row);
        const input = row.querySelector('input');
        if (prevValues[i]) input.value = prevValues[i];
        inputs.push(input);
      }
    }
    renderInputs();

    root.querySelector('#playerCountRow').addEventListener('click', (e) => {
      const btn = e.target.closest('.setup-choice');
      if (!btn) return;
      choice.playerCount = Number(btn.dataset.count);
      root.querySelectorAll('#playerCountRow .setup-choice').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      renderInputs();
    });

    root.querySelector('#namesContinueBtn').addEventListener('click', () => {
      const names = inputs.map((inp, i) => inp.value.trim() || `Player ${i + 1}`);
      renderScoreStep(names);
    });
  }

  function renderScoreStep(names) {
    root.innerHTML = `
      <h2>Frequency</h2>
      <p class="setup-step-label">First to how many points wins?</p>
      <div class="setup-row" id="targetRow">
        ${[3, 5, 10].map((n) => `<button class="cat-btn setup-choice${choice.targetScore === n ? ' active' : ''}" data-target="${n}">${n}</button>`).join('')}
      </div>
      <input type="number" class="text-input" id="customTarget" placeholder="Or type a custom number" min="1" max="50" />
      <button class="start-btn stacked-btn" id="scoreContinueBtn" type="button" style="margin-top:14px;">Continue</button>
    `;

    root.querySelector('#targetRow').addEventListener('click', (e) => {
      const btn = e.target.closest('.setup-choice');
      if (!btn) return;
      choice.targetScore = Number(btn.dataset.target);
      root.querySelector('#customTarget').value = '';
      root.querySelectorAll('#targetRow .setup-choice').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
    });

    root.querySelector('#customTarget').addEventListener('input', (e) => {
      const n = parseInt(e.target.value, 10);
      if (n > 0) {
        choice.targetScore = n;
        root.querySelectorAll('#targetRow .setup-choice').forEach((b) => b.classList.remove('active'));
      }
    });

    root.querySelector('#scoreContinueBtn').addEventListener('click', () => {
      renderCategoryStep(names);
    });
  }

  function renderCategoryStep(names) {
    root.innerHTML = `
      <h2>Frequency</h2>
      <p class="setup-step-label">Pick a category for the battle</p>
      <div class="categories" id="battleCategories" style="display:grid;">
        ${CATEGORIES.map((c) => `<button class="cat-btn" data-cat="${c.value}">${c.label}</button>`).join('')}
      </div>
    `;

    root.querySelector('#battleCategories').addEventListener('click', (e) => {
      const btn = e.target.closest('.cat-btn');
      if (!btn) return;
      const value = btn.dataset.cat;
      if (value === 'custom') {
        speak('What category would you like? Say a genre, decade, or band.', () => {
          listen((text) => complete(names, text));
        });
        return;
      }
      complete(names, value);
    });
  }

  function complete(names, categoryText) {
    onComplete({
      playerNames: names,
      targetScore: choice.targetScore,
      difficulty,
      category: categoryText,
      isMyLibrary: categoryText === MY_LIBRARY_KEY,
    });
  }
}
