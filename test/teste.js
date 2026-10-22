// Teste de ponta a ponta: sobe o servidor MCP como o Claude faria (stdio), usa um site
// local de teste e um "espectador" via WebSocket que aprova/recusa confirmações.
import http from 'node:http';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import WebSocket from 'ws';

const PORTA_WEB = 3999;
const enviosRecebidos = [];

const site = http.createServer((req, res) => {
  if (req.method === 'POST') {
    enviosRecebidos.push(req.url);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end('<h1>Formulário recebido</h1>');
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>Loja Teste</title>
    <h1>Loja de teste</h1>
    <form method="get" action="/busca" role="search"><input name="q" id="q"></form>
    <form method="post" action="/contato">
      <input id="nome" name="nome"><input id="senha" type="password" name="pw">
      <input id="cc" autocomplete="cc-number" name="numero">
      <button>Enviar</button>
      <button style="position:fixed;left:0;bottom:0;width:160px;height:80px">Enviar fixo</button>
    </form>
    <div id="hover" style="position:fixed;right:0;top:0;width:120px;height:50px"
      onmouseover="this.textContent='Hover!'">passe</div>
    <input type="range" style="position:fixed;left:300px;bottom:20px;width:400px" value="0"
      oninput="document.getElementById('valor').textContent='valor '+this.value"><span id="valor"></span>
    <iframe srcdoc="<input type=password>" style="position:fixed;left:700px;top:0;width:200px;height:60px"></iframe>
    <button type="button" onclick="document.forms[1].requestSubmit()">Salvar rascunho</button>
    <button type="button" onclick="document.forms[1].submit()">Salvar direto</button>
    <a href="#" id="comprar">Comprar agora</a>
    <select id="cor" onchange="document.getElementById('corEscolhida').textContent='cor '+this.value">
      <option value="">escolha</option><option value="azul">Azul</option></select><span id="corEscolhida"></span>
    <button id="contador" onclick="this.textContent='Clicado!'">Contar</button>
    <button id="manual" style="position:fixed;right:0;bottom:0;width:160px;height:80px"
      onclick="this.textContent='Manual!'">Manual</button>
    <div style="height:3000px"></div><p>fim da página</p>`);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${site.address().port}`;

const transport = new StdioClientTransport({
  command: 'node', args: ['server.js'], env: { ...process.env, PORT: String(PORTA_WEB), NAVEGADOR_TUNEL: '0', NAVEGADOR_TOKEN: 'segredo-teste', NAVEGADOR_INICIAL: 'about:blank',
    NAVEGADOR_CLAUDE: new URL('./claude-falso.js', import.meta.url).pathname }, stderr: 'ignore',
});
const client = new Client({ name: 'teste', version: '1.0.0' });
await client.connect(transport);

const chamar = async (name, args = {}) => client.callTool({ name, arguments: args });
const txt = (r) => r.content.map((c) => c.text ?? '').join(' ');
let ok = 0;
const caso = async (nome, fn) => { await fn(); ok++; console.log(`✓ ${nome}`); };

await caso('lista as 14 ferramentas', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'abas', 'abrir_url', 'arrastar', 'clicar', 'digitar', 'esperar', 'ler_texto_da_pagina', 'listar_elementos',
    'mover_mouse', 'navegar_historico', 'pressionar_tecla', 'rolar', 'selecionar_opcao', 'tirar_screenshot',
  ]);
});

await caso('página ao vivo responde', async () => {
  const html = await (await fetch(`http://127.0.0.1:${PORTA_WEB}/`)).text();
  assert.match(html, /Navegador Claude/);
});

await caso('abrir_url + ler_texto_da_pagina', async () => {
  assert.match(txt(await chamar('abrir_url', { url: base })), /Loja Teste/);
  assert.match(txt(await chamar('ler_texto_da_pagina')), /Loja de teste/);
});

await caso('clicar por texto e por seletor', async () => {
  await chamar('clicar', { texto: 'Contar' });
  assert.match(txt(await chamar('ler_texto_da_pagina')), /Clicado!/);
  assert.ok(!(await chamar('clicar', { seletor: '#contador' })).isError);
});

await caso('rolar', async () => {
  assert.match(txt(await chamar('rolar', { direcao: 'baixo', pixels: 800 })), /Posição 800/);
  await chamar('rolar', { direcao: 'cima', pixels: 800 });
});

await caso('tirar_screenshot devolve PNG', async () => {
  const r = await chamar('tirar_screenshot');
  assert.equal(r.content[0].type, 'image');
  assert.equal(Buffer.from(r.content[0].data, 'base64').subarray(1, 4).toString(), 'PNG');
});

await caso('recusa senha e cartão', async () => {
  assert.ok((await chamar('digitar', { seletor: '#senha', texto: 'abc123' })).isError);
  assert.ok((await chamar('digitar', { seletor: '#cc', texto: '1234' })).isError);
  assert.ok((await chamar('digitar', { seletor: '#nome', texto: '4111 1111 1111 1111' })).isError);
  assert.ok(!(await chamar('digitar', { seletor: '#nome', texto: 'Maria' })).isError);
});

await caso('mouse: clique por coordenadas, hover e arrastar', async () => {
  assert.match(txt(await chamar('clicar', { x: 1100, y: 780 })), /Clicado em \(1100, 780\) sobre <button> "Manual"/);
  await chamar('mover_mouse', { x: 1120, y: 20 });
  await chamar('arrastar', { de_x: 302, de_y: 790, para_x: 699, para_y: 790 });
  const t = txt(await chamar('ler_texto_da_pagina'));
  assert.match(t, /Manual!/);
  assert.match(t, /Hover!/);
  assert.match(t, /valor (9\d|100)/);
  await chamar('abrir_url', { url: base });
});

await caso('teclado: pressionar_tecla respeita senha e Enter em formulário', async () => {
  await chamar('clicar', { seletor: '#senha' });
  assert.ok((await chamar('pressionar_tecla', { tecla: 'a' })).isError);
  assert.ok((await chamar('pressionar_tecla', { tecla: 'Shift+A' })).isError);
  assert.ok(!(await chamar('pressionar_tecla', { tecla: 'Tab' })).isError);
  await chamar('clicar', { seletor: '#nome' });
  assert.ok(!(await chamar('pressionar_tecla', { tecla: 'b', vezes: 3 })).isError);
  assert.ok((await chamar('pressionar_tecla', { tecla: 'Enter' })).isError); // sem espectador
  assert.equal(enviosRecebidos.length, 0);
});

await caso('senha dentro de iframe focada por clique também é recusada', async () => {
  await chamar('clicar', { x: 750, y: 20 });
  assert.ok((await chamar('digitar', { texto: 'segredo' })).isError);
  assert.ok((await chamar('pressionar_tecla', { tecla: 'x' })).isError);
});

await caso('clique por coordenadas em botão de envio pede confirmação', async () => {
  assert.ok((await chamar('clicar', { x: 80, y: 780 })).isError);
  assert.equal(enviosRecebidos.length, 0);
  await chamar('abrir_url', { url: base });
});

await caso('busca (formulário GET) não pede confirmação', async () => {
  await chamar('digitar', { seletor: '#q', texto: 'livros', pressionar_enter: true });
  assert.match(txt(await chamar('ler_texto_da_pagina')), /busca\?q=livros/);
  await chamar('abrir_url', { url: base });
});

await caso('sem espectador: envio de formulário é negado', async () => {
  const r = await chamar('clicar', { texto: 'Enviar' });
  assert.ok(r.isError);
  assert.equal(enviosRecebidos.length, 0);
});

await caso('visão ao vivo exige o token de acesso', async () => {
  const pagina = (q) => fetch(`http://127.0.0.1:${PORTA_WEB}/${q}`);
  assert.equal((await pagina('')).status, 401);
  assert.equal((await pagina('?t=errado')).status, 401);
  const r = await pagina('?t=segredo-teste');
  assert.equal(r.status, 200);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(`http://127.0.0.1:${PORTA_WEB}/`, { headers: { cookie } })).status, 200);
  const intruso = new WebSocket(`ws://127.0.0.1:${PORTA_WEB}/ws`);
  await new Promise((r) => intruso.once('error', r));
});

// Espectador que responde às confirmações conforme a variável `responder`.
const ws = new WebSocket(`ws://127.0.0.1:${PORTA_WEB}/ws?t=segredo-teste`);
let responder = false, frames = 0;
const pedidos = [], conversa = [];
ws.on('message', (dados, binario) => {
  if (binario) return frames++;
  const m = JSON.parse(dados);
  if (m.tipo === 'log' && m.linha.chat) conversa.push(m.linha);
  if (m.tipo === 'confirmar') {
    pedidos.push(m.motivo);
    ws.send(JSON.stringify({ tipo: 'resposta', id: m.id, aprovado: responder }));
  }
});
await new Promise((r) => ws.once('open', r));

await caso('espectador recusa compra', async () => {
  responder = false;
  assert.ok((await chamar('clicar', { texto: 'Comprar agora' })).isError);
  assert.match(pedidos.at(-1), /compra/);
});

await caso('envio sem confirmação via JavaScript é barrado', async () => {
  const r = await chamar('clicar', { texto: 'Salvar rascunho' });
  assert.match(txt(r), /AVISO: envio de formulário .* bloqueado/);
  const r2 = await chamar('clicar', { texto: 'Salvar direto' }); // form.submit() não dispara evento
  assert.match(txt(r2), /AVISO: envio POST .* bloqueado/);
  assert.equal(enviosRecebidos.length, 0);
  await chamar('abrir_url', { url: base });
});

await caso('espectador aprova envio de formulário', async () => {
  responder = true;
  await chamar('digitar', { seletor: '#nome', texto: 'Maria' });
  const r = await chamar('clicar', { texto: 'Enviar' });
  assert.ok(!r.isError, txt(r));
  assert.match(txt(await chamar('ler_texto_da_pagina')), /Formulário recebido/);
  assert.deepEqual(enviosRecebidos, ['/contato']);
});

await caso('controle manual: abrir, clique e teclado', async () => {
  const controle = (acao) => ws.send(JSON.stringify({ tipo: 'controle', acao }));
  const espera = () => new Promise((r) => setTimeout(r, 800));
  controle({ tipo: 'abrir', url: `${base}/?manual` });
  await espera();
  assert.match(txt(await chamar('ler_texto_da_pagina')), /\?manual/);
  controle({ tipo: 'clique', x: 1100, y: 780 });
  await espera();
  assert.match(txt(await chamar('ler_texto_da_pagina')), /Manual!/);
  await chamar('clicar', { seletor: '#q' });
  controle({ tipo: 'texto', texto: 'jogos' });
  controle({ tipo: 'tecla', tecla: 'Enter' });
  await espera();
  assert.match(txt(await chamar('ler_texto_da_pagina')), /busca\?q=jogos/);
});

await caso('listar_elementos dá coordenadas que funcionam no clicar', async () => {
  await chamar('abrir_url', { url: base });
  const lista = txt(await chamar('listar_elementos', { filtro: 'contar' }));
  const [, x, y] = lista.match(/"Contar" — \((\d+), (\d+)\)/);
  await chamar('clicar', { x: Number(x), y: Number(y) });
  assert.match(txt(await chamar('ler_texto_da_pagina', { seletor: '#contador' })), /Clicado!/);
  assert.doesNotMatch(txt(await chamar('listar_elementos')), /fim da página/);
});

await caso('selecionar_opcao, esperar e navegar_historico', async () => {
  await chamar('abrir_url', { url: `${base}/#a` });
  await chamar('abrir_url', { url: `${base}/busca?q=x` });
  assert.match(txt(await chamar('navegar_historico', { acao: 'voltar' })), /#a/);
  assert.match(txt(await chamar('navegar_historico', { acao: 'avancar' })), /busca\?q=x/);
  await chamar('abrir_url', { url: base });
  assert.match(txt(await chamar('selecionar_opcao', { seletor: '#cor', opcao: 'Azul' })), /azul/);
  assert.match(txt(await chamar('esperar', { texto: 'cor azul', segundos: 2 })), /Apareceu/);
  assert.ok((await chamar('esperar', { texto: 'nunca aparece', segundos: 0.5 })).isError);
});

await caso('abas: nova, trocar e fechar', async () => {
  assert.match(txt(await chamar('abas', { acao: 'nova', url: `${base}/busca?q=aba2` })), /→ 1\..*aba2/);
  assert.match(txt(await chamar('abas', { acao: 'trocar', indice: 0 })), /→ 0\./);
  const r = txt(await chamar('abas', { acao: 'fechar', indice: 1 }));
  assert.doesNotMatch(r, /aba2/);
  assert.match(r, /→ 0\./);
});

await caso('screenshots chegam via WebSocket', async () => {
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(frames > 0, 'nenhum frame recebido');
});

await caso('MCP em HTTP exige o token', async () => {
  const lista = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  const post = (cabecalhos) => fetch(`http://127.0.0.1:${PORTA_WEB}/mcp`, {
    method: 'POST', body: JSON.stringify(lista),
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...cabecalhos },
  });
  assert.equal((await post({})).status, 401);
  assert.equal((await post({ authorization: 'Bearer errado' })).status, 401);
  const r = await post({ authorization: 'Bearer segredo-teste' });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /abrir_url/);
});

await caso('chat: pedido pela página roda o claude no mesmo navegador e continua a conversa', async () => {
  const resposta = async (n) => {
    for (let i = 0; i < 100 && conversa.filter((l) => l.chat === 'claude').length < n; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return conversa.filter((l) => l.chat === 'claude')[n - 1]?.texto ?? '';
  };
  ws.send(JSON.stringify({ tipo: 'pedido', texto: `${base}/busca?q=chat1` }));
  assert.match(await resposta(1), /Feito \(nova\).*chat1/);
  assert.match(txt(await chamar('ler_texto_da_pagina')), /busca\?q=chat1/);
  ws.send(JSON.stringify({ tipo: 'pedido', texto: `${base}/busca?q=chat2` }));
  assert.match(await resposta(2), /Feito \(continuando\).*chat2/);
  assert.deepEqual(conversa.filter((l) => l.chat === 'você').map((l) => l.texto.slice(-5)), ['chat1', 'chat2']);
});

ws.close();
await client.close();
site.close();
console.log(`\n${ok} casos passaram.`);
