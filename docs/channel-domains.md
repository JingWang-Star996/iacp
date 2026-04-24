# Channel Domain Isolation

## Rules

1. **Messages from different channel_id do NOT cross-process**
   - Group A's daily reports don't affect Group B's task understanding
   - Private DM takes priority over group chat

2. **Each channel maintains independent context**
   - Channel metadata: channel_id, channel_type, participants
   - Message classification runs within channel context

3. **Cron task isolation**
   - Cron-triggered tasks run in their own channel domain
   - Do NOT share context with other channels

## Channel Type Behavior

- **group** → Messages need classification (report / task / chatter)
- **private** → All messages treated as tasks or conversations
- **cron** → Isolated execution, results sent privately
