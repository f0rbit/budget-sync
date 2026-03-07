#!/usr/bin/env bun
import { Command } from "commander";
import { accountsCommand } from "./commands/accounts.js";
import { exportCommand } from "./commands/export.js";
import { importCommand } from "./commands/import.js";
import { mappingsCommand } from "./commands/mappings.js";
import { networthCommand } from "./commands/networth.js";
import { snapshotCommand } from "./commands/snapshot.js";
import { superCommand } from "./commands/super.js";

const program = new Command()
	.name("budget-sync")
	.description("Personal finance CLI — ingest bank documents, track net worth")
	.version("0.1.0");

program.addCommand(accountsCommand);
program.addCommand(mappingsCommand);
program.addCommand(exportCommand);
program.addCommand(importCommand);
program.addCommand(snapshotCommand);
program.addCommand(networthCommand);
program.addCommand(superCommand);

program.parse();
