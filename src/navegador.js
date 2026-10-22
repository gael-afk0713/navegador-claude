// Navegador Chromium único e compartilhado (Playwright, headless).
import { chromium } from 'playwright';
import { registrar, pedirConfirmacao, bus } from './eventos.js';

export const VIEWPORT = { width: 1180, height: 820 }; // proporção próxima à do iPad
// Página que abre quando o navegador sobe (ou quando a aba ativa é recriada).
const PAGINA_INICIAL = process.env.NAVEGADOR_INICIAL ?? 'https://www.google.com';

let browser;
let context;
let paginaAtual;
let pronto;

// Janela de tempo em que envios POST de navegação estão liberados (após confirmação).
let envioLiberadoAte = 0;
// Avisos de bloqueio para devolver ao Claude no próximo resultado de ferramenta.
const avisosPendentes = [];

export function iniciarNavegador() {
  pronto ??= (async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: VIEWPORT, locale: 'pt-BR' });

    // Rede de segurança 1: dentro da página, cancela envios nativos de formulário não confirmados
    // (preserva a página; o route abaixo trataria isso como erro de navegação).
    await context.exposeBinding('__navegadorBloqueio', (_src, acao) => {
      const msg = `envio de formulário para ${acao} bloqueado (sem confirmação)`;
      avisosPendentes.push(msg);
      registrar('bloqueio', msg);
    });
    await context.addInitScript(() => {
      window.addEventListener('submit', (ev) => {
        if ((window.__envioLiberadoAte || 0) > Date.now()) return;
        const form = ev.target;
        const busca = form.getAttribute('role') === 'search' || (form.method || 'get').toLowerCase() === 'get';
        if (busca) return;
        ev.preventDefault();
        window.__navegadorBloqueio(form.action);
      }, true);
    });

    // Rede de segurança 2: bloqueia envios de formulário (navegação não-GET) não confirmados.
    await context.route('**/*', (route) => {
      const req = route.request();
      if (req.isNavigationRequest() && req.method() !== 'GET' && Date.now() > envioLiberadoAte) {
        const msg = `envio ${req.method()} para ${req.url()} bloqueado (sem confirmação)`;
        avisosPendentes.push(msg);
        registrar('bloqueio', msg);
        return route.abort('blockedbyclient');
      }
      return route.fallback();
    });

    paginaAtual = await novaPagina();
    await paginaAtual.mouse.move(cursor.x, cursor.y);

    // Pop-ups e novas abas passam a ser a página ativa.
    context.on('page', (p) => {
      paginaAtual = p;
      registrar('aba', 'nova aba/pop-up aberta; passou a ser a página ativa');
      p.on('close', () => {
        if (paginaAtual === p) paginaAtual = context.pages().at(-1);
      });
    });

    return paginaAtual;
  })();
  return pronto;
}

// Abre uma aba já na página inicial, sem esperar ela carregar (uma ação do Claude pode navegar antes).
async function novaPagina() {
  const p = await context.newPage();
  if (PAGINA_INICIAL && PAGINA_INICIAL !== 'about:blank') {
    p.goto(PAGINA_INICIAL, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
  }
  return p;
}

export async function pagina() {
  await iniciarNavegador();
  if (!paginaAtual || paginaAtual.isClosed()) paginaAtual = await novaPagina();
  return paginaAtual;
}

export function paginaSeAberta() {
  return paginaAtual && !paginaAtual.isClosed() ? paginaAtual : null;
}

// Última posição conhecida do mouse (o Playwright não expõe), mostrada na visão ao vivo.
export const cursor = { x: Math.round(VIEWPORT.width / 2), y: Math.round(VIEWPORT.height / 2) };
export function marcarCursor(x, y) {
  cursor.x = Math.round(x);
  cursor.y = Math.round(y);
  bus.emit('cursor', { ...cursor });
}

export function marcarClique(x, y) {
  bus.emit('clique', { x: Math.round(x), y: Math.round(y) });
}

// Move o mouse em passos visíveis (com aceleração suave), avisando a visão ao vivo a cada passo.
export async function moverMouse(page, x, y, duracaoMs = 400) {
  const x0 = cursor.x, y0 = cursor.y;
  const passos = Math.max(1, Math.min(30, Math.round(Math.hypot(x - x0, y - y0) / 20)));
  for (let i = 1; i <= passos; i++) {
    const t = i / passos;
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    const px = x0 + (x - x0) * e, py = y0 + (y - y0) * e;
    await page.mouse.move(px, py);
    marcarCursor(px, py);
    if (i < passos) await new Promise((r) => setTimeout(r, duracaoMs / passos));
  }
}

// Desenha a seta do mouse dentro da página por um instante, para o screenshot do Claude mostrá-la.
export async function comCursorDesenhado(page, fn) {
  await page.evaluate(([x, y]) => {
    const d = document.createElement('div');
    d.id = '__cursorClaude';
    d.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:2147483647;pointer-events:none;`;
    d.innerHTML = '<svg width="22" height="30" viewBox="0 0 22 30" style="display:block"><path d="M1 1v24l6-6 4 9 4-2-4-9h8z" ' +
      'fill="#d97757" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>' +
      '<span style="position:absolute;left:0;top:32px;background:#d97757;color:#fff;font:600 12px system-ui;' +
      'padding:2px 7px;border-radius:6px;border:1.5px solid #fff;white-space:nowrap">Claude</span>';
    document.documentElement.appendChild(d);
  }, [cursor.x, cursor.y]).catch(() => {});
  try {
    return await fn();
  } finally {
    await page.evaluate(() => document.getElementById('__cursorClaude')?.remove()).catch(() => {});
  }
}

export function retirarAvisos() {
  return avisosPendentes.splice(0);
}

export async function fecharNavegador() {
  await browser?.close().catch(() => {});
}

// ---------- Regras de segurança ----------

const RE_SENSIVEL =
  /password|passwd|senha|\bpin\b|cc-|card|cart[aã]o|cvv|cvc|csc|security.?code|c[oó]digo.?de.?seguran|expir|validade/i;

const RE_COMPRA =
  /\b(comprar|compre|compra agora|finalizar( a)? (compra|pedido)|fechar pedido|confirmar (compra|pedido|pagamento)|pagar|pagamento|checkout|buy|purchase|place (your )?order|order now|pay\b|pay now|assinar|subscribe|contratar)/i;

// Sequência de 13 a 19 dígitos que passa no algoritmo de Luhn = provável número de cartão.
function pareceCartao(texto) {
  for (const m of texto.matchAll(/(?:\d[ -]?){13,19}/g)) {
    const d = m[0].replace(/\D/g, '');
    if (d.length < 13 || d.length > 19) continue;
    let soma = 0;
    for (let i = 0; i < d.length; i++) {
      let n = Number(d[d.length - 1 - i]);
      if (i % 2) n = n * 2 > 9 ? n * 2 - 9 : n * 2;
      soma += n;
    }
    if (soma % 10 === 0) return true;
  }
  return false;
}

// Coleta, dentro da página, o que precisamos saber sobre um elemento.
function descreverElemento(el) {
  if (!el) return null;
  const t = (s) => (s || '').toString().trim();
  const labels = el.labels ? [...el.labels].map((l) => l.innerText).join(' ') : '';
  const form = el.form || el.closest?.('form') || null;
  let formBusca = false;
  if (form) {
    formBusca =
      form.getAttribute('role') === 'search' ||
      !!form.closest('[role=search]') ||
      !!form.querySelector('input[type=search]') ||
      [...form.querySelectorAll('input[name]')].some((i) =>
        ['q', 'query', 'search', 's', 'busca', 'k', 'p', 'term'].includes(i.name.toLowerCase())
      );
  }
  const tag = el.tagName.toLowerCase();
  const tipo = t(el.getAttribute('type')).toLowerCase();
  return {
    tag,
    tipo,
    atributos: [el.name, el.id, el.getAttribute('autocomplete'), el.getAttribute('placeholder'),
      el.getAttribute('aria-label'), labels].map(t).join(' '),
    texto: t(el.innerText || el.value || el.getAttribute('aria-label') || el.title).slice(0, 120),
    emFormulario: !!form,
    formBusca,
    enviaFormulario:
      (tag === 'button' && (tipo === 'submit' || (tipo === '' && !!form))) ||
      (tag === 'input' && (tipo === 'submit' || tipo === 'image')),
  };
}

export async function infoElemento(locator) {
  return locator.evaluate(descreverElemento);
}

// Desce por iframes (ex.: campos de cartão embutidos) até o elemento que tem o foco de fato.
async function elementoFocado(page) {
  let frame = page.mainFrame();
  for (let i = 0; i < 5; i++) {
    const el = (await frame.evaluateHandle(() => document.activeElement)).asElement();
    if (!el) return null;
    const filho = /^i?frame$/i.test(await el.evaluate((e) => e.tagName)) ? await el.contentFrame() : null;
    if (!filho) return el;
    frame = filho;
  }
  return null;
}

export async function infoElementoFocado(page) {
  const el = await elementoFocado(page);
  return el ? el.evaluate(descreverElemento) : null;
}

const SELETOR_INTERATIVO =
  'a,button,input,select,textarea,label,summary,[role=button],[role=link],[role=menuitem],[role=tab],[onclick]';
const SELETOR_LISTAGEM = SELETOR_INTERATIVO +
  ',[role=checkbox],[role=radio],[role=option],[role=switch],[role=combobox],[role=textbox],[contenteditable=""],[contenteditable=true]';

// Elementos interativos da página com o centro em coordenadas da tela, para clicar por x/y com precisão.
// Nunca devolve o valor digitado em campos (só rótulo/placeholder).
export async function listarElementos(page, { filtro, todos = false } = {}) {
  return page.evaluate(([sel, filtro, todos]) => {
    const limpar = (s) => (s || '').toString().replace(/\s+/g, ' ').trim();
    const saida = [];
    const vistos = new Set();
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const st = getComputedStyle(el);
      if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) continue;
      const naTela = r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
      if (!naTela && !todos) continue;
      const x = Math.round(Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1));
      const y = Math.round(Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1));
      const tag = el.tagName.toLowerCase();
      const tipo = (el.getAttribute('type') || '').toLowerCase();
      const rotulo = limpar(
        el.getAttribute('aria-label') || (el.labels && [...el.labels].map((l) => l.innerText).join(' ')) ||
        (tag === 'input' || tag === 'textarea' ? el.placeholder || el.name : el.innerText) ||
        el.title || el.getAttribute('alt') || (tag === 'input' && ['submit', 'button'].includes(tipo) ? el.value : ''),
      ).slice(0, 80);
      if (filtro && !rotulo.toLowerCase().includes(filtro.toLowerCase())) continue;
      const chave = `${x},${y},${rotulo}`;
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      let coberto = false;
      if (naTela) {
        const topo = document.elementFromPoint(x, y);
        coberto = !!topo && topo !== el && !el.contains(topo) && !topo.contains(el);
      }
      const papel = el.getAttribute('role') || (tag === 'input' ? `input${tipo ? ':' + tipo : ''}` : tag);
      const extra = [];
      if (tag === 'a' && el.href) extra.push(el.getAttribute('href').slice(0, 60));
      if (el.disabled) extra.push('desativado');
      if (el.checked) extra.push('marcado');
      if (tag === 'select') extra.push(`selecionado: ${limpar(el.selectedOptions[0]?.text).slice(0, 40)}`);
      if (coberto) extra.push('coberto por outro elemento');
      if (!naTela) extra.push(r.top >= innerHeight ? 'abaixo da tela' : 'fora da tela');
      saida.push({ papel, rotulo, x, y, extra });
      if (saida.length >= 150) break;
    }
    return saida;
  }, [SELETOR_LISTAGEM, filtro ?? '', todos]);
}

// ---------- Abas ----------

export async function listarAbas() {
  await iniciarNavegador();
  return Promise.all(context.pages().map(async (p, i) => ({
    indice: i, url: p.url(), titulo: await p.title().catch(() => ''), ativa: p === paginaAtual,
  })));
}

export async function ativarAba(indice) {
  await iniciarNavegador();
  const p = context.pages()[indice];
  if (!p) throw new Error(`não existe aba ${indice}`);
  paginaAtual = p;
  await p.bringToFront();
  return p;
}

// Abre uma aba nova (vira a ativa pelo evento 'page' do contexto).
export async function novaAba(url) {
  await iniciarNavegador();
  const p = await context.newPage();
  paginaAtual = p;
  await p.goto(url || PAGINA_INICIAL || 'about:blank', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  return p;
}

export async function fecharAba(indice) {
  await iniciarNavegador();
  const p = context.pages()[indice];
  if (!p) throw new Error(`não existe aba ${indice}`);
  await p.close();
  if (!context.pages().length) paginaAtual = await novaPagina();
  return pagina();
}

// Elemento clicável sob as coordenadas (x, y) da janela, descendo por iframes.
export async function infoNoPonto(page, x, y) {
  let frame = page.mainFrame();
  for (let i = 0; i < 5; i++) {
    const el = (await frame.evaluateHandle(([x, y]) => document.elementFromPoint(x, y), [x, y])).asElement();
    if (!el) return null;
    if (/^i?frame$/i.test(await el.evaluate((e) => e.tagName))) {
      const filho = await el.contentFrame();
      if (filho) {
        const [dx, dy] = await el.evaluate((e) => {
          const r = e.getBoundingClientRect();
          return [r.left + e.clientLeft, r.top + e.clientTop];
        });
        x -= dx;
        y -= dy;
        frame = filho;
        continue;
      }
    }
    const alvo = await el.evaluateHandle((e, sel) => e.closest(sel) || e, SELETOR_INTERATIVO);
    return alvo.evaluate(descreverElemento);
  }
  return null;
}

export function campoSensivel(info) {
  if (!info) return false;
  return info.tipo === 'password' || RE_SENSIVEL.test(info.atributos);
}

export { pareceCartao };

// Decide se um clique precisa de confirmação; devolve o motivo ou null.
export function motivoConfirmacaoClique(info) {
  if (!info) return null;
  if (RE_COMPRA.test(info.texto)) return `clicar em "${info.texto}" parece uma compra/pagamento`;
  if (info.enviaFormulario && !info.formBusca) return `clicar em "${info.texto || info.tag}" envia um formulário`;
  return null;
}

export function motivoConfirmacaoEnter(info) {
  if (info?.emFormulario && !info.formBusca) return 'pressionar Enter vai enviar um formulário';
  return null;
}

// Libera envios POST por alguns segundos (após confirmação ou ação feita pelo próprio usuário).
export async function liberarEnvios() {
  envioLiberadoAte = Date.now() + 15_000;
  await paginaSeAberta()?.evaluate(() => { window.__envioLiberadoAte = Date.now() + 15_000; }).catch(() => {});
}

// Pede confirmação na página ao vivo; se aprovado, libera envios POST.
export async function confirmar(motivo) {
  const ok = await pedirConfirmacao(motivo);
  if (ok) await liberarEnvios();
  return ok;
}

// Tem esquema (https:, data:, about:...)? Senão, assume https. "localhost:3000" não é esquema.
export function normalizarUrl(url) {
  return /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(url) ? url : `https://${url}`;
}
