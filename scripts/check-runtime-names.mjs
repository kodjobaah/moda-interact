import process from "node:process";
import { readdir, readFile, lstat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const labels = /(?:arch[-_]?\d{3}|(?:shopify|database|admin|background|api|shared|gateway|messaging|commerce|woocommerce|system[-_]test)[-_]\d{3})/i;
const sourceExtension = /\.(?:[cm]?[jt]sx?|json|css|scss|html|liquid|toml|ya?ml|sh)$/i;
const excludedDirectory = /^(?:node_modules|\.git|\.react-router|build|dist|coverage|tests?|fixtures?|docs?|migrations|__tests__|__fixtures__)$/i;
const secretFile = /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx)|(?:.*[._-])?(?:secrets?|credentials|keyring)\.json)$/i;
const files = new Map();

async function collect(path, role, recursive = false) {
  // Also check parent components of literal production-command paths.
  let parent = root;
  for (const component of relative(root, path).split("/").slice(0, -1)) {
    parent = join(parent, component);
    try { if ((await lstat(parent)).isSymbolicLink()) return; }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
  }
  let stat;
  try { stat = await lstat(path); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  // Do not follow even repository-local symlinks: a target can change after inspection.
  if (stat.isSymbolicLink() || secretFile.test(path.split("/").at(-1))) return;
  if (stat.isDirectory()) {
    if (!recursive) return;
    for (const entry of (await readdir(path)).sort()) {
      if (!excludedDirectory.test(entry)) await collect(join(path, entry), role, true);
    }
  } else if (stat.isFile() && (sourceExtension.test(path) || /(?:^|\/)(?:Dockerfile(?:\.[^/]+)?|Procfile)$/.test(path))) {
    files.set(path, role);
  }
}

await collect(join(root, "app"), "application", true);
// Actual entry/build/Shopify configuration and Docker deployment surfaces.
for (const name of (await readdir(root)).sort()) {
  if (/^(?:observability\.[cm]?js|(?:react-router|vite)\.config\.[cm]?[jt]s|shopify\.(?:web|app(?:\.[^.]+)?)\.toml|Dockerfile(?:\.[^.]+)?|render\.ya?ml|fly\.toml|Procfile)$/.test(name)) {
    await collect(join(root, name), "production-entry/configuration");
  }
}
for (const name of ["deploy", "deployment", ".github/workflows"]) await collect(join(root, name), "deployment", true);

const manifestPath = join(root, "package.json");
if ((await lstat(manifestPath)).isSymbolicLink()) throw new Error("Production manifest must be a repository file.");
const manifestText = await readFile(manifestPath, "utf8");
const manifest = JSON.parse(manifestText);
const manifestLine = key => Math.max(1, manifestText.split(/\r?\n/).findIndex(line => line.trimStart().startsWith(`${JSON.stringify(key)}:`)) + 1);
const runtimeScripts = Object.entries(manifest.scripts ?? {}).filter(([name]) =>
  /^(?:start|build|migrate|seed|deploy|prisma:(?:generate|migrate:deploy|seed))$/.test(name));
// Follow literal local executable references in production commands (no evaluation).
for (const [, command] of runtimeScripts) {
  for (const match of command.matchAll(/(?:^|\s)(?:\.\/)?((?:scripts|deploy|deployment)\/[\w./-]+\.(?:[cm]?[jt]s|sh))(?=\s|$)/g)) {
    if (!match[1].split("/").includes("..")) await collect(join(root, match[1]), "production-command");
  }
}

let failures = 0;
function check(path, text, role) {
  const file = relative(root, path);
  if (labels.test(file)) { console.error(`${file}:1: filename (${role})`); failures++; }
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (labels.test(line)) { console.error(`${file}:${index + 1}: content (${role})`); failures++; }
  }
}
for (const [path, role] of [...files].sort(([left], [right]) => left.localeCompare(right, "en"))) {
  check(path, await readFile(path, "utf8"), role);
  if (process.argv.includes("--list")) console.log(`${relative(root, path)} (${role})`);
}
// Tests/validation commands retain task traceability, so inspect only production manifest values.
for (const [name, command] of runtimeScripts) {
  if (labels.test(name) || labels.test(command)) {
    console.error(`package.json:${manifestLine(name)}: production-script (${name})`); failures++;
  }
}
for (const key of ["main", "module", "exports", "bin"]) {
  if (manifest[key] !== undefined) check(manifestPath, JSON.stringify(manifest[key]), `production-${key}`);
}
console.log(`Runtime naming check: ${files.size} files + production manifest values; ${failures} violations; 0 exceptions.`);
process.exitCode = failures ? 1 : 0;
