// Servidor web da visão ao vivo: página HTML + WebSocket com screenshots a cada 500 ms.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { paginaSeAberta, cursor } from './navegador.js';
import { acaoDoUsuario } from './controle.js';
import { autorizacao, cookieDeAcesso } from './acesso.js';
import { enviarPedido, pararPedido, novaConversa, estadoChat } from './chat.js';
import {
  bus, historico, definirEspectadores, confirmacoesPendentes, responderConfirmacao, registrar,
} from './eventos.js';

const INTERVALO_MS = 500;
const HTML = new URL('../public/index.html', import.meta.url);
const SEM_TOKEN = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
  + '<title>Navegador Claude</title><p style="font:17px system-ui;margin:2em">Link sem o token de acesso. '
  + 'Rode <code>/navegador</code> no <code>claude</code> e abra o link (ou QR code) que aparece.</p>';

export function iniciarWeb({ porta = 3000, host = '0.0.0.0', aoIniciar, aoMcp } = {}) {
  const server = http.createServer(async (req, res) => {
    if (aoMcp && (req.url === '/mcp' || req.url.startsWith('/mcp?'))) {
      // MCP em HTTP para o claude que atende os pedidos do chat; exige o mesmo token da visão.
      if (!autorizacao(req).ok) return res.writeHead(401).end();
      return aoMcp(req, res).catch((e) => {
        process.stderr.write(`[navegador] erro no /mcp: ${e.message}\n`);
        if (!res.headersSent) res.writeHead(500).end();
      });
    }
    if (req.url === '/' || req.url.startsWith('/?')) {
      const acesso = autorizacao(req);
      if (!acesso.ok) {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(SEM_TOKEN);
      }
      const cabecalhos = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
      if (acesso.daUrl) cabecalhos['set-cookie'] = cookieDeAcesso();
      res.writeHead(200, cabecalhos);
      res.end(await readFile(HTML));
    } else {
      res.writeHead(404).end();
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws', verifyClient: ({ req }) => autorizacao(req).ok });
  const enviarJson = (ws, obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));
  const transmitir = (obj) => wss.clients.forEach((ws) => enviarJson(ws, obj));

  let ultimoFrame = null;
  // Ações manuais rodam em fila, na ordem em que chegaram.
  let filaControle = Promise.resolve();

  wss.on('connection', (ws) => {
    definirEspectadores(wss.clients.size);
    enviarJson(ws, { tipo: 'historico', linhas: historico });
    for (const c of confirmacoesPendentes()) enviarJson(ws, { tipo: 'confirmar', ...c });
    if (ultimoFrame) ws.send(ultimoFrame);
    if (cursor.x !== null) enviarJson(ws, { tipo: 'cursor', ...cursor });
    enviarJson(ws, { tipo: 'chat-estado', ...estadoChat() });

    ws.on('message', (dados) => {
      try {
        const msg = JSON.parse(dados);
        if (msg.tipo === 'resposta') responderConfirmacao(msg.id, msg.aprovado === true);
        else if (msg.tipo === 'pedido') enviarPedido(msg.texto);
        else if (msg.tipo === 'parar') pararPedido();
        else if (msg.tipo === 'nova-conversa') novaConversa();
        else if (msg.tipo === 'controle' && msg.acao) {
          filaControle = filaControle
            .then(() => acaoDoUsuario(msg.acao))
            .catch((e) => registrar('erro', `controle manual: ${e.message.split('\n')[0]}`))
            .then(() => setTimeout(capturar, 150)); // mostra o resultado sem esperar o próximo ciclo
        }
      } catch {}
    });
    ws.on('close', () => definirEspectadores(wss.clients.size));
  });

  bus.on('log', (linha) => transmitir({ tipo: 'log', linha }));
  bus.on('confirmar', (c) => transmitir({ tipo: 'confirmar', ...c }));
  bus.on('confirmado', (c) => transmitir({ tipo: 'confirmado', ...c }));
  bus.on('cursor', (c) => transmitir({ tipo: 'cursor', ...c }));
  bus.on('clique', (c) => transmitir({ tipo: 'clique', ...c }));
  bus.on('chat-estado', (e) => transmitir({ tipo: 'chat-estado', ...e }));

  // Loop de screenshots: só captura quando há alguém assistindo e não repete frames iguais.
  let ocupado = false;
  async function capturar() {
    const page = paginaSeAberta();
    if (ocupado || wss.clients.size === 0 || !page) return;
    ocupado = true;
    try {
      const frame = await page.screenshot({ type: 'jpeg', quality: 60, timeout: 2000, animations: 'allow' });
      if (!ultimoFrame || !frame.equals(ultimoFrame)) {
        ultimoFrame = frame;
        for (const ws of wss.clients) {
          if (ws.readyState === ws.OPEN && ws.bufferedAmount < 2_000_000) ws.send(frame);
        }
        transmitir({ tipo: 'url', url: page.url() });
      }
    } catch {
      // Página navegando ou fechada; tenta de novo no próximo ciclo.
    } finally {
      ocupado = false;
    }
  }
  const timer = setInterval(capturar, INTERVALO_MS);

  server.on('error', (err) => {
    process.stderr.write(`[navegador] visão ao vivo indisponível na porta ${porta}: ${err.message}\n`);
    clearInterval(timer);
  });
  server.listen(porta, host, () => {
    process.stderr.write(`[navegador] visão ao vivo em http://${host}:${porta}\n`);
    aoIniciar?.();
  });

  return { fechar: () => { clearInterval(timer); wss.close(); server.close(); } };
}
