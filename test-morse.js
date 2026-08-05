import assert from 'assert';
import { textToMorse, morseToText } from './src/utils/morseEngine.js';

console.log('🧪 Running Morse Code Translator Unit Tests...');

try {
  // Test translation of simple letters
  assert.strictEqual(textToMorse('A'), '.-');
  assert.strictEqual(textToMorse('SOS'), '... --- ...');
  assert.strictEqual(textToMorse('Hello World'), '.... . .-.. .-.. --- / .-- --- .-. .-.. -..');
  
  // Test reverse translation
  assert.strictEqual(morseToText('.-'), 'A');
  assert.strictEqual(morseToText('... --- ...'), 'SOS');
  assert.strictEqual(morseToText('.... . .-.. .-.. --- / .-- --- .-. .-.. -..'), 'HELLO WORLD');
  
  // Test punctuation
  assert.strictEqual(textToMorse('?'), '..--..');
  assert.strictEqual(morseToText('..--..'), '?');
  
  // Test numeric
  assert.strictEqual(textToMorse('123'), '.---- ..--- ...--');
  assert.strictEqual(morseToText('.---- ..--- ...--'), '123');

  console.log('✅ All Morse Code Unit Tests Passed Successfully!');
} catch (error) {
  console.error('❌ Tests Failed:');
  console.error(error);
  process.exit(1);
}
