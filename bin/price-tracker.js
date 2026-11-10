#!/usr/bin/env node
import { main } from '../src/cli.js';

main().catch((err) => {
  console.error(`✖ ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
