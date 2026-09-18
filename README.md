# Gravity Mode

Extensão Chrome (Manifest V3) que derruba a página que nem o easter egg do Google Gravity.
Ativa pelo popup, e a queda dispara no primeiro movimento do mouse. Sem biblioteca de física:
o motor (integração, colisão AABB, empilhamento, arraste) está em `content.js`.

## Instalar

1. `chrome://extensions`
2. Ligue **Modo do desenvolvedor**
3. **Carregar sem compactação** → selecione esta pasta

## Usar

- Clique no ícone da extensão → **Ativar nesta aba** (fica ligado até você desativar)
- O gatilho é o mouse **entrar** na página — voltando de outra janela, da barra do navegador ou
  de fora da tela. Navegar com o mouse dentro da página não dispara nada
- Quando cai: os elementos batem no chão e empilham
- O mouse funciona como vassoura — passe rápido no meio da pilha para espalhar
- Clique e arraste um pedaço; solte para jogá-lo
- **Esc** devolve a página ao normal, mas a aba continua armada: a próxima entrada do mouse
  sorteia de novo. **Desativar nesta aba** no popup é que desliga de vez
- Checkbox **Ativar automático em toda página** deixa a extensão armada em qualquer site

## Chance de desabar

O slider **Chance de desabar** (1% a 100%, padrão 20%) é a probabilidade de a queda acontecer
**a cada vez que o mouse entra na página**. Em 100% desaba sempre; em 5% é roleta — você sai pro
Slack, volta pro Chrome e às vezes a página desaba. Mexer o slider com a aba já armada muda a
chance na hora, sem precisar reativar. O valor fica em `chrome.storage.sync`, então acompanha o
perfil do Chrome.

## Senha para desativar

No popup dá para definir uma senha. Com ela ativa, **Desativar nesta aba** e desligar o modo
automático passam a pedir a senha; ativar e mexer na chance continuam livres. A senha não é
guardada em claro — fica só o SHA-256 dela com um salt aleatório de 16 bytes, em
`chrome.storage.sync`. **Remover senha** também exige a senha atual.

Isso é trava de brincadeira, não segurança:

- não impede ninguém de desativar ou remover a extensão em `chrome://extensions` — nenhuma
  extensão pode bloquear a própria remoção (só política de empresa, com force-install)
- quem abrir o DevTools da página consegue restaurar o DOM na mão
- quem apagar os dados da extensão apaga o hash junto

Esqueceu a senha? Remova e reinstale a extensão, ou limpe o storage dela.

## Como as peças são escolhidas

`collectElements()` desce a árvore do DOM de cima para baixo e para no primeiro nível que já é
uma peça de conteúdo:

- só vira peça quem está na whitelist de tags (`p`, `div`, `a`, `span`, `table`, `tr`, `td`,
  `li`, `h1`–`h6`, `img`, `button`, `input`, `label`, `section`, `header`, …); qualquer outro
  elemento (wrapper de framework, custom element do Angular) serve só de caminho
- bloco maior que ~22% da tela é container, não peça: a busca desce nele — assim o que cai tem
  tamanho de botão, label ou linha de tabela, não de painel inteiro
- wrapper com rect zerado ou fora da viewport não poda a árvore (SPA com filhos absolutos)
- caixa gigante com um texto só dentro (hero centralizado) usa o retângulo real do texto,
  medido por `Range`
- limite de 170 corpos por queda

Ao cair, cada peça vira `position: fixed` com `width`/`height` congelados e `transform` por frame.
O resto da página recebe `visibility: hidden` (cada peça reativa a sua) para o conteúdo de baixo
não subir por cima da cena quando o layout reflui. `stop()` restaura `style.cssText`, o pai
original de quem precisou ser reparentado, o scroll e a visibilidade.

## Física

Corpos são AABB com massa proporcional à área. Por frame: gravidade, arrasto, integração,
colisão com chão e paredes (restituição 0.28, atrito 0.86) e 5 iterações de resolução
corpo-a-corpo pelo eixo de menor penetração. Corpo lento no chão dorme até ser tocado.
A rotação é visual — a colisão usa a caixa alinhada aos eixos.

## Arquivos

| Arquivo | Papel |
| --- | --- |
| `manifest.json` | MV3, content script em `<all_urls>`, permissões `storage` e `activeTab` |
| `content.js` | Coleta de peças + motor de física + ciclo armar/parar |
| `popup.html` / `popup.js` | Ativar/desativar, slider de chance, modo automático e a senha |
| `test/local-demo.html` | Página de teste que injeta o content script com um stub da API `chrome` |
| `test/popup-preview.html` | Abre o popup real fora do Chrome, com as APIs de extensão stubadas |

## Teste local

Sirva a pasta e abra a demo (o `file://` não roda o script com o stub):

```bash
python -m http.server 8765 --bind 127.0.0.1
```

Depois abra <http://127.0.0.1:8765/test/local-demo.html> e tire/traga o mouse para a página. Use
`?chance=NN` para testar a probabilidade (`?chance=100` desaba sempre, `?chance=1` quase nunca).

Para mexer no popup sem instalar a extensão:
<http://127.0.0.1:8765/test/popup-preview.html> — ele stuba `chrome.storage` e `chrome.tabs` e
mostra num log lateral cada mensagem e cada gravação no storage.
