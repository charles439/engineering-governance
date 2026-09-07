#!/usr/bin/env node
if (process.env.FAKE_TOOL_EXIT === '1') {
  console.error('fake tool violation');
  process.exit(1);
}
console.log(`fake tool pass (${process.argv.slice(2).join(' ')})`);
