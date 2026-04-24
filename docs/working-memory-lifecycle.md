# Working Memory Lifecycle

## Lifecycle

```
Task Start:
  1. Clear previous working_memory
  2. Write task description: {task_id, goal, constraints, deadline}
  3. Write sub-agent state: {agent_id, status, output_route}

Task Execution:
  4. Append intermediate states: {step, result, next_action}

Task Complete:
  5. Write final result: {output, route_to, delivered: false}
  6. Route output based on route_to
  7. Mark delivered: true
  8. Clear working_memory (keep task_id + delivered status)
```

## Routing Decision (Automatic: Private vs Group)

```
if (task_source == "private_dm"):
    → route_to = private (original sender)
elif (task contains sensitive info / diagnosis / personal data):
    → route_to = private (admin / relevant person)
elif (task_source == "group_chat" AND task is explicitly for group):
    → route_to = group chat
elif (task_source == "cron"):
    → route_to = private (admin)
else:
    → route_to = private (default, safe-first)
```

## Sub-Agent Task Template

```
You are a sub-agent. Execute the following task.

## Task Info
- Task ID: {task_id}
- Goal: {goal}
- Constraints: {constraints}

## Output Route (Hard Constraint)
- Deliver results to: {route_to}
- Forbidden: sending to other channels
- Forbidden: including unrelated project names in output

## Context Scope
- Focus only on the above task info
- Do NOT reference parent session's other context
```
