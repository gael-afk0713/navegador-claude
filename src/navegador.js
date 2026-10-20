// Navegador Chromium único e compartilhado (Playwright, headless).
import { chromium } from 'playwright';
import { registrar, pedirConfirmacao } from './eventos.js';

const VIEWPORT = { width: 1180, height: 820 }; // proporção próxima à do iPad

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

    paginaAtual = await context.newPage();

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

export async function pagina() {
  await iniciarNavegador();
  if (!paginaAtual || paginaAtual.isClosed()) paginaAtual = await context.newPage();
  return paginaAtual;
}

export function paginaSeAberta() {
  return paginaAtual && !paginaAtual.isClosed() ? paginaAtual : null;
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

export async function infoElementoFocado(page) {
  return page.evaluate(`(${descreverElemento})(document.activeElement)`);
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

// Pede confirmação na página ao vivo; se aprovado, libera envios POST por alguns segundos.
export async function confirmar(motivo) {
  const ok = await pedirConfirmacao(motivo);
  if (ok) {
    envioLiberadoAte = Date.now() + 15_000;
    await paginaSeAberta()?.evaluate(() => { window.__envioLiberadoAte = Date.now() + 15_000; }).catch(() => {});
  }
  return ok;
}
