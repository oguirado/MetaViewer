#!/bin/sh
# Synthetic private-reaper evidence; delay terminal proof past the stop deadline.
read length
printf '2147483646 123\n'
while read control; do :; done
sleep 7
printf '2147483646\n'
