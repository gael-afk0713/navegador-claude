// Túnel rápido da Cloudflare (trycloudflare.com) até a visão ao vivo: um link https que abre no iPad
// sem o proxy de portas do Codespaces. O link vai para .navegador/tunel.json, que o `npm run link` lê.
// Desligue com NAVEGADOR_TUNEL=0.
import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PASTA } from './acesso.js';

const ARQUIVO_LINK = fileURLToPath(new URL('tunel.json', PASTA));
const BINARIO_LOCAL = fileURLToPath(new URL('cloudflared', PASTA));
const ARQUITETURAS = { x64: 'amd64', arm64: 'arm64' };
const log = (m) => process.stderr.write(`[navegador] ${m}\n`);

// Usa o cloudflared do PATH ou baixa o binário oficial da Cloudflare para .navegador/.
async function binario() {
  try {
    execFileSync('cloudflared', ['--version'], { stdio: 'ignore' });
    return 'cloudflared';
  } catch {}
  if (existsSync(BINARIO_LOCAL)) return BINARIO_LOCAL;
  const arq = ARQUITETURAS[process.arch];
  if (process.platform !== 'linux' || !arq) throw new Error('instale o cloudflared (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)');
  log('baixando o cloudflared…');
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arq}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!resp.ok) throw new Error(`download do cloudflared falhou (HTTP ${resp.status})`);
  mkdirSync(PASTA, { recursive: true });
  writeFileSync(BINARIO_LOCAL, Buffer.from(await resp.arrayBuffer()));
  chmodSync(BINARIO_LOCAL, 0o755);
  return BINARIO_LOCAL;
}

const apagarLink = () => rmSync(ARQUIVO_LINK, { force: true });

export function iniciarTunel(porta) {
  let processo = null, fechado = false, tentativas = 0;
  apagarLink();

  async function subir() {
    let cmd;
    try {
      cmd = await binario();
    } catch (e) {
      return log(`túnel indisponível: ${e.message}`);
    }
    if (fechado) return;
    processo = spawn(cmd, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${porta}`], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let saida = '';
    processo.stderr.on('data', (d) => {
      if (saida === null) return;
      saida += d;
      const url = saida.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
      if (url) {
        saida = null;
        tentativas = 0;
        writeFileSync(ARQUIVO_LINK, JSON.stringify({ url, pid: process.pid }));
        log(`túnel no ar: ${url}`);
      }
    });
    processo.on('error', (e) => log(`túnel: ${e.message}`));
    processo.on('exit', () => {
      apagarLink();
      processo = null;
      if (fechado) return;
      // Caiu: tenta de novo, esperando mais a cada falha seguida (até 1 min).
      const espera = Math.min(60_000, 3_000 * 2 ** tentativas++);
      log(`túnel caiu; nova tentativa em ${espera / 1000}s`);
      setTimeout(subir, espera).unref();
    });
  }
  subir();

  return {
    fechar() {
      fechado = true;
      processo?.kill();
      apagarLink();
    },
  };
}
