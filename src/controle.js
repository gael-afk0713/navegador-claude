// Controle manual pela visão ao vivo: cliques, rolagem, teclado e navegação feitos pelo usuário.
// O usuário é quem decide aqui, então não há confirmação nem bloqueio de senha/cartão;
// o texto digitado nunca vai para o log, só o tamanho.
import { pagina, liberarEnvios, normalizarUrl, marcarCursor, marcarClique } from './navegador.js';
import { registrar } from './eventos.js';

const TECLAS = new Set([
  'Enter', 'Backspace', 'Delete', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
]);

const numero = (v, min, max) => (Number.isFinite(v) ? Math.min(Math.max(v, min), max) : null);

export async function acaoDoUsuario(msg) {
  const page = await pagina();
  const { width, height } = page.viewportSize();

  switch (msg.tipo) {
    case 'clique': {
      const x = numero(msg.x, 0, width - 1), y = numero(msg.y, 0, height - 1);
      if (x === null || y === null) return;
      // Um clique do usuário pode enviar formulários (ex.: CAPTCHA); a decisão é dele.
      await liberarEnvios();
      await page.mouse.click(x, y);
      marcarCursor(x, y);
      marcarClique(x, y);
      registrar('você', `clique em (${Math.round(x)}, ${Math.round(y)})`);
      return;
    }
    case 'rolar': {
      const dx = numero(msg.dx, -5000, 5000) ?? 0, dy = numero(msg.dy, -5000, 5000) ?? 0;
      const x = numero(msg.x, 0, width - 1) ?? width / 2, y = numero(msg.y, 0, height - 1) ?? height / 2;
      await page.mouse.move(x, y);
      await page.mouse.wheel(dx, dy);
      return; // rolagem é frequente demais para o log
    }
    case 'texto': {
      if (typeof msg.texto !== 'string' || !msg.texto) return;
      const t = msg.texto.slice(0, 2000);
      await page.keyboard.insertText(t);
      registrar('você', `digitou ${t.length} caractere(s)`);
      return;
    }
    case 'tecla': {
      if (!TECLAS.has(msg.tecla)) return;
      if (msg.tecla === 'Enter') await liberarEnvios();
      await page.keyboard.press(msg.tecla);
      registrar('você', `tecla ${msg.tecla}`);
      return;
    }
    case 'abrir': {
      if (typeof msg.url !== 'string' || !msg.url.trim()) return;
      registrar('você', `abrir ${msg.url.trim()}`);
      await page.goto(normalizarUrl(msg.url.trim()), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      return;
    }
    case 'voltar':
      registrar('você', 'voltar');
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 });
      return;
    case 'avancar':
      registrar('você', 'avançar');
      await page.goForward({ waitUntil: 'domcontentloaded', timeout: 15_000 });
      return;
    case 'recarregar':
      registrar('você', 'recarregar');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
  }
}
