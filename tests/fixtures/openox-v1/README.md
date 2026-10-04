# Pre-extraction storage fixture

Produced by OpenOx's original `Sessions` implementation from commit `05ae1c7`
and installed Pi 1.0.0, before removing that implementation from OpenOx.
The predecessor launched real Pi and submitted one short model prompt:
`Reply exactly PERSISTED_BEFORE_EXTRACTION. Do not use tools.`

The metadata remains version 1 and the Pi JSONL header remains version 3.
Sanitization replaces absolute working-directory paths with `@WORKSPACE@`,
replaces the system prompt and tool declarations with a minimal fixture prompt,
and removes provider-specific signatures and response identifiers. Entry IDs,
parent relationships, timestamps, metadata shape, and user/assistant messages
come from the actual predecessor-produced files.

The E2E renders the workspace placeholder into an isolated temporary store,
resumes with real Pi, checks the saved reply across two server starts, and
requires metadata bytes to remain unchanged. This check makes no model calls.
