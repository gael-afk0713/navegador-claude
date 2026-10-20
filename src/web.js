// Servidor web da visão ao vivo: página HTML + WebSocket com screenshots a cada 500 ms.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { paginaSeAberta } from './navegador.js';
import {
  bus, historico, definirEspectadores, confirmacoesPendentes, responderConfirmacao,
} from './eventos.js';

const INTERVALO_MS = 500;
const HTML = new URL('../public/index.html', import.meta.url);

export function iniciarWeb({ porta = 3000, host = '0.0.0.0' } = {}) {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/' || req.url.startsWith('/?')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(await readFile(HTML));
    } else {
      res.writeHead(404).end();
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  const enviarJson = (ws, obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));
  const transmitir = (obj) => wss.clients.forEach((ws) => enviarJson(ws, obj));

  let ultimoFrame = null;

  wss.on('connection', (ws) => {
    definirEspectadores(wss.clients.size);
    enviarJson(ws, { tipo: 'historico', linhas: historico });
    for (const c of confirmacoesPendentes()) enviarJson(ws, { tipo: 'confirmar', ...c });
    if (ultimoFrame) ws.send(ultimoFrame);

    ws.on('message', (dados) => {
      try {
        const msg = JSON.parse(dados);
        if (msg.tipo === 'resposta') responderConfirmacao(msg.id, msg.aprovado === true);
      } catch {}
    });
    ws.on('close', () => definirEspectadores(wss.clients.size));
  });

  bus.on('log', (linha) => transmitir({ tipo: 'log', linha }));
  bus.on('confirmar', (c) => transmitir({ tipo: 'confirmar', ...c }));
  bus.on('confirmado', (c) => transmitir({ tipo: 'confirmado', ...c }));

  // Loop de screenshots: só captura quando há alguém assistindo e não repete frames iguais.
  let ocupado = false;
  const timer = setInterval(async () => {
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
  }, INTERVALO_MS);

  server.on('error', (err) => {
    process.stderr.write(`[navegador] visão ao vivo indisponível na porta ${porta}: ${err.message}\n`);
    clearInterval(timer);
  });
  server.listen(porta, host, () => {
    process.stderr.write(`[navegador] visão ao vivo em http://${host}:${porta}\n`);
  });

  return { fechar: () => { clearInterval(timer); wss.close(); server.close(); } };
}
