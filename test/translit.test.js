import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fold, latinToCyrillic, normalize } from '../docs/lib/translit.js';

/**
 * The shared module: `align` folds artist names to compare them with what
 * whisper heard, and #14 folds the same names in the browser. Both sides have
 * to agree, so what is pinned here is the folded form, not the rule that
 * produced it.
 */
const MODULE_PATH = join(import.meta.dirname, '..', 'docs', 'lib', 'translit.js');

test('normalize lowercases, drops punctuation and folds ё to е', () => {
  assert.equal(normalize('The Beatles'), 'the beatles');
  assert.equal(normalize('«Ёжик»'), 'ежик');
  assert.equal(normalize('  Депеш   Мод  '), 'депеш мод');
});

test('latinToCyrillic transliterates a latin run and leaves cyrillic alone', () => {
  assert.equal(latinToCyrillic('portishead'), 'портисхед');
  assert.equal(latinToCyrillic('битлз'), 'битлз');
});

test('fold brings the latin spelling and the one whisper heard to one string', () => {
  assert.equal(fold('Portishead'), 'портисхед');
  assert.equal(fold('Портисхед'), fold('Portishead'), 'the whole point of the module');
});

test('punctuation and case never change the folded form', () => {
  assert.equal(fold('«Ёж», ёлка!'), fold('еж елка'));
  assert.equal(fold('PORTISHEAD'), fold('Portishead'));
});

test('fold strips diacritics before transliterating', () => {
  assert.equal(fold('Brücken'), fold('Brucken'));
  assert.match(fold('Brücken'), /^[а-я ]+$/, 'nothing latin survives a fold');
});

test('fold is idempotent, so a folded form can be folded again', () => {
  for (const text of ['Portishead', '«Ёжик» в тумане!', 'Аквариум', 'Brücken']) {
    assert.equal(fold(fold(text)), fold(text), text);
  }
});

test('the shared module is DOM-free and imports nothing', () => {
  const source = readFileSync(MODULE_PATH, 'utf8');
  assert.ok(!/^\s*import\s/m.test(source), 'docs/lib is loaded by the browser and by node:test');
  assert.ok(!/\b(document|window|navigator)\b/.test(source), 'no DOM in a module the CLI imports');
});
