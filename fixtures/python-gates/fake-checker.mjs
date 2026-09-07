#!/usr/bin/env node
if (process.env.EXPECT_CWD && process.cwd() !== process.env.EXPECT_CWD) {
  console.error(`unexpected cwd ${process.cwd()}`);
  process.exitCode = 2;
} else if (process.env.FAKE_CHECKER_EXIT === '1') {
  console.error('fake import-linter violation');
  process.exitCode = 1;
} else if (process.env.FAKE_CHECKER_EXIT && process.env.FAKE_CHECKER_EXIT !== '0') {
  process.stderr.write('fake import-linter execution error\n');
  process.exitCode = Number(process.env.FAKE_CHECKER_EXIT);
} else {
  console.log('fake import-linter pass');
}
