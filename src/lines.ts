// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

/**
 * Where lines start in a text, to find an offset's line without reading the text from its start
 * each time: a pull request controls how long the text is, and how many offsets there are.
 */

/** The offset each line starts at, in order: 0, then just after each line break. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

/** The line, counted from 0, that `offset` is on, given the text's lineStarts. */
export function lineIndex(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}
