#!/usr/bin/env node
import { Command } from 'commander';
import { registerInitCommand } from './commands/init';
import { registerDoctorCommand } from './commands/doctor';
import { registerConfigCommand } from './commands/config';

const program = new Command();

program
  .name('awe')
  .description('AWE — Assurance Workflow Engine CLI')
  .version('0.1.0');

registerInitCommand(program);
registerDoctorCommand(program);
registerConfigCommand(program);

program.parse(process.argv);
