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
    </form>
    <button type="button" onclick="document.forms[1].requestSubmit()">Salvar rascunho</button>
    <button type="button" onclick="document.forms[1].submit()">Salvar direto</button>
    <a href="#" id="comprar">Comprar agora</a>
    <button id="contador" onclick="this.textContent='Clicado!'">Contar</button>
    <div style="height:3000px"></div><p>fim da página</p>`);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${site.address().port}`;

const transport = new StdioClientTransport({
  command: 'node', args: ['server.js'], env: { ...process.env, PORT: String(PORTA_WEB) }, stderr: 'ignore',
});
const client = new Client({ name: 'teste', version: '1.0.0' });
await client.connect(transport);

const chamar = async (name, args = {}) => client.callTool({ name, arguments: args });
const txt = (r) => r.content.map((c) => c.text ?? '').join(' ');
let ok = 0;
const caso = async (nome, fn) => { await fn(); ok++; console.log(`✓ ${nome}`); };

await caso('lista as 6 ferramentas', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(),
    ['abrir_url', 'clicar', 'digitar', 'ler_texto_da_pagina', 'rolar', 'tirar_screenshot']);
});

await caso('página ao vivo responde', async () => {
  const html = await (await fetch(`http://127.0.0.1:${PORTA_WEB}/`)).text();
  assert.match(html, /Navegador do Claude/);
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

// Espectador que responde às confirmações conforme a variável `responder`.
const ws = new WebSocket(`ws://127.0.0.1:${PORTA_WEB}/ws`);
let responder = false, frames = 0;
const pedidos = [];
ws.on('message', (dados, binario) => {
  if (binario) return frames++;
  const m = JSON.parse(dados);
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

await caso('screenshots chegam via WebSocket', async () => {
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(frames > 0, 'nenhum frame recebido');
});

ws.close();
await client.close();
site.close();
console.log(`\n${ok} casos passaram.`);
