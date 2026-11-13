#!/bin/sh
# The acceptance-points fixture's child's hook: notes each event it is run for in its tree's data folder
# (`$CLOVER_PLUGIN_DATA`, the top plugin's), and changes nothing. A write it can't make is said on stderr.
input=$(cat)
event=$(printf '%s' "$input" | tr ',' '\n' | sed -n 's/^.*"event":"\([^"]*\)".*$/\1/p' | head -n 1)
printf '%s\n' "$event" >> "$CLOVER_PLUGIN_DATA/events.txt" || echo "events.sh: couldn't write $CLOVER_PLUGIN_DATA/events.txt" >&2
exit 0
