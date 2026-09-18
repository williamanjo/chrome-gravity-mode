const toggleButton = document.getElementById('toggle');
const autoRunInput = document.getElementById('autoRun');
const chanceInput = document.getElementById('chance');
const chanceValue = document.getElementById('chanceValue');
const statusLine = document.getElementById('status');

const lockIdle = document.getElementById('lockIdle');
const lockOn = document.getElementById('lockOn');
const lockPrompt = document.getElementById('lockPrompt');
const lockBadge = document.getElementById('lockBadge');
const lockReason = document.getElementById('lockReason');
const lockError = document.getElementById('lockError');
const lockNew = document.getElementById('lockNew');
const lockPass = document.getElementById('lockPass');
const lockSet = document.getElementById('lockSet');
const lockRemove = document.getElementById('lockRemove');
const lockConfirm = document.getElementById('lockConfirm');
const lockCancel = document.getElementById('lockCancel');

const DEFAULTS = { autoRun: false, chance: 20, lockSalt: '', lockHash: '' };

let settings = Object.assign({}, DEFAULTS);
let pendingAction = null;

// --------------------------------------------------------------------- senha

// A senha nunca e guardada em claro: fica so o SHA-256 dela com um salt
// aleatorio. Isso evita ler a senha no storage, mas nao e seguranca de
// verdade - quem tem acesso ao Chrome desliga a extensao por chrome://extensions.
function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function digest(password, salt) {
  const data = new TextEncoder().encode(salt + '|' + password);
  const buffer = await crypto.subtle.digest('SHA-256', data);
  return toHex(new Uint8Array(buffer));
}

function isLocked() {
  return Boolean(settings.lockHash);
}

async function matches(password) {
  if (!isLocked() || !password) return false;
  return (await digest(password, settings.lockSalt)) === settings.lockHash;
}

function renderLock() {
  lockBadge.classList.toggle('hidden', !isLocked());
  lockIdle.classList.toggle('hidden', isLocked() || Boolean(pendingAction));
  lockOn.classList.toggle('hidden', !isLocked() || Boolean(pendingAction));
  lockPrompt.classList.toggle('hidden', !pendingAction);
}

const REASONS = {
  deactivate: 'Digite a senha para desativar nesta aba.',
  autoRunOff: 'Digite a senha para desligar o modo automatico.',
  removeLock: 'Digite a senha atual para remove-la.'
};

function askPassword(action) {
  pendingAction = action;
  lockReason.textContent = REASONS[action];
  lockError.textContent = '';
  lockPass.value = '';
  renderLock();
  lockPass.focus();
}

function cancelPrompt() {
  pendingAction = null;
  lockPass.value = '';
  lockError.textContent = '';
  renderLock();
}

// --------------------------------------------------------------------- abas

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

async function toggleTab() {
  const tab = await activeTab();
  render(await send(tab.id, 'gravity:toggle', { chance: Number(chanceInput.value) }));
}

async function setAutoRun(value) {
  settings.autoRun = value;
  autoRunInput.checked = value;
  await chrome.storage.sync.set({ autoRun: value });
}

// ------------------------------------------------------------------- eventos

toggleButton.addEventListener('click', async () => {
  const tab = await activeTab();
  const state = await send(tab.id, 'gravity:status');

  // Ligar nunca pede senha; so desligar.
  if (state && state.armed && isLocked()) {
    askPassword('deactivate');
    return;
  }
  await toggleTab();
});

autoRunInput.addEventListener('change', async () => {
  if (!autoRunInput.checked && isLocked()) {
    autoRunInput.checked = true;
    askPassword('autoRunOff');
    return;
  }
  await setAutoRun(autoRunInput.checked);
});

chanceInput.addEventListener('input', () => {
  chanceValue.textContent = chanceInput.value + '%';
});

chanceInput.addEventListener('change', async () => {
  const chance = Number(chanceInput.value);
  settings.chance = chance;
  chrome.storage.sync.set({ chance });

  // Se a aba ja esta armada, o novo valor passa a valer sem reativar.
  const tab = await activeTab();
  const state = await send(tab.id, 'gravity:chance', { chance });
  if (state) render(state);
});

lockSet.addEventListener('click', async () => {
  const password = lockNew.value.trim();
  if (password.length < 3) {
    lockError.textContent = 'Use pelo menos 3 caracteres.';
    return;
  }

  const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
  settings.lockSalt = salt;
  settings.lockHash = await digest(password, salt);
  await chrome.storage.sync.set({ lockSalt: settings.lockSalt, lockHash: settings.lockHash });

  lockNew.value = '';
  lockError.textContent = '';
  renderLock();
});

lockRemove.addEventListener('click', () => askPassword('removeLock'));
lockCancel.addEventListener('click', cancelPrompt);

lockConfirm.addEventListener('click', async () => {
  if (!(await matches(lockPass.value))) {
    lockError.textContent = 'Senha incorreta.';
    lockPass.value = '';
    lockPass.focus();
    return;
  }

  const action = pendingAction;
  cancelPrompt();

  if (action === 'deactivate') {
    await toggleTab();
  } else if (action === 'autoRunOff') {
    await setAutoRun(false);
  } else if (action === 'removeLock') {
    settings.lockSalt = '';
    settings.lockHash = '';
    await chrome.storage.sync.set({ lockSalt: '', lockHash: '' });
    renderLock();
  }
});

lockPass.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') lockConfirm.click();
  if (event.key === 'Escape') cancelPrompt();
});

lockNew.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') lockSet.click();
});

(async () => {
  settings = await chrome.storage.sync.get(DEFAULTS);
  autoRunInput.checked = settings.autoRun;
  chanceInput.value = settings.chance;
  chanceValue.textContent = settings.chance + '%';
  renderLock();

  const tab = await activeTab();
  render(await send(tab.id, 'gravity:status'));
})();
