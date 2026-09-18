// Tudo dentro de um IIFE: o popup roda em documentos de teste que tambem
// declaram variaveis globais, e vazar nomes daqui quebra os dois lados.
(() => {
  const toggleButton = document.getElementById('toggle');
  const autoRunInput = document.getElementById('autoRun');
  const autoRunLabel = document.getElementById('autoRunLabel');
  const chanceInput = document.getElementById('chance');
  const chanceValue = document.getElementById('chanceValue');
  const statusLine = document.getElementById('status');

  const lockIdle = document.getElementById('lockIdle');
  const lockOn = document.getElementById('lockOn');
  const lockPrompt = document.getElementById('lockPrompt');
  const lockBadge = document.getElementById('lockBadge');
  const lockReason = document.getElementById('lockReason');
  const lockError = document.getElementById('lockError');
  const lockPromptError = document.getElementById('lockPromptError');
  const lockNew = document.getElementById('lockNew');
  const lockPass = document.getElementById('lockPass');
  const lockSet = document.getElementById('lockSet');
  const lockRemove = document.getElementById('lockRemove');
  const lockConfirm = document.getElementById('lockConfirm');
  const lockCancel = document.getElementById('lockCancel');

  const DEFAULTS = { autoRun: false, chance: 20, lockSalt: '', lockHash: '' };

  let settings = Object.assign({}, DEFAULTS);
  let tabState = { armed: false, falling: false, chance: 20 };
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

  const REASONS = {
    globalOff: 'Digite a senha para desligar em todas as paginas.',
    deactivate: 'Digite a senha para desativar nesta aba.',
    autoRunOff: 'Digite a senha para desligar o modo automatico.',
    removeLock: 'Digite a senha atual para remove-la.'
  };

  function askPassword(action) {
    pendingAction = action;
    lockReason.textContent = REASONS[action];
    lockPromptError.textContent = '';
    lockPass.value = '';
    lockPrompt.classList.remove('hidden');
    lockPass.focus();
  }

  function closePrompt() {
    pendingAction = null;
    lockPass.value = '';
    lockPromptError.textContent = '';
    lockPrompt.classList.add('hidden');
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

  // -------------------------------------------------------------------- render

  function render(state) {
    lockBadge.classList.toggle('hidden', !isLocked());
    lockIdle.classList.toggle('hidden', isLocked());
    lockOn.classList.toggle('hidden', !isLocked());

    autoRunInput.checked = settings.autoRun;
    autoRunLabel.textContent = isLocked()
      ? 'Automatico em toda pagina (pede senha para desligar)'
      : 'Automatico em toda pagina';

    if (state === null) {
      // Sem content script nesta aba, mas o automatico continua sendo global.
      toggleButton.disabled = !settings.autoRun;
      toggleButton.textContent = settings.autoRun ? 'Desligar em todas as paginas' : 'Indisponivel nesta pagina';
      toggleButton.classList.toggle('off', settings.autoRun);
      statusLine.textContent = 'O Chrome bloqueia extensoes nesta URL.';
      return;
    }

    tabState = state;
    toggleButton.disabled = false;

    // Com o automatico ligado, desativar so a aba nao resolve nada: a proxima
    // pagina arma de novo. Entao o botao principal vira o desligamento global.
    if (settings.autoRun) {
      toggleButton.textContent = 'Desligar em todas as paginas';
      toggleButton.classList.add('off');
    } else {
      toggleButton.textContent = state.armed ? 'Desativar nesta aba' : 'Ativar nesta aba';
      toggleButton.classList.toggle('off', state.armed);
    }

    if (state.falling) {
      statusLine.textContent = 'Pagina desabada. Esc restaura.';
    } else if (settings.autoRun) {
      statusLine.textContent = 'Automatico ligado: ' + settings.chance + '% em toda pagina.';
    } else if (state.armed) {
      statusLine.textContent = 'Armado: ' + state.chance + '% a cada entrada do mouse.';
    } else {
      statusLine.textContent = '';
    }
  }

  async function refresh() {
    const tab = await activeTab();
    render(await send(tab.id, 'gravity:status'));
  }

  // --------------------------------------------------------------------- acoes

  async function toggleTab() {
    const tab = await activeTab();
    const state = await send(tab.id, 'gravity:toggle', { chance: Number(chanceInput.value) });
    render(state);
  }

  async function setAutoRun(value) {
    settings.autoRun = value;
    await chrome.storage.sync.set({ autoRun: value });
  }

  // Desliga de vez: tira o automatico e desarma a aba atual, se estiver armada.
  async function turnEverythingOff() {
    await setAutoRun(false);

    const tab = await activeTab();
    const state = await send(tab.id, 'gravity:status');
    if (state && state.armed) {
      render(await send(tab.id, 'gravity:toggle'));
    } else {
      render(state);
    }
  }

  async function runAction(action) {
    if (action === 'globalOff') await turnEverythingOff();
    else if (action === 'deactivate') await toggleTab();
    else if (action === 'autoRunOff') {
      await setAutoRun(false);
      await refresh();
    } else if (action === 'removeLock') {
      settings.lockSalt = '';
      settings.lockHash = '';
      await chrome.storage.sync.set({ lockSalt: '', lockHash: '' });
      await refresh();
    }
  }

  // Acoes que desligam algo passam pela senha; ligar e sempre livre.
  async function guard(action) {
    if (isLocked()) askPassword(action);
    else await runAction(action);
  }

  // ------------------------------------------------------------------- eventos

  toggleButton.addEventListener('click', async () => {
    if (settings.autoRun) {
      await guard('globalOff');
      return;
    }

    const tab = await activeTab();
    const state = await send(tab.id, 'gravity:status');
    if (state && state.armed) {
      await guard('deactivate');
      return;
    }
    await toggleTab();
  });

  autoRunInput.addEventListener('change', async () => {
    if (!autoRunInput.checked) {
      autoRunInput.checked = true;
      await guard('autoRunOff');
      return;
    }
    await setAutoRun(true);
    await refresh();
  });

  chanceInput.addEventListener('input', () => {
    chanceValue.textContent = chanceInput.value + '%';
  });

  chanceInput.addEventListener('change', async () => {
    const chance = Number(chanceInput.value);
    settings.chance = chance;
    await chrome.storage.sync.set({ chance });

    // Se a aba ja esta armada, o novo valor passa a valer sem reativar.
    const tab = await activeTab();
    render(await send(tab.id, 'gravity:chance', { chance }));
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
    await refresh();
  });

  lockRemove.addEventListener('click', () => askPassword('removeLock'));
  lockCancel.addEventListener('click', closePrompt);

  lockConfirm.addEventListener('click', async () => {
    if (!(await matches(lockPass.value))) {
      lockPromptError.textContent = 'Senha incorreta.';
      lockPass.value = '';
      lockPass.focus();
      return;
    }

    const action = pendingAction;
    closePrompt();
    await runAction(action);
  });

  lockPass.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') lockConfirm.click();
    if (event.key === 'Escape') closePrompt();
  });

  lockNew.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') lockSet.click();
  });

  (async () => {
    settings = await chrome.storage.sync.get(DEFAULTS);
    chanceInput.value = settings.chance;
    chanceValue.textContent = settings.chance + '%';
    await refresh();
  })();
})();
