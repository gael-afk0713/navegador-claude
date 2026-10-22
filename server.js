#!/usr/bin/env node
// Servidor MCP (stdio) que controla um Chromium headless e, no mesmo processo,
// serve a visão ao vivo na porta 3000. Atenção: stdout é o canal MCP — logs vão para stderr.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import {
  iniciarNavegador, pagina, fecharNavegador, retirarAvisos, infoElemento, infoElementoFocado,
  campoSensivel, pareceCartao, motivoConfirmacaoClique, motivoConfirmacaoEnter, confirmar, normalizarUrl,
  infoNoPonto, marcarClique, moverMouse, comCursorDesenhado, cursor, VIEWPORT,
  listarElementos, listarAbas, ativarAba, novaAba, fecharAba,
} from './src/navegador.js';
import { registrar } from './src/eventos.js';
import { iniciarWeb } from './src/web.js';
import { iniciarTunel } from './src/tunel.js';
import { configurarChat, pararPedido } from './src/chat.js';

const LIMITE_TEXTO = 20_000;

// As ferramentas ficam guardadas para registrar em cada servidor: o do stdio (o claude do terminal)
// e os do HTTP em /mcp (o claude que roda os pedidos feitos pela visão ao vivo).
const ferramentas = [];

function criarServidor() {
  const s = new McpServer({ name: 'navegador', version: '1.0.0' });
  for (const [nome, config, fn] of ferramentas) s.registerTool(nome, config, fn);
  return s;
}

const texto = (t) => ({ content: [{ type: 'text', text: t }] });
const erro = (t) => ({ content: [{ type: 'text', text: t }], isError: true });

// Envolve cada ferramenta: registra a ação no log ao vivo e anexa avisos de bloqueio.
function ferramenta(nome, descricao, inputSchema, fn, resumo) {
  ferramentas.push([nome, { description: descricao, inputSchema }, async (args) => {
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
  }]);
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
    const page = await pagina();
    const resp = await page.goto(normalizarUrl(url), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    return texto(`Aberto: ${page.url()} — "${await page.title()}" (HTTP ${resp?.status() ?? '?'})`);
  },
  ({ url }) => url,
);

const coordX = z.number().min(0).max(VIEWPORT.width - 1);
const coordY = z.number().min(0).max(VIEWPORT.height - 1);
const BOTOES = { esquerdo: 'left', direito: 'right', meio: 'middle' };
const NAO_AUTORIZADO = (motivo) =>
  erro(`Ação não autorizada pelo usuário (${motivo}). Não tente contornar; pergunte ao usuário.`);

ferramenta(
  'clicar',
  'Clica com o mouse. Use coordenadas x/y (pixels do screenshot, viewport ' +
    `${VIEWPORT.width}×${VIEWPORT.height}) ou localize por texto visível / seletor CSS. ` +
    'Envios de formulário e compras exigem confirmação do usuário na visão ao vivo.',
  {
    x: coordX.optional().describe('Coordenada X (pixels do screenshot)'),
    y: coordY.optional().describe('Coordenada Y (pixels do screenshot)'),
    texto: z.string().optional().describe('Texto visível do elemento'),
    seletor: z.string().optional().describe('Seletor CSS ou Playwright (tem prioridade sobre texto)'),
    botao: z.enum(['esquerdo', 'direito', 'meio']).optional().describe('Botão do mouse (padrão: esquerdo)'),
    duplo: z.boolean().optional().describe('Clique duplo'),
  },
  async (args) => {
    const page = await pagina();
    const opcoes = { button: BOTOES[args.botao ?? 'esquerdo'], clickCount: args.duplo ? 2 : 1 };
    let x = args.x, y = args.y, info;
    if (x !== undefined && y !== undefined) {
      info = await infoNoPonto(page, x, y);
    } else {
      const alvo = await localizar(page, args);
      if (!alvo) return erro('Informe "x" e "y", "texto" ou "seletor".');
      await alvo.waitFor({ state: 'visible', timeout: 5_000 });
      await alvo.scrollIntoViewIfNeeded({ timeout: 5_000 });
      info = await infoElemento(alvo);
      const caixa = await alvo.boundingBox();
      if (!caixa) return erro('Elemento sem área visível para clicar.');
      x = caixa.x + caixa.width / 2;
      y = caixa.y + caixa.height / 2;
    }
    const motivo = motivoConfirmacaoClique(info);
    if (motivo && !(await confirmar(motivo))) return NAO_AUTORIZADO(motivo);
    await moverMouse(page, x, y);
    marcarClique(x, y);
    await comNavegacao(page, () => page.mouse.click(x, y, opcoes));
    const sobre = info ? ` sobre <${info.tag}>${info.texto ? ` "${info.texto.slice(0, 60)}"` : ''}` : '';
    return texto(`Clicado em (${Math.round(x)}, ${Math.round(y)})${sobre}. Página atual: ${page.url()} — "${await page.title()}"`);
  },
  ({ x, y, texto: t, seletor, duplo, botao }) =>
    `${x !== undefined ? `(${Math.round(x)}, ${Math.round(y)})` : seletor ?? `"${t}"`}${duplo ? ' duplo' : ''}${botao && botao !== 'esquerdo' ? ` ${botao}` : ''}`,
);

ferramenta(
  'mover_mouse',
  `Move o mouse até (x, y) em pixels do screenshot (viewport ${VIEWPORT.width}×${VIEWPORT.height}), ` +
    'por exemplo para abrir menus de passar o mouse (hover).',
  { x: coordX, y: coordY },
  async ({ x, y }) => {
    const page = await pagina();
    await moverMouse(page, x, y);
    const info = await infoNoPonto(page, x, y).catch(() => null);
    return texto(`Mouse em (${Math.round(x)}, ${Math.round(y)})${info ? `, sobre <${info.tag}> "${info.texto.slice(0, 60)}"` : ''}.`);
  },
  ({ x, y }) => `(${Math.round(x)}, ${Math.round(y)})`,
);

ferramenta(
  'arrastar',
  'Pressiona o botão do mouse em (de_x, de_y), arrasta até (para_x, para_y) e solta. ' +
    'Útil para sliders, arrastar e soltar e selecionar texto.',
  { de_x: coordX, de_y: coordY, para_x: coordX, para_y: coordY },
  async ({ de_x, de_y, para_x, para_y }) => {
    const page = await pagina();
    // Soltar no mesmo elemento em que pressionou equivale a um clique: aplica a mesma regra.
    const motivo = motivoConfirmacaoClique(await infoNoPonto(page, de_x, de_y));
    if (motivo && !(await confirmar(motivo))) return NAO_AUTORIZADO(motivo);
    await moverMouse(page, de_x, de_y);
    await page.mouse.down();
    await moverMouse(page, para_x, para_y, 700);
    await comNavegacao(page, () => page.mouse.up());
    return texto(`Arrastado de (${Math.round(de_x)}, ${Math.round(de_y)}) até (${Math.round(para_x)}, ${Math.round(para_y)}).`);
  },
  ({ de_x, de_y, para_x, para_y }) =>
    `(${Math.round(de_x)}, ${Math.round(de_y)}) → (${Math.round(para_x)}, ${Math.round(para_y)})`,
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
  'pressionar_tecla',
  'Pressiona uma tecla ou atalho no elemento focado, ex.: "Enter", "Tab", "Escape", "Backspace", "ArrowDown", ' +
    '"PageDown", "Control+A", "Shift+Tab". Pode repetir.',
  {
    tecla: z.string().min(1).describe('Nome da tecla no formato do Playwright; combine com "+"'),
    vezes: z.number().int().min(1).max(50).optional().describe('Quantas vezes pressionar (padrão 1)'),
  },
  async ({ tecla, vezes = 1 }) => {
    const page = await pagina();
    const info = await infoElementoFocado(page);
    // Teclas que geram caractere (ex.: "a", "1") seriam uma forma de digitar em campo de senha/cartão.
    const principal = tecla.split('+').at(-1);
    const geraCaractere = principal.length === 1 && !/(^|\+)(Control|Meta|Alt)\+/.test(tecla);
    if (geraCaractere && campoSensivel(info)) {
      registrar('bloqueio', 'tentativa de digitar senha/dados de cartão recusada');
      return erro(RECUSA_SENSIVEL);
    }
    if (/^(NumpadEnter|Enter)$/.test(principal)) {
      const motivo = motivoConfirmacaoEnter(info);
      if (motivo && !(await confirmar(motivo))) return NAO_AUTORIZADO(motivo);
    }
    await comNavegacao(page, async () => {
      for (let i = 0; i < vezes; i++) await page.keyboard.press(tecla);
    });
    return texto(`Pressionado ${tecla}${vezes > 1 ? ` ×${vezes}` : ''}. Página atual: ${page.url()}`);
  },
  ({ tecla, vezes = 1 }) => `${tecla}${vezes > 1 ? ` ×${vezes}` : ''}`,
);

ferramenta(
  'rolar',
  'Rola a página para cima ou para baixo.',
  {
    direcao: z.enum(['baixo', 'cima']).default('baixo'),
    pixels: z.number().int().positive().max(10_000).default(600),
    x: coordX.optional().describe('Onde posicionar o mouse antes de rolar (ex.: dentro de um painel); padrão: centro'),
    y: coordY.optional(),
  },
  async ({ direcao = 'baixo', pixels = 600, x, y }) => {
    const page = await pagina();
    const { width, height } = page.viewportSize();
    x ??= width / 2;
    y ??= height / 2;
    await moverMouse(page, x, y);
    await page.mouse.wheel(0, direcao === 'baixo' ? pixels : -pixels);
    await page.waitForTimeout(300);
    const pos = await page.evaluate(() => [Math.round(scrollY), document.documentElement.scrollHeight - innerHeight]);
    return texto(`Rolado ${pixels}px para ${direcao}. Posição ${pos[0]} de ${Math.max(pos[1], 0)}.`);
  },
  ({ direcao = 'baixo', pixels = 600 }) => `${direcao} ${pixels}px`,
);

ferramenta(
  'ler_texto_da_pagina',
  'Devolve o título, a URL e o texto visível da página atual (ou só de uma parte, com "seletor").',
  { seletor: z.string().optional().describe('Lê só o texto deste elemento (ex.: "main", "#resultados")') },
  async ({ seletor }) => {
    const page = await pagina();
    let corpo = await page.locator(seletor ?? 'body').first().innerText({ timeout: 5_000 }).catch(() => '');
    corpo = corpo.replace(/\n{3,}/g, '\n\n').trim();
    const cortado = corpo.length > LIMITE_TEXTO;
    return texto(
      `URL: ${page.url()}\nTítulo: ${await page.title()}\n\n${corpo.slice(0, LIMITE_TEXTO)}` +
        (cortado ? `\n\n[... texto cortado em ${LIMITE_TEXTO} de ${corpo.length} caracteres]` : ''),
    );
  },
  ({ seletor }) => seletor ?? '',
);

ferramenta(
  'tirar_screenshot',
  'Tira um screenshot da área visível (ou da página inteira) e devolve a imagem. ' +
    'Na área visível, a seta vermelha mostra onde está o mouse.',
  { pagina_inteira: z.boolean().optional().describe('Captura a página inteira em vez da área visível') },
  async ({ pagina_inteira }) => {
    const page = await pagina();
    const capturar = () => page.screenshot({ type: 'png', fullPage: !!pagina_inteira, timeout: 10_000 });
    const img = pagina_inteira ? await capturar() : await comCursorDesenhado(page, capturar);
    const mouse = cursor.x !== null ? ` Mouse em (${cursor.x}, ${cursor.y}).` : '';
    return {
      content: [
        { type: 'image', data: img.toString('base64'), mimeType: 'image/png' },
        { type: 'text', text: `Viewport ${VIEWPORT.width}×${VIEWPORT.height}: 1 pixel da imagem = 1 unidade de x/y.${mouse}` },
      ],
    };
  },
  ({ pagina_inteira }) => (pagina_inteira ? 'página inteira' : 'área visível'),
);

ferramenta(
  'listar_elementos',
  'Lista os elementos interativos visíveis (links, botões, campos, menus…) com o centro de cada um em x/y ' +
    'da tela. Use antes de clicar para acertar o alvo sem precisar de screenshot. "filtro" busca pelo rótulo.',
  {
    filtro: z.string().optional().describe('Só elementos cujo rótulo contém este texto (sem diferenciar maiúsculas)'),
    toda_pagina: z.boolean().optional().describe('Inclui também os elementos fora da área visível'),
  },
  async ({ filtro, toda_pagina }) => {
    const page = await pagina();
    const itens = await listarElementos(page, { filtro, todos: !!toda_pagina });
    if (!itens.length) return texto(`Nenhum elemento interativo${filtro ? ` com "${filtro}"` : ''} encontrado.`);
    const linhas = itens.map((e, i) =>
      `${i + 1}. [${e.papel}] "${e.rotulo}" — (${e.x}, ${e.y})${e.extra.length ? ` · ${e.extra.join(' · ')}` : ''}`);
    return texto(`${page.url()}\n${itens.length} elemento(s)${itens.length >= 150 ? ' (limite)' : ''}:\n${linhas.join('\n')}`);
  },
  ({ filtro, toda_pagina }) => `${filtro ? `"${filtro}"` : 'todos'}${toda_pagina ? ' (página inteira)' : ''}`,
);

ferramenta(
  'navegar_historico',
  'Volta, avança ou recarrega a página atual.',
  { acao: z.enum(['voltar', 'avancar', 'recarregar']) },
  async ({ acao }) => {
    const page = await pagina();
    const opcoes = { waitUntil: 'domcontentloaded', timeout: 30_000 };
    const resp = acao === 'voltar' ? await page.goBack(opcoes)
      : acao === 'avancar' ? await page.goForward(opcoes) : await page.reload(opcoes);
    if (!resp && acao !== 'recarregar') return texto(`Não há página para ${acao}. Atual: ${page.url()}`);
    return texto(`Página atual: ${page.url()} — "${await page.title()}"`);
  },
  ({ acao }) => acao,
);

ferramenta(
  'esperar',
  'Espera um texto ou elemento aparecer na página (até "segundos"), ou só aguarda esse tempo. ' +
    'Útil depois de ações que carregam conteúdo aos poucos.',
  {
    texto: z.string().optional().describe('Texto que deve ficar visível'),
    seletor: z.string().optional().describe('Seletor CSS que deve ficar visível'),
    segundos: z.number().positive().max(30).optional().describe('Tempo máximo (padrão 10) ou tempo de espera fixo'),
  },
  async ({ texto: t, seletor, segundos }) => {
    const page = await pagina();
    if (!t && !seletor) {
      await page.waitForTimeout((segundos ?? 1) * 1000);
      return texto(`Aguardado ${segundos ?? 1}s. Página atual: ${page.url()}`);
    }
    const alvo = seletor ? page.locator(seletor).first() : page.getByText(t).first();
    try {
      await alvo.waitFor({ state: 'visible', timeout: (segundos ?? 10) * 1000 });
      return texto(`Apareceu: ${seletor ?? `"${t}"`}.`);
    } catch {
      return erro(`Não apareceu em ${segundos ?? 10}s: ${seletor ?? `"${t}"`}.`);
    }
  },
  ({ texto: t, seletor, segundos }) => `${seletor ?? (t ? `"${t}"` : '')}${segundos ? ` ${segundos}s` : ''}`,
);

ferramenta(
  'selecionar_opcao',
  'Escolhe uma opção em uma lista suspensa <select>, localizada por seletor ou pelas coordenadas x/y. ' +
    'A opção pode ser o texto visível ou o value.',
  {
    opcao: z.string().describe('Texto visível ou value da opção'),
    seletor: z.string().optional().describe('Seletor do <select>'),
    x: coordX.optional(),
    y: coordY.optional(),
  },
  async ({ opcao, seletor, x, y }) => {
    const page = await pagina();
    let alvo;
    if (seletor) alvo = await page.locator(seletor).first().elementHandle({ timeout: 5_000 });
    else if (x !== undefined && y !== undefined) {
      alvo = (await page.evaluateHandle(([x, y]) => document.elementFromPoint(x, y)?.closest('select'), [x, y])).asElement();
    }
    if (!alvo) return erro('Nenhum <select> encontrado. Informe "seletor" ou "x"/"y" sobre a lista.');
    if (campoSensivel(await alvo.evaluate((el) => {
      const labels = el.labels ? [...el.labels].map((l) => l.innerText).join(' ') : '';
      return { tipo: '', atributos: [el.name, el.id, el.getAttribute('autocomplete'), el.getAttribute('aria-label'), labels].join(' ') };
    }))) {
      registrar('bloqueio', 'tentativa de preencher dado de cartão recusada');
      return erro(RECUSA_SENSIVEL);
    }
    const caixa = await alvo.boundingBox();
    if (caixa) await moverMouse(page, caixa.x + caixa.width / 2, caixa.y + caixa.height / 2);
    let escolhidas = [];
    await comNavegacao(page, async () => {
      escolhidas = await alvo.selectOption([{ label: opcao }], { timeout: 3_000 })
        .catch(() => alvo.selectOption(opcao, { timeout: 3_000 }));
    });
    return texto(`Selecionado: ${escolhidas.join(', ') || opcao}. Página atual: ${page.url()}`);
  },
  ({ opcao, seletor }) => `${seletor ?? '(x/y)'} ← "${opcao}"`,
);

ferramenta(
  'abas',
  'Gerencia as abas: "listar", "trocar" (por indice), "nova" (com url opcional) ou "fechar" (por indice; padrão: a ativa).',
  {
    acao: z.enum(['listar', 'trocar', 'nova', 'fechar']),
    indice: z.number().int().min(0).optional().describe('Índice da aba, como em "listar"'),
    url: z.string().optional().describe('Para "nova": endereço a abrir (padrão: página inicial)'),
  },
  async ({ acao, indice, url }) => {
    if (acao === 'trocar') {
      if (indice === undefined) return erro('Informe "indice".');
      await ativarAba(indice);
    } else if (acao === 'nova') {
      await novaAba(url && normalizarUrl(url));
    } else if (acao === 'fechar') {
      const abas = await listarAbas();
      await fecharAba(indice ?? abas.find((a) => a.ativa)?.indice ?? abas.length - 1);
    }
    const lista = (await listarAbas())
      .map((a) => `${a.ativa ? '→' : ' '} ${a.indice}. ${a.titulo || '(sem título)'} — ${a.url}`);
    return texto(`Abas:\n${lista.join('\n')}`);
  },
  ({ acao, indice, url }) => `${acao}${indice !== undefined ? ` ${indice}` : ''}${url ? ` ${url}` : ''}`,
);

// ---------- inicialização ----------

const PORTA_WEB = Number(process.env.PORT) || 3000;
let tunel = null;
// O túnel só sobe se a porta abriu (outra sessão do claude já pode estar servindo a visão).
const web = iniciarWeb({
  porta: PORTA_WEB,
  aoIniciar: () => { if (process.env.NAVEGADOR_TUNEL !== '0') tunel = iniciarTunel(PORTA_WEB); },
  // Sem estado: cada requisição ganha um servidor e um transporte próprios.
  aoMcp: async (req, res) => {
    const s = criarServidor();
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { t.close(); s.close(); });
    await s.connect(t);
    await t.handleRequest(req, res);
  },
});
configurarChat({ urlMcp: `http://127.0.0.1:${PORTA_WEB}/mcp` });
iniciarNavegador().catch((e) => process.stderr.write(`[navegador] falha ao abrir o Chromium: ${e.message}\n`));

const server = criarServidor();
const transport = new StdioServerTransport();
await server.connect(transport);
registrar('início', 'servidor MCP pronto');

let encerrando = false;
async function encerrar() {
  if (encerrando) return;
  encerrando = true;
  tunel?.fechar();
  pararPedido();
  web.fechar();
  await fecharNavegador();
  process.exit(0);
}
server.server.onclose = encerrar;
process.stdin.on('end', encerrar);
process.on('SIGINT', encerrar);
process.on('SIGTERM', encerrar);
