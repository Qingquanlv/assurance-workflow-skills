#!/usr/bin/env node
import { Command } from 'commander';
import { registerInitCommand } from './commands/init';
import { registerDoctorCommand } from './commands/doctor';
import { registerConfigCommand } from './commands/config';
import { registerRunCommand } from './commands/run';
import { registerReportCommand } from './commands/report';
import { registerStatusCommand } from './commands/status';
import { registerGateCommand } from './commands/gate';
import { registerSkillCommand } from './commands/skill';
import { registerRiskCommand } from './commands/risk';

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
registerStatusCommand(program);
registerGateCommand(program);
registerRiskCommand(program);
registerSkillCommand(program);

program.parse(process.argv);
