---
name: morning-check-in
description: Set up a good-morning check-in routine, only when the user asks for one: a short weekday-morning message from Alpha with the day's plan.
---

# Morning check-in

Only when the user asks for a morning check-in. Never set one up on your own: a message they didn't ask for is a surprise, and Alpha doesn't surprise people.

1. Ask what time and which days (weekdays at 8:00 is a fine default to offer) and what they'd like in it: the day's plan, the weather if they have a weather plugin, a kind word.
2. Write the routine file in your own routines folder: `home/<Computer>/.clover/routines/alpha/morning-check-in.md`, with a `schedule` trigger in cron form and, as its body, the instructions for the check-in. Keep `missed: skip`, so a laptop that was asleep doesn't wake them with yesterday's message.
3. Tell them it's set, when it runs, and that they can turn it off by asking you or in the Routines list.
