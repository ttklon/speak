#!/usr/bin/env node
/** Проверить содержимое настоящей Windows-сборки, а не node_modules проекта. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');

const resources = path.resolve(process.argv[2] || 'release/win-unpacked/resources');
const archive = path.join(resources, 'app.asar');
assert.ok(fs.existsSync(archive), `нет архива приложения: ${archive}`);
const files = asar.listPackage(archive).map((name) => name.replace(/\\/g, '/'));
for (const name of [
  '/node_modules/onnxruntime-node/package.json',
  '/node_modules/onnxruntime-node/dist/index.js',
  '/node_modules/onnxruntime-common/package.json',
  '/node_modules/onnxruntime-common/dist/cjs/index.js',
]) {
  assert.ok(files.includes(name), `в app.asar отсутствует ${name}`);
  console.log(`В сборке: ${name}`);
}
const nativeDir = path.join(resources, 'app.asar.unpacked', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6', 'win32', 'x64');
assert.ok(fs.existsSync(path.join(nativeDir, 'onnxruntime_binding.node')), 'в сборке отсутствует Windows ONNX native binding');
console.log('В сборке: Windows x64 ONNX native binding');
