#!/usr/bin/env node
import { runHook } from '../src/hook.mjs';

const kind = process.argv[2];
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const out = await runHook(kind, Buffer.concat(chunks).toString('utf8'));
if (out) process.stdout.write(out);
