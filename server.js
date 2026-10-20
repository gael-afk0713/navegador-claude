#!/usr/bin/env node
// Servidor MCP (stdio) que controla um Chromium headless e, no mesmo processo,
// serve a visão ao vivo na porta 3000. Atenção: stdout é o canal MCP — logs vão para stderr.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  iniciarNavegador, pagina, fecharNavegador, retirarAvisos, infoElemento, infoElementoFocado,
  campoSensivel, pareceCartao, motivoConfirmacaoClique, motivoConfirmacaoEnter, confirmar,
} from './src/navegador.js';
import { registrar } from './src/eventos.js';
import { iniciarWeb } from './src/web.js';

const LIMITE_TEXTO = 20_000;

const server = new McpServer({ name: 'navegador', version: '1.0.0' });

const texto = (t) => ({ content: [{ type: 'text', text: t }] });
const erro = (t) => ({ content: [{ type: 'text', text: t }], isError: true });

// Envolve cada ferramenta: registra a ação no log ao vivo e anexa avisos de bloqueio.
function ferramenta(nome, descricao, inputSchema, fn, resumo) {
  server.registerTool(nome, { description: descricao, inputSchema }, async (args) => {
    registrar(nome, resumo ? resumo(args) : '');
    try {
      const r = await fn(args);
      const avisos = retirarAvisos();
      if (avisos.length) r.content.push({ type: 'text', text: `AVISO: ${avisos.join('; ')}` });
      if (r.isError) registrar('erro', `${nome}: ${r.content[0].text}`);
      return r;
    } catch (e) {
      const msg = e.message.split('\n')[0];
      registrar('erro', `${nome}: ${msg}`);
      return erro(msg);
    }
  });
}

const RECUSA_SENSIVEL =
  'Recusado: por segurança este navegador nunca digita senhas nem dados de cartão. Peça ao usuário que preencha esse campo.';

// Executa uma ação e, se ela disparar uma navegação, espera o novo documento carregar.
async function comNavegacao(page, acao) {
  const nav = page
    .waitForEvent('framenavigated', { predicate: (f) => f === page.mainFrame(), timeout: 1_500 })
    .then(() => page.waitForLoadState('domcontentloaded', { timeout: 10_000 }))
    .catch(() => {});
  await acao();
  await nav;
}

async function localizar(page, { texto: t, seletor }) {
  if (seletor) return page.locator(seletor).first();
  if (t) {
    return page.getByRole('button', { name: t })
      .or(page.getByRole('link', { name: t }))
      .or(page.getByText(t))
      .first();
  }
  return null;
}

ferramenta(
  'abrir_url',
  'Abre uma URL no navegador compartilhado.',
  { url: z.string().describe('Endereço a abrir; "https://" é adicionado se faltar') },
  async ({ url }) => {
    // Tem esquema (https:, data:, about:...)? Senão, assume https. "localhost:3000" não é esquema.
    const alvo = /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(url) ? url : `https://${url}`;
    const page = await pagina();
    const resp = await page.goto(alvo, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    return texto(`Aberto: ${page.url()} — "${await page.title()}" (HTTP ${resp?.status() ?? '?'})`);
  },
  ({ url }) => url,
);

ferramenta(
  'clicar',
  'Clica em um elemento, localizado pelo texto visível (botão, link ou texto) ou por um seletor CSS/Playwright. ' +
    'Envios de formulário e compras exigem confirmação do usuário na visão ao vivo.',
  {
    texto: z.string().optional().describe('Texto visível do elemento'),
    seletor: z.string().optional().describe('Seletor CSS ou Playwright (tem prioridade sobre texto)'),
  },
  async (args) => {
    const page = await pagina();
    const alvo = await localizar(page, args);
    if (!alvo) return erro('Informe "texto" ou "seletor".');
    await alvo.waitFor({ state: 'visible', timeout: 5_000 });
    const motivo = motivoConfirmacaoClique(await infoElemento(alvo));
    if (motivo && !(await confirmar(motivo))) {
      return erro(`Ação não autorizada pelo usuário (${motivo}). Não tente contornar; pergunte ao usuário.`);
    }
    await comNavegacao(page, () => alvo.click({ timeout: 5_000 }));
    return texto(`Clicado. Página atual: ${page.url()} — "${await page.title()}"`);
  },
  ({ texto: t, seletor }) => seletor ?? `"${t}"`,
);

ferramenta(
  'digitar',
  'Digita texto em um campo (por seletor) ou no elemento focado. Nunca digita senhas ou dados de cartão.',
  {
    texto: z.string().describe('Texto a digitar'),
    seletor: z.string().optional().describe('Seletor do campo; se omitido, usa o elemento focado'),
    pressionar_enter: z.boolean().optional().describe('Pressiona Enter depois de digitar'),
  },
  async ({ texto: t, seletor, pressionar_enter }) => {
    const page = await pagina();
    const campo = seletor ? page.locator(seletor).first() : null;
    if (campo) await campo.waitFor({ state: 'visible', timeout: 5_000 });
    const info = campo ? await infoElemento(campo) : await infoElementoFocado(page);
    if (campoSensivel(info) || pareceCartao(t)) {
      registrar('bloqueio', 'tentativa de digitar senha/dados de cartão recusada');
      return erro(RECUSA_SENSIVEL);
    }
    if (campo) await campo.fill(t, { timeout: 5_000 });
    else await page.keyboard.type(t);
    if (pressionar_enter) {
      const motivo = motivoConfirmacaoEnter(info);
      if (motivo && !(await confirmar(motivo))) {
        return erro(`Texto digitado, mas o Enter não foi autorizado pelo usuário (${motivo}).`);
      }
      await comNavegacao(page, () => page.keyboard.press('Enter'));
    }
    return texto(`Digitado${pressionar_enter ? ' + Enter' : ''}.`);
  },
  // O texto em si não vai para o log, só o tamanho.
  ({ seletor, texto: t, pressionar_enter }) =>
    `${seletor ?? '(focado)'} ← ${t.length} caractere(s)${pressionar_enter ? ' + Enter' : ''}`,
);

ferramenta(
  'rolar',
  'Rola a página para cima ou para baixo.',
  {
    direcao: z.enum(['baixo', 'cima']).default('baixo'),
    pixels: z.number().int().positive().max(10_000).default(600),
  },
  async ({ direcao = 'baixo', pixels = 600 }) => {
    const page = await pagina();
    const { width, height } = page.viewportSize();
    await page.mouse.move(width / 2, height / 2);
    await page.mouse.wheel(0, direcao === 'baixo' ? pixels : -pixels);
    await page.waitForTimeout(300);
    const pos = await page.evaluate(() => [Math.round(scrollY), document.documentElement.scrollHeight - innerHeight]);
    return texto(`Rolado ${pixels}px para ${direcao}. Posição ${pos[0]} de ${Math.max(pos[1], 0)}.`);
  },
  ({ direcao = 'baixo', pixels = 600 }) => `${direcao} ${pixels}px`,
);

ferramenta(
  'ler_texto_da_pagina',
  'Devolve o título, a URL e o texto visível da página atual.',
  {},
  async () => {
    const page = await pagina();
    let corpo = await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
    corpo = corpo.replace(/\n{3,}/g, '\n\n').trim();
    const cortado = corpo.length > LIMITE_TEXTO;
    return texto(
      `URL: ${page.url()}\nTítulo: ${await page.title()}\n\n${corpo.slice(0, LIMITE_TEXTO)}` +
        (cortado ? `\n\n[... texto cortado em ${LIMITE_TEXTO} de ${corpo.length} caracteres]` : ''),
    );
  },
);

ferramenta(
  'tirar_screenshot',
  'Tira um screenshot da área visível (ou da página inteira) e devolve a imagem.',
  { pagina_inteira: z.boolean().optional().describe('Captura a página inteira em vez da área visível') },
  async ({ pagina_inteira }) => {
    const page = await pagina();
    const img = await page.screenshot({ type: 'png', fullPage: !!pagina_inteira, timeout: 10_000 });
    return { content: [{ type: 'image', data: img.toString('base64'), mimeType: 'image/png' }] };
  },
  ({ pagina_inteira }) => (pagina_inteira ? 'página inteira' : 'área visível'),
);

// ---------- inicialização ----------

const web = iniciarWeb({ porta: Number(process.env.PORT) || 3000 });
iniciarNavegador().catch((e) => process.stderr.write(`[navegador] falha ao abrir o Chromium: ${e.message}\n`));

const transport = new StdioServerTransport();
await server.connect(transport);
registrar('início', 'servidor MCP pronto');

let encerrando = false;
async function encerrar() {
  if (encerrando) return;
  encerrando = true;
  web.fechar();
  await fecharNavegador();
  process.exit(0);
}
server.server.onclose = encerrar;
process.stdin.on('end', encerrar);
process.on('SIGINT', encerrar);
process.on('SIGTERM', encerrar);
