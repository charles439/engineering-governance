#!/usr/bin/env node

if (process.env.FAKE_CHECKER_EXIT === '1') {
  console.error('fake checker violation');
  process.exit(1);
}

console.log(`fake checker pass (${process.argv.slice(2).join(' ')})`);
