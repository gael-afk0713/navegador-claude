// Token de acesso da visão ao vivo: quem abre o link precisa dele (?t=… ou o cookie que a página grava).
// Fica salvo em .navegador/token para o link continuar o mesmo entre sessões.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

export const PASTA = new URL('../.navegador/', import.meta.url);
const ARQUIVO = new URL('token', PASTA);
const COOKIE = 'nav_t';

function carregarToken() {
  if (process.env.NAVEGADOR_TOKEN) return process.env.NAVEGADOR_TOKEN;
  try {
    const t = readFileSync(ARQUIVO, 'utf8').trim();
    if (t) return t;
  } catch {}
  const t = randomBytes(18).toString('base64url');
  mkdirSync(PASTA, { recursive: true });
  writeFileSync(ARQUIVO, t + '\n', { mode: 0o600 });
  return t;
}

export const token = carregarToken();

const igual = (a) => {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(token);
  return x.length === y.length && timingSafeEqual(x, y);
};

function tokenDoCookie(req) {
  for (const parte of (req.headers.cookie ?? '').split(';')) {
    const [nome, ...valor] = parte.trim().split('=');
    if (nome === COOKIE) return valor.join('=');
  }
  return null;
}

// Diz se a requisição traz o token e por onde (para a página gravar o cookie quando veio na URL).
export function autorizacao(req) {
  const [tipo, valor] = (req.headers.authorization ?? '').split(' ');
  if (tipo === 'Bearer' && igual(valor)) return { ok: true, daUrl: false };
  const daUrl = new URL(req.url, 'http://x').searchParams.get('t');
  if (igual(daUrl)) return { ok: true, daUrl: true };
  return { ok: igual(tokenDoCookie(req)), daUrl: false };
}

export const cookieDeAcesso = () => `${COOKIE}=${token}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`;
