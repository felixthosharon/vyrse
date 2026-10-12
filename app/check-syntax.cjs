// Run: node check-syntax.js src/components/SettingsPanel.tsx
const ts = require("typescript");
const fs = require("fs");
const file = process.argv[2];
const text = fs.readFileSync(file, "utf8");
const result = ts.transpileModule(text, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  fileName: file,
  reportDiagnostics: true
});
if (result.diagnostics && result.diagnostics.length > 0) {
  console.log(`${result.diagnostics.length} syntax error(s):\n`);
  for (const d of result.diagnostics) {
    const pos = d.file.getLineAndCharacterOfPosition(d.start);
    console.log(`  line ${pos.line + 1}, col ${pos.character + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
  }
} else {
  console.log("No syntax errors — file parses cleanly.");
}