// Pedidos feitos pela visão ao vivo: cada mensagem roda um `claude -p` em segundo plano, ligado a este
// mesmo navegador pelo MCP em HTTP (/mcp). As mensagens seguintes continuam a mesma conversa (--resume).
import { spawn } from 'node:child_process';
import { bus, registrar, registrarChat } from './eventos.js';
import { token } from './acesso.js';

const PASTA_PROJETO = new URL('..', import.meta.url).pathname;
const INSTRUCOES =
  'Você está atendendo pedidos digitados no chat da visão ao vivo do Navegador Claude: o usuário assiste ao ' +
  'navegador (geralmente pelo iPad) e conversa com você por ali, sem acesso ao terminal. Use as ferramentas ' +
  'mcp__navegador__* para operar o navegador compartilhado. Responda em português, de forma curta, e diga o ' +
  'que encontrou ou fez, em texto puro (sem Markdown: a página mostra o texto como está). Envios de formulário e compras pedem confirmação ao usuário na própria página.';

let urlMcp = null;
let filho = null;
let sessao = null;
let interrompido = false;

export const estadoChat = () => ({ ocupado: filho !== null });
const avisarEstado = () => bus.emit('chat-estado', estadoChat());

export function configurarChat(opcoes) {
  urlMcp = opcoes.urlMcp;
}

export function novaConversa() {
  if (filho) return;
  sessao = null;
  registrar('conversa', 'nova conversa');
}

export function pararPedido() {
  if (!filho) return;
  interrompido = true;
  filho.kill('SIGTERM');
  registrar('conversa', 'pedido interrompido');
}

export function enviarPedido(texto) {
  texto = String(texto ?? '').trim().slice(0, 10_000);
  if (!texto || filho || !urlMcp) return;
  registrarChat('você', texto);

  const mcp = { mcpServers: { navegador: { type: 'http', url: urlMcp, headers: { authorization: `Bearer ${token}` } } } };
  const args = [
    '-p', texto, '--output-format', 'stream-json', '--verbose',
    '--mcp-config', JSON.stringify(mcp), '--strict-mcp-config',
    // Só as ferramentas do navegador: nada de shell nem de arquivos.
    '--tools', '', '--allowedTools', 'mcp__navegador', '--permission-mode', 'dontAsk',
    '--append-system-prompt', INSTRUCOES,
  ];
  if (sessao) args.push('--resume', sessao);
  interrompido = false;

  const env = { ...process.env };
  delete env.CLAUDECODE; // o processo pode ter sido aberto por uma sessão do claude
  filho = spawn(process.env.NAVEGADOR_CLAUDE || 'claude', args, { cwd: PASTA_PROJETO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  avisarEstado();

  let resto = '', erros = '', respondeu = false;
  filho.stdout.on('data', (dados) => {
    const linhas = (resto + dados).split('\n');
    resto = linhas.pop();
    for (const l of linhas) {
      let m;
      try { m = JSON.parse(l); } catch { continue; }
      if (m.session_id) sessao = m.session_id;
      if (m.type === 'assistant') {
        const t = (m.message?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
        if (t) { registrarChat('claude', t); respondeu = true; }
      } else if (m.type === 'result' && m.is_error) {
        registrarChat('erro', m.result || m.errors?.join('; ') || 'o pedido terminou com erro');
        respondeu = true;
      }
    }
  });
  filho.stderr.on('data', (d) => { erros = (erros + d).slice(-2000); });
  filho.on('error', (e) => { erros = e.message; });
  filho.on('close', (codigo) => {
    filho = null;
    if (!respondeu && !interrompido) {
      registrarChat('erro', `o claude não respondeu (código ${codigo})${erros.trim() ? `: ${erros.trim().split('\n').pop()}` : ''}`);
    }
    avisarEstado();
  });
}
