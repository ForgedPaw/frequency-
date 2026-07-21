// Radio-tuner visual: horizontal frequency band + pointer, center readout,
// and an equalizer-style waveform that reacts differently per game state.

const ZONE_X = { MENU: 65, QUESTION: 155, REVEAL: 245, PLAYBACK: 335 };
const ZONE_LABEL_TEXT = { MENU: 'MENU', QUESTION: 'ASK', REVEAL: 'REVEAL', PLAYBACK: 'PLAY' };
const WAVE_BAR_COUNT = 9;

export function createDial(root) {
  const zoneLabels = Object.entries(ZONE_X).map(([key, x]) =>
    `<text class="zone-label" data-zone="${key}" x="${x}" y="18" text-anchor="middle">${ZONE_LABEL_TEXT[key]}</text>`
  ).join('');

  root.innerHTML = `
    <div class="tuner-wrap">
      <svg class="tuner" viewBox="0 0 400 66" preserveAspectRatio="xMidYMid meet">
        <line x1="20" y1="40" x2="380" y2="40" stroke="#252B38" stroke-width="2"/>
        <g id="ticks"></g>
        ${zoneLabels}
        <g class="pointer" id="pointer">
          <polygon points="0,52 -7,64 7,64" fill="var(--amber)"/>
        </g>
      </svg>
    </div>
    <img class="album-art" id="albumArt" alt="" style="display:none;" />
    <div class="center-readout">
      <div class="state-name" id="stateName">Menu</div>
      <div class="state-sub" id="stateSub">Choose a category to start</div>
    </div>
    <div class="wave" id="wave">
      ${'<span></span>'.repeat(WAVE_BAR_COUNT)}
    </div>
  `;

  const $ = (id) => root.querySelector('#' + id);
  const pointer = $('pointer');
  const stateName = $('stateName');
  const stateSub = $('stateSub');
  const wave = $('wave');
  const ticksG = $('ticks');
  const albumArt = $('albumArt');
  const zoneLabelEls = [...root.querySelectorAll('.zone-label')];

  for (let x = 20; x <= 380; x += 12) {
    const isMajor = Object.values(ZONE_X).some((zx) => Math.abs(zx - x) < 6);
    const l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    l.setAttribute('x1', x); l.setAttribute('y1', isMajor ? 32 : 35);
    l.setAttribute('x2', x); l.setAttribute('y2', 40);
    l.setAttribute('stroke', '#252B38');
    l.setAttribute('stroke-width', isMajor ? 1.5 : 1);
    ticksG.appendChild(l);
  }

  let waveTimer = null;

  function setZone(stateKey) {
    const x = ZONE_X[stateKey] ?? ZONE_X.MENU;
    pointer.setAttribute('transform', `translate(${x},0)`);
    zoneLabelEls.forEach((el) => el.classList.toggle('active', el.dataset.zone === stateKey));
  }

  function setReadout(name, sub) {
    stateName.textContent = name;
    stateSub.textContent = sub;
  }

  function setAlbumArt(url) {
    if (url) {
      albumArt.src = url;
      albumArt.style.display = 'block';
    } else {
      albumArt.style.display = 'none';
      albumArt.src = '';
    }
  }

  function waveMode(mode) {
    // 'idle' | 'listening' | 'playing' | 'thinking'
    wave.classList.remove('listening', 'playing', 'thinking');
    clearInterval(waveTimer);
    const bars = [...wave.children];

    if (mode === 'idle') {
      bars.forEach((b) => { b.style.animation = ''; b.style.height = '4px'; });
      return;
    }
    if (mode === 'thinking') {
      wave.classList.add('thinking');
      bars.forEach((b, i) => { b.style.animation = `eqPulse 1.1s ease-in-out ${i * 0.08}s infinite`; b.style.height = ''; });
      return;
    }
    // listening / playing: irregular flicker feels more like live audio than a synced pulse
    wave.classList.add(mode);
    bars.forEach((b) => { b.style.animation = ''; });
    waveTimer = setInterval(() => {
      bars.forEach((b) => { b.style.height = 4 + Math.random() * 28 + 'px'; });
    }, 130);
  }

  waveMode('idle');

  return { setNeedle: setZone, setReadout, waveMode, setAlbumArt };
}
