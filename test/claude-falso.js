#!/usr/bin/env node
// Faz o papel do `claude -p` nos testes do chat: usa o MCP em HTTP passado em --mcp-config
// (como o claude de verdade faria) e responde no formato stream-json.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const args = process.argv.slice(2);
const valor = (flag) => args[args.indexOf(flag) + 1];
const { url, headers } = JSON.parse(valor('--mcp-config')).mcpServers.navegador;
const pedido = valor('-p');
const sessao = args.includes('--resume') ? valor('--resume') : 'sessao-1';
const linha = (obj) => process.stdout.write(JSON.stringify({ session_id: sessao, ...obj }) + '\n');

linha({ type: 'system', subtype: 'init' });
const client = new Client({ name: 'claude-falso', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
const r = await client.callTool({ name: 'abrir_url', arguments: { url: pedido } });
await client.close();
linha({ type: 'assistant', message: { content: [{ type: 'text', text: `Feito (${args.includes('--resume') ? 'continuando' : 'nova'}): ${r.content[0].text}` }] } });
linha({ type: 'result', is_error: false });
