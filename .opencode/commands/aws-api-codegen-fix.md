---
description: Delegate Api Codegen Fix to aws-fixer
agent: aws-fixer
subtask: true
phase_id: api-codegen-fix
requires_conductor_brief: true
---

# Task: Api Codegen Fix

## If invoked directly

1. Check whether a task brief path was passed in the message.
2. If **no** task brief path, or the brief is missing `change_id` or `allowed_writes`:
   - **STOP immediately**
   - Tell the user:

     > Start from `aws-conductor` and ask it to start the AWS workflow.
     > Phase commands cannot run standalone without a Conductor-generated task brief.

3. Do **not** write files. Do **not** load skills. Do **not** run `aws` CLI.

## If invoked by Conductor (subtask)

1. Read the task brief JSON at the path in the task message.
2. Read only input files listed in the brief.
3. Write only output files listed in the brief (`allowed_writes`).
4. Write `task-result.json` with audit fields (`loaded_skills` must be `[]`).
5. Do **not** load skills. Do **not** run `aws` CLI.
