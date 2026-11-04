import test from 'node:test';
import assert from 'node:assert/strict';
import { inline, markdown, splitFrontmatter } from '../src/lib/upstream/markdown.js';
import { formatMarkdown } from '../src/lib/editor-commands.mjs';

test('preview renders basic and nested emphasis without treating unmatched markers as markup', () => {
  for (const [source, expected] of [
    ['*italic*', '<em>italic</em>'],
    ['**bold**', '<strong>bold</strong>'],
    ['***both***', '<strong><em>both</em></strong>'],
    ['**bold *inside***', '<strong>bold <em>inside</em></strong>'],
    ['*italic **inside***', '<em>italic <strong>inside</strong></em>'],
    ['*open', '*open'], ['**open', '**open'], ['* spaced *', '* spaced *'],
    ['\\*literal*', '\\*literal*'],
  ]) assert.equal(inline(source).text, expected, source);
});

test('preview uses matching-length code runs and never interprets Markdown inside code', () => {
  assert.equal(inline('`**literal**`').text, '<code>**literal**</code>');
  assert.equal(inline('`` use `x` ``').text, '<code>use `x`</code>');
  assert.equal(inline('`not closed``').text, '`not closed``');
  assert.equal(inline('`<script>x</script>`').text, '<code>&lt;script&gt;x&lt;/script&gt;</code>');
});

test('toolbar output previews its heading, lists, emphasis, quote, and code faithfully', () => {
  for (const [command, tag] of [['heading', 'h2'], ['bold', 'strong'], ['italic', 'em'], ['bullet', 'ul'], ['number', 'ol'], ['quote', 'blockquote'], ['code', 'code']]) {
    const formatted = formatMarkdown('Keep the backup.', 0, 16, command);
    const rendered = markdown(formatted.content).text;
    assert.ok(rendered.includes(`<${tag}>`), `${command}: ${rendered}`);
    assert.ok(rendered.includes('Keep the backup.'));
  }
  assert.match(markdown('> First\n>\n> - one\n> - two\n\nAfter').text, /<blockquote>.*<p>First<\/p>.*<ul>.*<\/blockquote><p>After<\/p>/);
  assert.match(markdown('> outer\n> > inner').text, /<blockquote>.*<blockquote>.*inner/);
});

test('all new formatting preserves escaped HTML and the existing URL policy', () => {
  const rendered = markdown('> **<script>alert(1)</script>**\n> *<img src=x onerror=alert(1)>*\n> [bad](javascript:alert)\n> [bad](data:text/html,script)\n> [good](https://example.com/)').text;
  assert.ok(rendered.includes('&lt;script&gt;'));
  assert.ok(rendered.includes('&lt;img'));
  assert.ok(!/<script|<img|href="(?:javascript|data):/.test(rendered));
  assert.ok(rendered.includes('href="https://example.com/" target="_blank" rel="noopener noreferrer"'));
  assert.equal(inline('[[knowledge/example|<unsafe>]]', { bundle: 'personal' }).text, '<a href="#/asset?ref=personal%2F%2Fknowledge%2Fexample"><code>&lt;unsafe&gt;</code></a>');
});

test('preview does not mutate frontmatter or source bytes and retains indexed heading/link context', () => {
  const source = '---\r\ntitle: "Safe guide"\r\ncustom: [unchanged, metadata]\r\n---\r\n# Safe guide\r\n\r\n> *Read this*\r\n';
  const snapshot = source;
  const split = splitFrontmatter(source);
  const rendered = markdown(split.body, { startLine: split.startLine, headings: [{ line: 5, slug: 'safe-guide' }] }).text;
  assert.ok(rendered.includes('id="h-safe-guide"'));
  assert.ok(rendered.includes('<em>Read this</em>'));
  assert.equal(source, snapshot);
  assert.deepEqual(split.fields, [['title', '"Safe guide"'], ['custom', '[unchanged, metadata]']]);
});
