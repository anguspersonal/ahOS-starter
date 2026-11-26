#!/usr/bin/env node
import { runActionCli } from "../src/actions/cliRunner.js";

const code = await runActionCli(process.argv.slice(2));
process.exit(code);
