#!/usr/bin/env node
/** Gibt die E/A-Liste der Layout-Konfiguration als Markdown-Tabelle aus (für Firmware/Verdrahtung). */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ioList, loadConfig } from '../src/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.resolve(process.argv[2] ?? process.env.RIDE_CONFIG ?? path.join(root, 'config', 'rocking-boat.json'));
const config = await loadConfig(configPath);
const { inputs, outputs } = ioList(config);

const table = (rows) => ['| Signal | Typ | Bedeutung |', '| --- | --- | --- |', ...rows.map((r) => `| \`${r.key}\` | ${r.type.replaceAll('|', '\\|')} | ${r.desc.replaceAll('|', '\\|')} |`)].join('\n');

console.log(`### Eingänge (Hardware → Steuerung) – ${config.name}\n\n${table(inputs)}\n\n### Ausgänge (Steuerung → Hardware)\n\n${table(outputs)}`);
