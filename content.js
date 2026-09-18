/**
 * Gravity Mode - content script.
 *
 * Fluxo: o popup "arma" a pagina. O primeiro mousemove depois disso dispara a
 * queda: cada elemento vira um corpo rigido (AABB) posicionado em fixed na
 * viewport, e um loop de fisica integra gravidade, colisao com chao/paredes e
 * empilhamento entre corpos. O mouse funciona como vassoura e tambem arrasta.
 */
(() => {
  if (window.__gravityModeLoaded) return;
  window.__gravityModeLoaded = true;

  const CONFIG = {
    gravity: 2400,        // px/s^2
    restitution: 0.28,    // quique
    friction: 0.86,       // atrito tangencial no impacto
    airDrag: 0.999,
    angularDrag: 0.985,
    maxBodies: 170,
    solverIterations: 5,
    sleepSpeed: 4,        // px/s abaixo disso o corpo dorme
    sweepRadius: 90,      // raio da "vassoura" do mouse
    sweepForce: 2.2,
    maxDt: 1 / 30
  };

  const MEDIA_TAGS = new Set(['IMG', 'SVG', 'VIDEO', 'IFRAME', 'CANVAS', 'INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'HR']);
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'BR']);

  // Só estas tags viram peça. Qualquer outro elemento (wrapper de framework,
  // custom element do Angular, etc.) serve apenas de caminho: a busca desce
  // nele até achar o conteudo de verdade.
  const PIECE_TAGS = new Set([
    'P', 'DIV', 'A', 'SPAN', 'STRONG', 'EM', 'B', 'I', 'SMALL', 'CODE', 'PRE', 'BLOCKQUOTE',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'UL', 'OL', 'LI', 'DL', 'DT', 'DD',
    'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'CAPTION',
    'SECTION', 'ARTICLE', 'ASIDE', 'HEADER', 'FOOTER', 'NAV', 'MAIN', 'FORM', 'FIELDSET', 'LEGEND',
    'LABEL', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'OPTION',
    'IMG', 'SVG', 'VIDEO', 'AUDIO', 'IFRAME', 'CANVAS', 'PICTURE', 'FIGURE', 'FIGCAPTION',
    'DETAILS', 'SUMMARY', 'HR', 'TIME', 'BADGE', 'MARK'
  ]);
  const TRANSPARENT = /^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$|^transparent$/;

  let world = null;
  let armed = false;
  let armChance = 100;
  let styleCache = null;

  // ---------------------------------------------------------------- coleta

  function ancestorBreaksFixed(el) {
    let node = el.parentElement;
    while (node && node !== document.body && node !== document.documentElement) {
      let broken = styleCache.get(node);
      if (broken === undefined) {
        const cs = getComputedStyle(node);
        broken =
          cs.transform !== 'none' ||
          cs.perspective !== 'none' ||
          cs.filter !== 'none' ||
          cs.willChange.indexOf('transform') !== -1 ||
          cs.contain.indexOf('paint') !== -1 ||
          cs.contain.indexOf('layout') !== -1;
        styleCache.set(node, broken);
      }
      if (broken) return true;
      node = node.parentElement;
    }
    return false;
  }

  // Um elemento com visual proprio (fundo, borda, sombra) deve cair inteiro,
  // como uma peca so - e o que faz cards e barras se comportarem como blocos.
  function hasOwnVisual(cs) {
    if (cs.backgroundImage !== 'none') return true;
    if (!TRANSPARENT.test(cs.backgroundColor)) return true;
    if (cs.boxShadow !== 'none') return true;
    return (
      parseFloat(cs.borderTopWidth) > 0 ||
      parseFloat(cs.borderRightWidth) > 0 ||
      parseFloat(cs.borderBottomWidth) > 0 ||
      parseFloat(cs.borderLeftWidth) > 0
    );
  }

  function hasDirectText(el) {
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE && node.nodeValue.trim().length > 0) return true;
    }
    return false;
  }

  function textRect(el) {
    if (!el.textContent.trim()) return null;
    const range = document.createRange();
    range.selectNodeContents(el);
    const rect = range.getBoundingClientRect();
    range.detach();
    return rect.width > 0 && rect.height > 0 ? rect : null;
  }

  /**
   * Desce a arvore de cima para baixo e para no primeiro nivel que ja e uma
   * "peca" visual. Assim um card cai inteiro, com titulo e botao dentro, em vez
   * de virar uma casca vazia com os filhos caindo sozinhos.
   */
  function collectElements() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const picked = [];

    const walk = (el) => {
      if (picked.length >= CONFIG.maxBodies) return;
      if (SKIP_TAGS.has(el.tagName)) return;

      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05) return;

      const children = Array.from(el.children);
      const rect = el.getBoundingClientRect();

      // Wrappers de SPA costumam ter rect zerado ou fora da viewport mesmo com
      // filhos visiveis (filhos absolutos, display:contents, router outlets).
      // Nesse caso desce em vez de podar a arvore inteira.
      const degenerate = rect.width < 4 || rect.height < 4;
      const offscreen = rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw;
      if (degenerate || offscreen) {
        if (!children.length) return;
        for (const child of children) walk(child);
        return;
      }
      // Blocos que ocupam mais de ~1/5 da tela sao container, nao peca: descer
      // neles rende pedacos do tamanho de botao, label e linha de tabela.
      const tooBig = rect.height > vh * 0.9 || rect.width * rect.height > vw * vh * 0.22;

      // Caixa gigante com so um texto dentro (hero centralizado em flex): a
      // caixa nao serve como peca, mas o texto sim - mede o retangulo real dele.
      if (tooBig && !children.length) {
        const textBox = textRect(el);
        if (textBox && textBox.width >= 8 && textBox.height >= 8 && textBox.height < vh * 0.9) {
          picked.push({ el, rect: textBox });
        }
        return;
      }

      const isPiece =
        !tooBig &&
        (PIECE_TAGS.has(el.tagName) || children.length === 0) &&
        rect.width >= 8 &&
        rect.height >= 8 &&
        (MEDIA_TAGS.has(el.tagName) || hasOwnVisual(cs) || hasDirectText(el) || children.length === 0);

      if (isPiece) {
        if (MEDIA_TAGS.has(el.tagName) || el.textContent.trim().length > 0 || hasOwnVisual(cs)) {
          picked.push({ el, rect });
        }
        return;
      }

      for (const child of children) walk(child);
    };

    for (const child of Array.from(document.body.children)) walk(child);
    return picked;
  }

  // ---------------------------------------------------------------- mundo

  function createWorld(picked) {
    styleCache = new Map();

    // Passo 1: fotografa tudo ANTES de mexer no DOM, porque o primeiro
    // position:fixed ja reflui a pagina inteira e invalida os rects.
    const prepared = picked.map((item) => ({
      el: item.el,
      rect: item.rect,
      needsReparent: ancestorBreaksFixed(item.el)
    }));
    styleCache = null;

    // Trava o scroll e apaga o que nao caiu: o resto da pagina reflui quando os
    // elementos saem do fluxo, e o conteudo de baixo subiria por cima da cena.
    // visibility e herdada, mas cada peca a reativa em si mesma.
    const html = document.documentElement;
    const prevOverflow = html.style.overflow;
    const prevVisibility = document.body.style.visibility;
    html.style.overflow = 'hidden';
    document.body.style.visibility = 'hidden';

    const bodies = [];
    const restore = [];

    prepared.forEach((item, index) => {
      const el = item.el;
      const rect = item.rect;

      restore.push({
        el: el,
        cssText: el.style.cssText,
        parent: item.needsReparent ? el.parentNode : null,
        next: item.needsReparent ? el.nextSibling : null
      });

      if (item.needsReparent) document.body.appendChild(el);

      el.style.setProperty('position', 'fixed', 'important');
      el.style.setProperty('left', '0', 'important');
      el.style.setProperty('top', '0', 'important');
      el.style.setProperty('margin', '0', 'important');
      el.style.setProperty('width', rect.width + 'px', 'important');
      el.style.setProperty('height', rect.height + 'px', 'important');
      el.style.setProperty('max-width', 'none', 'important');
      el.style.setProperty('max-height', 'none', 'important');
      el.style.setProperty('transition', 'none', 'important');
      el.style.setProperty('visibility', 'visible', 'important');
      el.style.setProperty('pointer-events', 'none', 'important');
      el.style.setProperty('z-index', String(2147480000 + index), 'important');
      el.style.setProperty('will-change', 'transform', 'important');

      bodies.push({
        el: el,
        x: rect.left,
        y: rect.top,
        w: rect.width,
        h: rect.height,
        vx: (Math.random() - 0.5) * 30,
        vy: 0,
        angle: 0,
        va: (Math.random() - 0.5) * 0.8,
        mass: Math.max(1, (rect.width * rect.height) / 5000),
        asleep: false,
        dragged: false
      });
    });

    return {
      bodies: bodies,
      restore: restore,
      prevOverflow: prevOverflow,
      prevVisibility: prevVisibility,
      raf: 0,
      lastTime: 0
    };
  }

  function draw(body) {
    body.el.style.setProperty(
      'transform',
      'translate(' + body.x.toFixed(2) + 'px, ' + body.y.toFixed(2) + 'px) rotate(' + body.angle.toFixed(3) + 'rad)',
      'important'
    );
  }

  // ---------------------------------------------------------------- fisica

  function integrate(bodies, dt) {
    const floor = window.innerHeight;
    const rightWall = window.innerWidth;

    for (const b of bodies) {
      if (b.dragged || b.asleep) continue;

      b.vy += CONFIG.gravity * dt;
      b.vx *= CONFIG.airDrag;
      b.va *= CONFIG.angularDrag;

      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.angle += b.va * dt;

      if (b.y + b.h > floor) {
        b.y = floor - b.h;
        if (b.vy > 0) b.vy = -b.vy * CONFIG.restitution;
        b.vx *= CONFIG.friction;
        b.va = b.va * CONFIG.friction + b.vx * 0.002;
      }
      if (b.x < 0) {
        b.x = 0;
        if (b.vx < 0) b.vx = -b.vx * CONFIG.restitution;
      }
      if (b.x + b.w > rightWall) {
        b.x = rightWall - b.w;
        if (b.vx > 0) b.vx = -b.vx * CONFIG.restitution;
      }

      if (Math.abs(b.vx) + Math.abs(b.vy) < CONFIG.sleepSpeed && b.y + b.h >= floor - 1) {
        b.asleep = true;
        b.vx = 0;
        b.vy = 0;
        b.va *= 0.5;
      }
    }
  }

  function resolveCollisions(bodies) {
    const n = bodies.length;

    for (let iter = 0; iter < CONFIG.solverIterations; iter++) {
      for (let i = 0; i < n; i++) {
        const a = bodies[i];
        for (let j = i + 1; j < n; j++) {
          const b = bodies[j];

          const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
          if (overlapX <= 0) continue;
          const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
          if (overlapY <= 0) continue;

          const totalMass = a.mass + b.mass;
          const aShare = a.dragged ? 0 : b.dragged ? 1 : b.mass / totalMass;
          const bShare = 1 - aShare;

          // Separa pelo eixo de menor penetracao (MTV).
          if (overlapY < overlapX) {
            const dir = a.y + a.h / 2 < b.y + b.h / 2 ? -1 : 1;
            a.y += overlapY * aShare * dir;
            b.y -= overlapY * bShare * dir;

            const relative = a.vy - b.vy;
            if ((dir === -1 && relative > 0) || (dir === 1 && relative < 0)) {
              const impulse = relative * (1 + CONFIG.restitution) * 0.5;
              if (!a.dragged) a.vy -= impulse;
              if (!b.dragged) b.vy += impulse;
            }
            a.vx *= CONFIG.friction;
            b.vx *= CONFIG.friction;
          } else {
            const dir = a.x + a.w / 2 < b.x + b.w / 2 ? -1 : 1;
            a.x += overlapX * aShare * dir;
            b.x -= overlapX * bShare * dir;

            const relative = a.vx - b.vx;
            if ((dir === -1 && relative > 0) || (dir === 1 && relative < 0)) {
              const impulse = relative * (1 + CONFIG.restitution) * 0.5;
              if (!a.dragged) a.vx -= impulse;
              if (!b.dragged) b.vx += impulse;
            }
          }

          if (overlapX > 0.5 && overlapY > 0.5) {
            a.asleep = false;
            b.asleep = false;
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------- mouse

  const pointer = { x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0 };
  let dragging = null;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  function bodyAt(x, y) {
    if (!world) return null;
    for (let i = world.bodies.length - 1; i >= 0; i--) {
      const b = world.bodies[i];
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b;
    }
    return null;
  }

  function sweep() {
    if (!world || dragging) return;
    const speed = Math.hypot(pointer.vx, pointer.vy);
    if (speed < 1) return;

    for (const b of world.bodies) {
      const reach = CONFIG.sweepRadius + Math.max(b.w, b.h) / 2;
      const dx = b.x + b.w / 2 - pointer.x;
      const dy = b.y + b.h / 2 - pointer.y;
      const dist = Math.hypot(dx, dy);
      if (dist > reach) continue;

      const falloff = 1 - dist / reach;
      const push = (CONFIG.sweepForce * falloff) / b.mass;
      const nx = dx / (dist || 1);

      b.vx += pointer.vx * push + nx * speed * 0.15 * falloff;
      b.vy += pointer.vy * push * 0.6;
      b.va += nx * 0.05 * falloff;
      b.asleep = false;
    }
  }

  function onPointerMove(event) {
    pointer.x = event.clientX;
    pointer.y = event.clientY;

    if (dragging) {
      dragging.x = pointer.x - dragOffsetX;
      dragging.y = pointer.y - dragOffsetY;
      dragging.asleep = false;
    }
  }

  function onPointerDown(event) {
    if (!world) return;
    const body = bodyAt(event.clientX, event.clientY);
    if (!body) return;

    event.preventDefault();
    dragging = body;
    dragging.dragged = true;
    dragging.asleep = false;
    dragOffsetX = event.clientX - body.x;
    dragOffsetY = event.clientY - body.y;
  }

  function onPointerUp() {
    if (!dragging) return;
    dragging.dragged = false;
    dragging.vx = pointer.vx * 12;
    dragging.vy = pointer.vy * 12;
    dragging.va = pointer.vx * 0.02;
    dragging = null;
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') stop();
  }

  // ---------------------------------------------------------------- loop

  function tick(now) {
    if (!world) return;

    const dt = Math.min(CONFIG.maxDt, world.lastTime ? (now - world.lastTime) / 1000 : 1 / 60);
    world.lastTime = now;

    // Velocidade do ponteiro em px por frame, usada como impulso da vassoura.
    pointer.vx = pointer.x - pointer.px;
    pointer.vy = pointer.y - pointer.py;
    pointer.px = pointer.x;
    pointer.py = pointer.y;

    sweep();
    integrate(world.bodies, dt);
    resolveCollisions(world.bodies);
    for (const b of world.bodies) draw(b);

    world.raf = requestAnimationFrame(tick);
  }

  // ---------------------------------------------------------------- ciclo

  function start() {
    if (world) return;

    const picked = collectElements();
    if (!picked.length) return;

    world = createWorld(picked);
    for (const b of world.bodies) draw(b);

    window.addEventListener('mousemove', onPointerMove, true);
    window.addEventListener('mousedown', onPointerDown, true);
    window.addEventListener('mouseup', onPointerUp, true);
    window.addEventListener('keydown', onKeyDown, true);

    world.raf = requestAnimationFrame(tick);
  }

  // Desfaz a queda e devolve a pagina. Nao desarma: continua valendo para a
  // proxima vez que o mouse entrar na pagina.
  function stop() {
    if (!world) return;

    cancelAnimationFrame(world.raf);
    window.removeEventListener('mousemove', onPointerMove, true);
    window.removeEventListener('mousedown', onPointerDown, true);
    window.removeEventListener('mouseup', onPointerUp, true);
    window.removeEventListener('keydown', onKeyDown, true);

    for (const entry of world.restore) {
      entry.el.style.cssText = entry.cssText;
      if (entry.parent) entry.parent.insertBefore(entry.el, entry.next);
    }
    document.documentElement.style.overflow = world.prevOverflow;
    document.body.style.visibility = world.prevVisibility;

    world = null;
    dragging = null;
  }

  /**
   * O gatilho e a ENTRADA do mouse na pagina, nao o movimento dentro dela:
   * `mouseenter` no documento so dispara quando o ponteiro vem de fora (barra do
   * navegador, outra janela, fora da tela). Andar com o mouse pela pagina nao
   * sorteia nada. Cada volta do ponteiro joga o dado de novo.
   */
  function onPageEnter(event) {
    if (world) return;

    pointer.x = pointer.px = event.clientX;
    pointer.y = pointer.py = event.clientY;

    if (Math.random() * 100 < armChance) start();
  }

  // Armar fica valendo ate o usuario desativar: nao e um tiro so.
  function arm(chance) {
    armChance = Math.min(100, Math.max(1, Number(chance) || 100));
    if (armed) return;

    armed = true;
    document.documentElement.addEventListener('mouseenter', onPageEnter);
  }

  function disarm() {
    if (!armed) return;
    document.documentElement.removeEventListener('mouseenter', onPageEnter);
    armed = false;
  }

  function deactivate() {
    disarm();
    stop();
  }

  function state() {
    return { armed: armed, falling: Boolean(world), chance: armChance };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'gravity:toggle') {
      if (armed) deactivate();
      else arm(message.chance);
      sendResponse(state());
    } else if (message.type === 'gravity:status') {
      sendResponse(state());
    } else if (message.type === 'gravity:chance') {
      if (armed) armChance = Math.min(100, Math.max(1, Number(message.chance) || 100));
      sendResponse(state());
    } else if (message.type === 'gravity:reset') {
      stop();
      sendResponse(state());
    }
    return true;
  });

  chrome.storage.sync.get({ autoRun: false, chance: 20 }, (settings) => {
    if (settings.autoRun) arm(settings.chance);
  });
})();
