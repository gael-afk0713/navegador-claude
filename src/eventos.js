// Log de ações e pedidos de confirmação, compartilhados entre o MCP e a página ao vivo.
import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
export const historico = [];
const pendentes = new Map(); // id -> { motivo, resolver, timer }
let espectadores = 0;
let proximoId = 1;

const TEMPO_CONFIRMACAO_MS = 120_000;

export function registrar(acao, detalhe = '') {
  const linha = { hora: new Date().toISOString(), acao, detalhe: String(detalhe).slice(0, 300) };
  historico.push(linha);
  if (historico.length > 300) historico.shift();
  bus.emit('log', linha);
  process.stderr.write(`[navegador] ${acao} ${linha.detalhe}\n`);
}

export function definirEspectadores(n) {
  espectadores = n;
}

export function confirmacoesPendentes() {
  return [...pendentes].map(([id, p]) => ({ id, motivo: p.motivo }));
}

export function pedirConfirmacao(motivo) {
  if (espectadores === 0) {
    registrar('confirmação', `negada automaticamente (ninguém na visão ao vivo): ${motivo}`);
    return Promise.resolve(false);
  }
  const id = proximoId++;
  registrar('confirmação', `aguardando: ${motivo}`);
  return new Promise((resolver) => {
    const timer = setTimeout(() => responderConfirmacao(id, false, 'tempo esgotado'), TEMPO_CONFIRMACAO_MS);
    pendentes.set(id, { motivo, resolver, timer });
    bus.emit('confirmar', { id, motivo });
  });
}

export function responderConfirmacao(id, aprovado, origem = 'usuário') {
  const p = pendentes.get(id);
  if (!p) return;
  pendentes.delete(id);
  clearTimeout(p.timer);
  registrar('confirmação', `${aprovado ? 'APROVADA' : 'RECUSADA'} (${origem}): ${p.motivo}`);
  bus.emit('confirmado', { id });
  p.resolver(aprovado);
}
