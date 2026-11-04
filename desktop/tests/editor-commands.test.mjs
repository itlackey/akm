import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMarkdown } from '../src/lib/editor-commands.mjs';

test('inline formatting wraps only the selection and toggles without rewriting metadata', () => {
  const content = '---\ntitle: Guide\n---\n\nKeep this safe.\n';
  const from = content.indexOf('this');
  const bold = formatMarkdown(content, from, from + 4, 'bold');
  assert.equal(bold.content, content.replace('this', '**this**'));
  assert.equal(bold.content.slice(bold.start, bold.end), 'this');
  assert.equal(formatMarkdown(bold.content, bold.start, bold.end, 'bold').content, content);
  assert.equal(formatMarkdown('  word  ', 0, 8, 'italic').content, '  *word*  ');
});

test('empty inline selection inserts a selected placeholder and link selects its destination', () => {
  const result = formatMarkdown('Keep ', 5, 5, 'bold');
  assert.equal(result.content, 'Keep **bold text**');
  assert.equal(result.content.slice(result.start, result.end), 'bold text');
  const link = formatMarkdown('guide', 0, 5, 'link');
  assert.equal(link.content, '[guide](https://)');
  assert.equal(link.content.slice(link.start, link.end), 'https://');
});

test('line operations affect selected lines only, preserve trailing newline, and toggle', () => {
  const content = '# Title\n\nfirst\nsecond\nuntouched\n';
  const from = content.indexOf('first'), to = content.indexOf('untouched');
  const bullets = formatMarkdown(content, from + 2, to, 'bullet');
  assert.equal(bullets.content, '# Title\n\n- first\n- second\nuntouched\n');
  assert.equal(formatMarkdown(bullets.content, bullets.start, bullets.end, 'bullet').content, content);
  assert.equal(formatMarkdown('a\nb', 0, 3, 'number').content, '1. a\n2. b');
  assert.equal(formatMarkdown('- a\n- b', 0, 7, 'number').content, '1. a\n2. b');
  assert.equal(formatMarkdown('hello', 0, 0, 'heading').content, '## hello');
  assert.equal(formatMarkdown('hello', 0, 0, 'quote').content, '> hello');
  assert.equal(formatMarkdown('\nsecond', 0, 0, 'quote').content, '> \nsecond');
});

test('code delimiters accommodate existing backticks and multiline selections', () => {
  const inline = formatMarkdown('use `x`', 0, 7, 'code');
  assert.equal(inline.content, '`` use `x` ``');
  const block = formatMarkdown('a\n```b```', 0, 9, 'code');
  assert.equal(block.content, '````\na\n```b```\n````');
  assert.equal(block.content.slice(block.start, block.end), 'a\n```b```');
});
