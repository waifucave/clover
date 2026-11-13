#!/bin/sh
# The acceptance-points fixture's child's hook: notes each event it is run for in its own data folder, and changes nothing.
input=$(cat)
event=$(printf '%s' "$input" | tr ',' '\n' | sed -n 's/^.*"event":"\([^"]*\)".*$/\1/p' | head -n 1)
printf '%s\n' "$event" >> "$CLOVER_PLUGIN_DATA/events.txt"
exit 0
