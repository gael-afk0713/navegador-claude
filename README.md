# navegador-claude

Um Chromium headless que o Claude Code opera via MCP, com uma visão ao vivo para assistir (e aprovar ações) pelo Safari do iPad.

## Instalação (Codespaces / Ubuntu)

```bash
npm install
npx playwright install --with-deps chromium
```

## Como abrir

1. Nesta pasta, rode `claude` (o navegador sobe junto com a sessão; não precisa rodar `npm start`).
2. Na primeira vez, aprove o servidor `navegador` (ou confira em `/mcp`).
3. Peça ao Claude, por exemplo: *"abra google.com e pesquise por previsão do tempo"*.
4. Para assistir, digite `/navegador` no `claude` (ou rode `npm run link` em outro terminal): aparece o link e um QR code para abrir no iPad.

Depois de mudar o código do servidor, rode `/mcp` → `navegador` → **Reconnect** (ou reinicie o `claude`) para carregar a versão nova.

O servidor já está registrado no projeto (`.mcp.json`, criado com `claude mcp add --scope project navegador -- node server.js`). Na primeira vez que você abrir `claude` nesta pasta, aprove o servidor `navegador`.

O navegador já abre no Google (`https://www.google.com`). Para outra página inicial, defina `NAVEGADOR_INICIAL` (ou `about:blank` para começar em branco).

## Ferramentas MCP

| Ferramenta | O que faz |
| --- | --- |
| `abrir_url` | Abre uma URL (adiciona `https://` se faltar) |
| `clicar` | Clica por `texto` visível, por `seletor` ou nas coordenadas `x`/`y` da tela; `botao` (esquerdo/direito/meio) e `duplo` opcionais |
| `mover_mouse` | Move o mouse até `x`/`y` (hover: menus, tooltips) |
| `arrastar` | Arrasta de `de_x`/`de_y` até `para_x`/`para_y` (sliders, arrastar e soltar, selecionar texto) |
| `digitar` | Digita em um `seletor` (ou no campo focado); `pressionar_enter` opcional |
| `pressionar_tecla` | Tecla ou atalho no campo focado (`Enter`, `Tab`, `ArrowDown`, `Control+A`…); `vezes` opcional |
| `rolar` | Rola `baixo`/`cima` por N pixels, opcionalmente com o mouse em `x`/`y` (painéis com rolagem própria) |
| `ler_texto_da_pagina` | Título, URL e texto visível (até 20 mil caracteres); `seletor` opcional para ler só uma parte |
| `listar_elementos` | Links, botões, campos e menus visíveis com o centro em `x`/`y`, para clicar com precisão; `filtro` por rótulo e `toda_pagina` opcionais |
| `navegar_historico` | `voltar`, `avancar` ou `recarregar` |
| `esperar` | Espera um `texto` ou `seletor` aparecer (até `segundos`), ou só aguarda |
| `selecionar_opcao` | Escolhe uma opção de `<select>` por texto ou value (lista por `seletor` ou `x`/`y`) |
| `abas` | `listar`, `trocar`, `nova` ou `fechar` abas |
| `tirar_screenshot` | PNG da área visível ou da página inteira |

As coordenadas são pixels do screenshot da área visível (viewport 1180×820). O mouse do Claude aparece como uma seta laranja com a etiqueta **Claude** embaixo, na visão ao vivo e nos screenshots que ele tira.

## Visão ao vivo

O mesmo processo do MCP serve uma página em `0.0.0.0:3000` com o navegador ao vivo (screenshot a cada 500 ms via WebSocket) e o log de cada ação. Ela só existe enquanto uma sessão do `claude` estiver aberta nesta pasta.

**Jeito mais fácil de abrir:** dentro do `claude`, digite `/navegador`; ou, em outro terminal, `npm run link`. Os dois mostram o link certo, um QR code (aponte a câmera do iPad) e se a visão já está no ar.

**Túnel da Cloudflare.** Junto com a visão, o servidor sobe um túnel rápido da Cloudflare (`https://….trycloudflare.com`), que abre direto no Safari, sem login do GitHub e sem o proxy de portas do Codespaces. Na primeira vez ele baixa o `cloudflared` oficial para `.navegador/`. O endereço do túnel muda a cada sessão do `claude`, então pegue o link de novo com `/navegador`. Se o túnel não subir, o link cai para a porta do Codespaces (`https://<nome-do-codespace>-3000.app.github.dev`, privada: entre no GitHub no Safari). Para desligar o túnel: `NAVEGADOR_TUNEL=0`.

**Token de acesso.** Todo link termina em `?t=<token>`; sem ele, a página e o WebSocket são recusados (quem acessa a visão pode aprovar ações). O token fica em `.navegador/token` e vale entre sessões; na primeira visita o Safari também grava um cookie. Para trocar o token, apague esse arquivo e reinicie o `claude`. Não compartilhe o link.

### Pedir coisas ao Claude pela página

Na barra lateral há o campo **Peça algo ao Claude…**: escreva o pedido (Enter envia, Shift+Enter quebra a linha) e a resposta aparece ali mesmo, junto com as ações. Não precisa voltar ao terminal.

- Cada pedido roda um `claude -p` em segundo plano, ligado a **este mesmo navegador** pelo MCP em HTTP (`/mcp`, protegido pelo mesmo token). Ele usa o login do Claude Code deste computador.
- Os pedidos seguintes continuam a mesma conversa; **Nova** começa outra. Enquanto ele trabalha, o botão vira **■** para parar.
- Ele só tem as ferramentas do navegador (nada de terminal nem de arquivos), e as mesmas regras de segurança valem: envios e compras pedem confirmação na página.
- Para usar outro executável do claude: `NAVEGADOR_CLAUDE=/caminho/do/claude`.

### Controle manual

Toque em **Controlar** na barra do topo para usar o navegador você mesmo (útil para CAPTCHAs e logins):

- **Toque/clique** na imagem = clique no navegador; **arrastar** ou roda do mouse = rolar.
- **Teclado:** com a tela focada, um teclado físico digita direto. No iPad, use o campo abaixo da tela (Enviar, ou Enter para enviar + Enter) e os botões Enter, ⌫, Tab e Esc.
- **Barra de endereço:** edite a URL e pressione Enter; ←, → e ⟳ voltam, avançam e recarregam.

As suas ações não pedem confirmação nem têm o bloqueio de senha/cartão (quem decide é você). O texto digitado não vai para o log.

## Segurança

- **Envios de formulário e compras** (botões de envio, Enter em formulários, textos como "Comprar", "Pagar", "Checkout", "Assinar"…) abrem um pedido de confirmação na visão ao vivo. Sem resposta em 2 minutos, ou sem ninguém assistindo, a ação é negada. Buscas (formulários GET/de busca) não pedem confirmação.
- Duas barreiras extras pegam envios disparados por JavaScript: um interceptador do evento `submit` na página e o bloqueio de navegações não-GET na rede.
- **Senhas e cartões nunca são digitados**: campos `password`, campos de cartão/CVV/validade (por `autocomplete`, nome, rótulo ou placeholder) e qualquer texto que pareça número de cartão (Luhn) são recusados. O texto digitado não aparece no log, só o tamanho.
- Limitação: envios feitos por `fetch`/XHR em sites SPA só são detectados pelo clique ou Enter que os dispara.

## Testes

```bash
npm test
```

Sobe o servidor via stdio como o Claude faria, usa um site local e um espectador WebSocket que aprova/recusa confirmações. O chat é testado com um `claude` falso (`test/claude-falso.js`) que usa o `/mcp` em HTTP.
