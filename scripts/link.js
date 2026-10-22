#!/usr/bin/env node
// Mostra o endereço da visão ao vivo (com QR code para a câmera do iPad) e diz se ela está no ar.
// Prefere o túnel da Cloudflare; sem ele, usa a porta encaminhada do Codespaces.
import { readFileSync } from 'node:fs';
import qrcode from 'qrcode-terminal';
import { PASTA, token } from '../src/acesso.js';

const PORTA = 3000;
const { CODESPACE_NAME, GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: DOMINIO } = process.env;

let noAr = false;
try {
  noAr = (await fetch(`http://127.0.0.1:${PORTA}/?t=${token}`, { signal: AbortSignal.timeout(1500) })).ok;
} catch {}

let tunel = null;
try {
  const { url, pid } = JSON.parse(readFileSync(new URL('tunel.json', PASTA), 'utf8'));
  process.kill(pid, 0); // o servidor que abriu o túnel ainda está vivo?
  tunel = url;
} catch {}

const base = tunel ?? (CODESPACE_NAME && DOMINIO ? `https://${CODESPACE_NAME}-${PORTA}.${DOMINIO}` : `http://localhost:${PORTA}`);
const link = `${base}/?t=${token}`;

console.log('\nNavegador Claude — visão ao vivo\n');
console.log(`  ${link}\n`);
qrcode.generate(link, { small: true }, (qr) => console.log(qr));
if (!noAr) {
  console.log('✗ Ainda não está no ar: abra o `claude` nesta pasta (o navegador sobe junto com a sessão).');
} else if (tunel) {
  console.log('✓ No ar pelo túnel da Cloudflare. Aponte a câmera do iPad para o QR code ou abra o link acima.');
  console.log('  O link muda a cada sessão do claude; o token no fim dele é o que protege o acesso — não compartilhe.');
} else {
  console.log('✓ No ar, mas o túnel ainda não subiu (aguarde uns segundos e rode de novo); por enquanto, link da porta.');
  if (CODESPACE_NAME) console.log('  A porta é privada: no Safari, entre na sua conta do GitHub se ele pedir.');
}
