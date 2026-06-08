#!/usr/bin/env node
import { Command } from 'commander';
import { registerInitCommand } from './commands/init';
import { registerDoctorCommand } from './commands/doctor';
import { registerConfigCommand } from './commands/config';
import { registerRunCommand } from './commands/run';
import { registerReportCommand } from './commands/report';

const program = new Command();

program
  .name('aws')
  .description('AWS — Assurance Workflow Engine CLI')
  .version('0.1.0');

registerInitCommand(program);
registerDoctorCommand(program);
registerConfigCommand(program);
registerRunCommand(program);
registerReportCommand(program);

program.parse(process.argv);
