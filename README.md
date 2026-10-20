# navegador-claude

Um Chromium headless que o Claude Code opera via MCP, com uma visão ao vivo para assistir (e aprovar ações) pelo Safari do iPad.

## Instalação (Codespaces / Ubuntu)

```bash
npm install
npx playwright install --with-deps chromium
```

O servidor já está registrado no projeto (`.mcp.json`, criado com `claude mcp add --scope project navegador -- node server.js`). Na primeira vez que você abrir `claude` nesta pasta, aprove o servidor `navegador`.

## Ferramentas MCP

| Ferramenta | O que faz |
| --- | --- |
| `abrir_url` | Abre uma URL (adiciona `https://` se faltar) |
| `clicar` | Clica por `texto` visível (botão, link ou texto) ou por `seletor` |
| `digitar` | Digita em um `seletor` (ou no campo focado); `pressionar_enter` opcional |
| `rolar` | Rola `baixo`/`cima` por N pixels |
| `ler_texto_da_pagina` | Título, URL e texto visível (até 20 mil caracteres) |
| `tirar_screenshot` | PNG da área visível ou da página inteira |

## Visão ao vivo

O mesmo processo do MCP serve uma página em `0.0.0.0:3000` com o navegador ao vivo (screenshot a cada 500 ms via WebSocket) e o log de cada ação. Ela só existe enquanto uma sessão do `claude` estiver aberta nesta pasta.

No iPad, abra `https://<nome-do-codespace>-3000.app.github.dev` (ou aba **Portas** do Codespaces → porta 3000 → copiar endereço). A porta é privada: entre no GitHub no Safari. Evite torná-la pública — quem tiver o link pode aprovar ações.

## Segurança

- **Envios de formulário e compras** (botões de envio, Enter em formulários, textos como "Comprar", "Pagar", "Checkout", "Assinar"…) abrem um pedido de confirmação na visão ao vivo. Sem resposta em 2 minutos, ou sem ninguém assistindo, a ação é negada. Buscas (formulários GET/de busca) não pedem confirmação.
- Duas barreiras extras pegam envios disparados por JavaScript: um interceptador do evento `submit` na página e o bloqueio de navegações não-GET na rede.
- **Senhas e cartões nunca são digitados**: campos `password`, campos de cartão/CVV/validade (por `autocomplete`, nome, rótulo ou placeholder) e qualquer texto que pareça número de cartão (Luhn) são recusados. O texto digitado não aparece no log, só o tamanho.
- Limitação: envios feitos por `fetch`/XHR em sites SPA só são detectados pelo clique ou Enter que os dispara.

## Testes

```bash
npm test
```

Sobe o servidor via stdio como o Claude faria, usa um site local e um espectador WebSocket que aprova/recusa confirmações.
