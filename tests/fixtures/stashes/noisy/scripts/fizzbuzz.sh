#!/usr/bin/env bash
# FizzBuzz from 1 to 100 - pure noise.
for i in $(seq 1 100); do
  if (( i % 15 == 0 )); then echo Fizzbuzz
  elif (( i % 3 == 0 )); then echo Fizz
  elif (( i % 5 == 0 )); then echo Buzz
  else echo "$i"
  fi
done
