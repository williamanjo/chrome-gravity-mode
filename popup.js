const toggleButton = document.getElementById('toggle');
const autoRunInput = document.getElementById('autoRun');
const chanceInput = document.getElementById('chance');
const chanceValue = document.getElementById('chanceValue');
const statusLine = document.getElementById('status');

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function send(tabId, type, extra) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, Object.assign({ type }, extra), (response) => {
      // Paginas internas (chrome://, web store) nao recebem content script.
      if (chrome.runtime.lastError) resolve(null);
      else resolve(response);
    });
  });
}

function render(state) {
  if (state === null) {
    toggleButton.disabled = true;
    toggleButton.textContent = 'Indisponivel nesta pagina';
    statusLine.textContent = 'O Chrome bloqueia extensoes nesta URL.';
    return;
  }
  toggleButton.disabled = false;
  toggleButton.textContent = state.armed ? 'Desativar nesta aba' : 'Ativar nesta aba';
  toggleButton.classList.toggle('off', state.armed);

  if (state.falling) {
    statusLine.textContent = 'Pagina desabada. Esc restaura.';
  } else if (state.armed) {
    statusLine.textContent = 'Armado: ' + state.chance + '% a cada entrada do mouse.';
  } else {
    statusLine.textContent = '';
  }
}

toggleButton.addEventListener('click', async () => {
  const tab = await activeTab();
  render(await send(tab.id, 'gravity:toggle', { chance: Number(chanceInput.value) }));
});

chanceInput.addEventListener('input', () => {
  chanceValue.textContent = chanceInput.value + '%';
});

chanceInput.addEventListener('change', async () => {
  const chance = Number(chanceInput.value);
  chrome.storage.sync.set({ chance });

  // Se a aba ja esta armada, o novo valor passa a valer sem reativar.
  const tab = await activeTab();
  const state = await send(tab.id, 'gravity:chance', { chance });
  if (state) render(state);
});

autoRunInput.addEventListener('change', () => {
  chrome.storage.sync.set({ autoRun: autoRunInput.checked });
});

(async () => {
  const settings = await chrome.storage.sync.get({ autoRun: false, chance: 20 });
  autoRunInput.checked = settings.autoRun;
  chanceInput.value = settings.chance;
  chanceValue.textContent = settings.chance + '%';

  const tab = await activeTab();
  render(await send(tab.id, 'gravity:status'));
})();
