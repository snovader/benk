#!/usr/bin/env node
// The entry point of benk-d8, the package's command, which runs a benchmark
// script in d8 from Node, as `node/d8-command.ts` describes, with the
// process's arguments. It exits with d8's code, and prints an error of its
// own with its message, without a stack, as a command does.
import { runD8Command } from './node/d8-command.ts';

try {
    process.exitCode = await runD8Command(process.argv.slice(2));
} catch (error) {
    console.error(`benk-d8: ${String(error)}`);
    process.exitCode = 1;
}
