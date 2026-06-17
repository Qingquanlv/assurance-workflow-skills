---
description: Delegate API test planning to designer subagent
agent: aws-designer
subtask: true
phase_id: api-plan
requires_conductor_brief: true
---

# Task: API Plan

## If invoked directly (user ran `/aws-api-plan`)

1. Check whether a task brief path was passed in the message.
2. If **no** task brief path:
   - **STOP immediately**
   - Tell the user:

     > Start from `aws-conductor` and ask it to start the AWS workflow.
     > Phase commands cannot run standalone without a Conductor-generated task brief.

3. Do **not** load skills. Do **not** run `aws` CLI.

## If invoked by Conductor (subtask)

1. Read the task brief JSON at the path in the task message.
2. Write only output files listed in the brief.
