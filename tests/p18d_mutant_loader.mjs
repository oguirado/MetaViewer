// Test-only source substitutions. Production files remain byte-for-byte intact.
import fs from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
const mutation = JSON.parse(process.env.P18D_MUTATION);
function replace(source) {
  const text = String(source);
  if (text.split(mutation.before).length !== 2) throw Error('MUTATION_ANCHOR_NOT_UNIQUE');
  return text.replace(mutation.before, mutation.after);
}
if (mutation.path.endsWith('.vue')) {
  const original = fs.readFileSync;
  fs.readFileSync = function(path, ...args) {
    const result = original.call(this, path, ...args);
    const name = path instanceof URL ? fileURLToPath(path) : String(path);
    return name === mutation.path ? replace(result) : result;
  };
  syncBuiltinESMExports();
} else {
  registerHooks({load(url, context, next) {
    const result = next(url, context);
    if (url.startsWith('file:') && fileURLToPath(url) === mutation.path)
      return {...result, source:replace(result.source)};
    return result;
  }});
}
