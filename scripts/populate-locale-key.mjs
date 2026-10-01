#!/usr/bin/env node

/**
 * =============================================================================
 * populate-locale-key.mjs
 * =============================================================================
 *
 * Safely adds or updates ONE flat translation key across every JSON locale file
 * in:
 *
 *   <project-root>/app/i18n/locales
 *
 * The script is expected to live here:
 *
 *   <project-root>/scripts/populate-locale-key.mjs
 *
 * For this project:
 *
 *   /Users/kwadwoadomafriyie/project/moda-interact-workspace/moda-interact
 *
 *
 * =============================================================================
 * IMPORTANT DESIGN
 * =============================================================================
 *
 * Locale keys remain FLAT:
 *
 *   "billingPurchases.historicalNotRefundable": "Translation"
 *
 * They are NOT converted to:
 *
 *   {
 *     "billingPurchases": {
 *       "historicalNotRefundable": "Translation"
 *     }
 *   }
 *
 *
 * =============================================================================
 * SAFETY GUARANTEES
 * =============================================================================
 *
 * Before changing ANY file, the script checks ALL locale files.
 *
 * It verifies:
 *
 *   1. Every locale JSON file is valid JSON.
 *
 *   2. No locale JSON file contains duplicate top-level keys.
 *
 *   3. The translations values file contains no duplicate locale names.
 *
 *   4. Every existing locale has a supplied translation.
 *
 *   5. The values file does not contain unknown locales.
 *
 *   6. Every translation is a non-empty string.
 *
 *   7. Leading/trailing whitespace in translations is rejected.
 *
 *      For example this FAILS:
 *
 *        "en": " These credits remain usable..."
 *
 *   8. If --after is used, that anchor key must exist in every locale
 *      where the target key does not already exist.
 *
 *   9. Existing target:
 *
 *        same value
 *          -> UNCHANGED
 *
 *        different value, without --force
 *          -> ABORT ENTIRE OPERATION
 *
 *        different value, with --force
 *          -> replace ONLY the target value IN PLACE
 *
 *  10. Existing unrelated translation lines are NOT regenerated.
 *
 *      This is important.
 *
 *      For example, updating:
 *
 *        billingPurchases.historicalNotRefundable
 *
 *      cannot rewrite:
 *
 *        billingPurchases.completedCopy
 *
 *      because this script performs a surgical text replacement rather
 *      than JSON.parse() -> JSON.stringify() on the entire locale file.
 *
 *
 * =============================================================================
 * RECOMMENDED DIRECTORY STRUCTURE
 * =============================================================================
 *
 *   moda-interact/
 *   ├── app/
 *   │   └── i18n/
 *   │       └── locales/
 *   │           ├── cs.json
 *   │           ├── da.json
 *   │           ├── de.json
 *   │           ├── en.json
 *   │           ├── ...
 *   │           └── zh-Hant.json
 *   │
 *   └── scripts/
 *       ├── populate-locale-key.mjs
 *       │
 *       └── locale-values/
 *           └── historical-not-refundable.json
 *
 *
 * =============================================================================
 * VALUES FILE FORMAT
 * =============================================================================
 *
 * Example:
 *
 *   scripts/locale-values/historical-not-refundable.json
 *
 * {
 *   "cs": "Czech translation",
 *   "da": "Danish translation",
 *   "de": "German translation",
 *   "en": "These credits remain usable, but this purchase is no longer refundable under the current subscription.",
 *   "es": "Spanish translation",
 *   "fi": "Finnish translation",
 *   "fr": "French translation",
 *   "it": "Italian translation",
 *   "ja": "Japanese translation",
 *   "ko": "Korean translation",
 *   "nb": "Norwegian translation",
 *   "nl": "Dutch translation",
 *   "pl": "Polish translation",
 *   "pt-BR": "Brazilian Portuguese translation",
 *   "pt-PT": "European Portuguese translation",
 *   "sv": "Swedish translation",
 *   "th": "Thai translation",
 *   "tr": "Turkish translation",
 *   "zh-Hans": "Simplified Chinese translation",
 *   "zh-Hant": "Traditional Chinese translation"
 * }
 *
 *
 * =============================================================================
 * USAGE
 * =============================================================================
 *
 * From the project root:
 *
 *   cd /Users/kwadwoadomafriyie/project/moda-interact-workspace/moda-interact
 *
 *
 * STEP 1 — CHECK ONLY
 * -------------------
 *
 * ALWAYS run this first:
 *
 *   node scripts/populate-locale-key.mjs \
 *     --key billingPurchases.historicalNotRefundable \
 *     --values scripts/locale-values/historical-not-refundable.json \
 *     --after billingPurchases.noAvailableCredits \
 *     --check
 *
 *
 * STEP 2 — APPLY
 * --------------
 *
 * If the check passes:
 *
 *   node scripts/populate-locale-key.mjs \
 *     --key billingPurchases.historicalNotRefundable \
 *     --values scripts/locale-values/historical-not-refundable.json \
 *     --after billingPurchases.noAvailableCredits
 *
 *
 * REPLACING EXISTING VALUES
 * -------------------------
 *
 * If the key already exists but the translations are intentionally changing:
 *
 * First:
 *
 *   node scripts/populate-locale-key.mjs \
 *     --key billingPurchases.historicalNotRefundable \
 *     --values scripts/locale-values/historical-not-refundable.json \
 *     --force \
 *     --check
 *
 * Then:
 *
 *   node scripts/populate-locale-key.mjs \
 *     --key billingPurchases.historicalNotRefundable \
 *     --values scripts/locale-values/historical-not-refundable.json \
 *     --force
 *
 *
 * NOTE:
 *
 * When the target key already exists, --after is ignored for that target.
 *
 * The key stays where it already is and ONLY its value is changed.
 *
 *
 * =============================================================================
 * COMMAND OPTIONS
 * =============================================================================
 *
 * --key <key>
 *
 *   Required.
 *
 *   Example:
 *
 *     --key billingPurchases.historicalNotRefundable
 *
 *
 * --values <file>
 *
 *   Required.
 *
 *   Example:
 *
 *     --values scripts/locale-values/historical-not-refundable.json
 *
 *
 * --after <key>
 *
 *   Optional.
 *
 *   Used ONLY when adding a target key that does not currently exist.
 *
 *   Example:
 *
 *     --after billingPurchases.noAvailableCredits
 *
 *
 * --force
 *
 *   Allow an existing target value to be replaced.
 *
 *   The target remains in its existing location.
 *
 *
 * --check
 *
 *   Run all validation and show what WOULD happen without modifying files.
 *
 *
 * --help
 *
 *   Display abbreviated instructions.
 *
 *
 * =============================================================================
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * =============================================================================
 * PATHS
 * =============================================================================
 */

const scriptFile = fileURLToPath(import.meta.url);
const scriptsDirectory = path.dirname(scriptFile);

const projectRoot = path.resolve(
  scriptsDirectory,
  "..",
);

const localesDirectory = path.join(
  projectRoot,
  "app",
  "i18n",
  "locales",
);

/**
 * =============================================================================
 * COMMAND-LINE HELPERS
 * =============================================================================
 */

const args = process.argv.slice(2);

function hasFlag(name) {
  return args.includes(name);
}

function getArgument(name) {
  const index = args.indexOf(name);

  if (index === -1) {
    return undefined;
  }

  const value = args[index + 1];

  if (
    value === undefined ||
    value.startsWith("--")
  ) {
    throw new Error(
      `Argument "${name}" requires a value.`,
    );
  }

  return value;
}

function printHelp() {
  console.log(`
Populate one flat i18n translation key across every locale.

Usage:

  node scripts/populate-locale-key.mjs \\
    --key <translation-key> \\
    --values <translations.json> \\
    [--after <existing-key>] \\
    [--force] \\
    [--check]

Example:

  node scripts/populate-locale-key.mjs \\
    --key billingPurchases.historicalNotRefundable \\
    --values scripts/locale-values/historical-not-refundable.json \\
    --after billingPurchases.noAvailableCredits \\
    --check

Options:

  --key       Translation key.
  --values    JSON object containing one value per locale.
  --after     Insert a NEW key after this key.
  --force     Replace an existing different target value.
  --check     Validate and preview without writing anything.
  --help      Show this help.
`);
}

/**
 * =============================================================================
 * GENERAL HELPERS
 * =============================================================================
 */

function parseJson(source, description) {
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(
      `${description} is not valid JSON:\n\n${error.message}`,
    );
  }
}

function assertPlainObject(value, description) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error(
      `${description} must contain a JSON object at the top level.`,
    );
  }
}

/**
 * Escape text before putting it inside a RegExp.
 */
function escapeRegExp(value) {
  return value.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
}

/**
 * =============================================================================
 * TOP-LEVEL JSON KEY SCANNER
 * =============================================================================
 *
 * JSON.parse silently accepts duplicate object keys.
 *
 * Example:
 *
 * {
 *   "hello": "one",
 *   "hello": "two"
 * }
 *
 * JSON.parse gives:
 *
 * {
 *   hello: "two"
 * }
 *
 * That is unsafe for translation files, so we inspect raw JSON first.
 *
 * This scanner returns all top-level keys.
 */

function getTopLevelKeys(source) {
  const keys = [];

  let depth = 0;
  let inString = false;
  let escaped = false;
  let stringStart = -1;

  for (
    let index = 0;
    index < source.length;
    index++
  ) {
    const character = source[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (character === "\\") {
        escaped = true;
        continue;
      }

      if (character === '"') {
        inString = false;

        if (depth === 1) {
          let nextIndex = index + 1;

          while (
            nextIndex < source.length &&
            /\s/.test(source[nextIndex])
          ) {
            nextIndex++;
          }

          if (source[nextIndex] === ":") {
            const rawKey = source.slice(
              stringStart,
              index + 1,
            );

            keys.push(
              JSON.parse(rawKey),
            );
          }
        }

        continue;
      }

      continue;
    }

    if (character === '"') {
      inString = true;
      stringStart = index;
      continue;
    }

    if (character === "{") {
      depth++;
      continue;
    }

    if (character === "}") {
      depth--;
    }
  }

  return keys;
}

function findDuplicateTopLevelKeys(source) {
  const counts = new Map();

  for (const key of getTopLevelKeys(source)) {
    counts.set(
      key,
      (counts.get(key) ?? 0) + 1,
    );
  }

  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key, count]) => ({
      key,
      count,
    }));
}

/**
 * =============================================================================
 * TARGET-LINE HELPERS
 * =============================================================================
 *
 * Locale translation values are expected to be JSON strings.
 *
 * A line looks like:
 *
 *   "some.key": "Some translated value",
 *
 * JSON strings cannot contain literal newline characters, so the complete
 * translation entry is expected on one physical line.
 */

/**
 * Find exactly one line containing a specified top-level translation key.
 *
 * Returns:
 *
 * {
 *   line,
 *   lineIndex,
 *   indentation,
 *   value
 * }
 *
 * or null if the key does not exist.
 */
function findTranslationLine(
  source,
  translationKey,
) {
  const escapedKey =
    escapeRegExp(translationKey);

  /**
   * JSON string literal:
   *
   * "(?:\\.|[^"\\])*"
   */
  const pattern = new RegExp(
    `^(\\s*)"${escapedKey}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")\\s*,?\\s*$`,
  );

  const lines = source.split(/\r?\n/);

  const matches = [];

  for (
    let lineIndex = 0;
    lineIndex < lines.length;
    lineIndex++
  ) {
    const line = lines[lineIndex];

    const match = line.match(pattern);

    if (!match) {
      continue;
    }

    matches.push({
      line,
      lineIndex,
      indentation: match[1],
      rawValue: match[2],
      value: JSON.parse(match[2]),
    });
  }

  if (matches.length === 0) {
    return null;
  }

  if (matches.length > 1) {
    throw new Error(
      `Internal safety check failed: "${translationKey}" ` +
        `appears on more than one line.`,
    );
  }

  return matches[0];
}

/**
 * Replace ONLY the JSON string value belonging to one translation key.
 *
 * Everything else on the line is retained.
 */
function replaceTranslationValue(
  source,
  translationKey,
  newValue,
) {
  const escapedKey =
    escapeRegExp(translationKey);

  const encodedValue =
    JSON.stringify(newValue);

  const pattern = new RegExp(
    `^(\\s*"${escapedKey}"\\s*:\\s*)("(?:\\\\.|[^"\\\\])*")(\\s*,?\\s*)$`,
    "m",
  );

  let replacements = 0;

  const output = source.replace(
    pattern,
    (
      fullMatch,
      prefix,
      oldEncodedValue,
      suffix,
    ) => {
      replacements++;

      return (
        prefix +
        encodedValue +
        suffix
      );
    },
  );

  if (replacements !== 1) {
    throw new Error(
      `Expected to replace exactly one occurrence of "${translationKey}", ` +
        `but replaced ${replacements}.`,
    );
  }

  return output;
}

/**
 * Insert a NEW translation immediately after an anchor key.
 *
 * The existing anchor line remains completely unchanged.
 */
function insertTranslationAfter(
  source,
  afterKey,
  newKey,
  newValue,
) {
  const newline = source.includes("\r\n")
    ? "\r\n"
    : "\n";

  const anchor = findTranslationLine(
    source,
    afterKey,
  );

  if (!anchor) {
    throw new Error(
      `Anchor key "${afterKey}" could not be found.`,
    );
  }

  const lines = source.split(/\r?\n/);

  /**
   * A new line inserted into the middle of a JSON object requires the
   * preceding entry to have a comma.
   *
   * Normally locale entries already do.
   *
   * If it doesn't, add one to the anchor line only.
   */
  let anchorLine =
    lines[anchor.lineIndex];

  if (!/,\s*$/.test(anchorLine)) {
    anchorLine =
      anchorLine.replace(
        /\s*$/,
        ",",
      );

    lines[anchor.lineIndex] =
      anchorLine;
  }

  const newLine =
    `${anchor.indentation}` +
    `${JSON.stringify(newKey)}: ` +
    `${JSON.stringify(newValue)},`;

  lines.splice(
    anchor.lineIndex + 1,
    0,
    newLine,
  );

  return lines.join(newline);
}

/**
 * Append a new translation before the final top-level closing brace.
 *
 * This is used when --after is not supplied.
 */
function appendTranslation(
  source,
  newKey,
  newValue,
) {
  const newline = source.includes("\r\n")
    ? "\r\n"
    : "\n";

  const lines = source.split(/\r?\n/);

  /**
   * Find the final closing brace.
   */
  let closingBraceIndex = -1;

  for (
    let index = lines.length - 1;
    index >= 0;
    index--
  ) {
    if (lines[index].trim() === "}") {
      closingBraceIndex = index;
      break;
    }
  }

  if (closingBraceIndex === -1) {
    throw new Error(
      "Could not find the closing top-level JSON brace.",
    );
  }

  /**
   * Find the previous non-empty line.
   */
  let previousIndex =
    closingBraceIndex - 1;

  while (
    previousIndex >= 0 &&
    lines[previousIndex].trim() === ""
  ) {
    previousIndex--;
  }

  if (previousIndex < 0) {
    throw new Error(
      "Locale file has an unexpected structure.",
    );
  }

  /**
   * Derive indentation from the previous property.
   */
  const indentationMatch =
    lines[previousIndex].match(/^(\s*)/);

  const indentation =
    indentationMatch?.[1] ?? "  ";

  /**
   * Add a comma to the existing final property if necessary.
   */
  if (
    !/,\s*$/.test(
      lines[previousIndex],
    )
  ) {
    lines[previousIndex] =
      lines[previousIndex].replace(
        /\s*$/,
        ",",
      );
  }

  const newLine =
    `${indentation}` +
    `${JSON.stringify(newKey)}: ` +
    `${JSON.stringify(newValue)}`;

  lines.splice(
    closingBraceIndex,
    0,
    newLine,
  );

  return lines.join(newline);
}

/**
 * =============================================================================
 * MAIN
 * =============================================================================
 */

async function main() {
  if (hasFlag("--help")) {
    printHelp();
    return;
  }

  const translationKey =
    getArgument("--key");

  const valuesArgument =
    getArgument("--values");

  const afterKey =
    getArgument("--after");

  const force =
    hasFlag("--force");

  const checkOnly =
    hasFlag("--check");

  if (!translationKey) {
    throw new Error(
      'Missing required argument "--key".\n\n' +
        "Run with --help for usage instructions.",
    );
  }

  if (!valuesArgument) {
    throw new Error(
      'Missing required argument "--values".\n\n' +
        "Run with --help for usage instructions.",
    );
  }

  if (
    afterKey &&
    afterKey === translationKey
  ) {
    throw new Error(
      "--after cannot be the same key as --key.",
    );
  }

  const valuesFile = path.resolve(
    process.cwd(),
    valuesArgument,
  );

  console.log("");
  console.log(
    "=".repeat(78),
  );
  console.log(
    "LOCALE TRANSLATION POPULATOR",
  );
  console.log(
    "=".repeat(78),
  );
  console.log("");

  console.log(
    `Project root : ${projectRoot}`,
  );

  console.log(
    `Locales      : ${localesDirectory}`,
  );

  console.log(
    `Key          : ${translationKey}`,
  );

  console.log(
    `Values       : ${valuesFile}`,
  );

  console.log(
    `Insert after : ${afterKey ?? "(append when new)"}`,
  );

  console.log(
    `Mode         : ${checkOnly ? "CHECK ONLY" : "WRITE"}`,
  );

  console.log(
    `Force        : ${force ? "YES" : "NO"}`,
  );

  console.log("");

  /**
   * -------------------------------------------------------------------------
   * Validate locale directory
   * -------------------------------------------------------------------------
   */

  let localeDirectoryStat;

  try {
    localeDirectoryStat =
      await fs.stat(
        localesDirectory,
      );
  } catch {
    throw new Error(
      `Locale directory does not exist:\n\n${localesDirectory}`,
    );
  }

  if (!localeDirectoryStat.isDirectory()) {
    throw new Error(
      `Locale path is not a directory:\n\n${localesDirectory}`,
    );
  }

  /**
   * -------------------------------------------------------------------------
   * Load values file
   * -------------------------------------------------------------------------
   */

  let valuesSource;

  try {
    valuesSource =
      await fs.readFile(
        valuesFile,
        "utf8",
      );
  } catch (error) {
    throw new Error(
      `Unable to read translation values file:\n\n` +
        `${valuesFile}\n\n` +
        `${error.message}`,
    );
  }

  const duplicateValueLocales =
    findDuplicateTopLevelKeys(
      valuesSource,
    );

  if (
    duplicateValueLocales.length > 0
  ) {
    const details =
      duplicateValueLocales
        .map(
          ({ key, count }) =>
            `  - ${key}: ${count} occurrences`,
        )
        .join("\n");

    throw new Error(
      `Translation values file contains duplicate locale keys:\n\n` +
        `${details}\n\n` +
        `No locale files were changed.`,
    );
  }

  const translations =
    parseJson(
      valuesSource,
      "Translation values file",
    );

  assertPlainObject(
    translations,
    "Translation values file",
  );

  /**
   * -------------------------------------------------------------------------
   * Discover locale JSON files
   * -------------------------------------------------------------------------
   */

  const directoryEntries =
    await fs.readdir(
      localesDirectory,
      {
        withFileTypes: true,
      },
    );

  const localeFiles =
    directoryEntries
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith(".json"),
      )
      .map((entry) => {
        const locale =
          entry.name.slice(
            0,
            -".json".length,
          );

        return {
          locale,
          filename: entry.name,
          absolutePath: path.join(
            localesDirectory,
            entry.name,
          ),
        };
      })
      .sort(
        (left, right) =>
          left.locale.localeCompare(
            right.locale,
          ),
      );

  if (localeFiles.length === 0) {
    throw new Error(
      `No JSON locale files were found in:\n\n${localesDirectory}`,
    );
  }

  console.log(
    `Discovered ${localeFiles.length} locale files:`,
  );

  console.log(
    `  ${localeFiles
      .map(({ locale }) => locale)
      .join(", ")}`,
  );

  console.log("");

  /**
   * -------------------------------------------------------------------------
   * Translation coverage
   * -------------------------------------------------------------------------
   */

  const existingLocales =
    new Set(
      localeFiles.map(
        ({ locale }) => locale,
      ),
    );

  const missingLocales =
    localeFiles
      .map(({ locale }) => locale)
      .filter(
        (locale) =>
          !Object.hasOwn(
            translations,
            locale,
          ),
      );

  if (missingLocales.length > 0) {
    throw new Error(
      `Translations are missing for:\n\n` +
        missingLocales
          .map(
            (locale) =>
              `  - ${locale}`,
          )
          .join("\n") +
        `\n\nNo locale files were changed.`,
    );
  }

  const unknownLocales =
    Object.keys(translations)
      .filter(
        (locale) =>
          !existingLocales.has(
            locale,
          ),
      );

  if (unknownLocales.length > 0) {
    throw new Error(
      `The values file contains locales that do not exist:\n\n` +
        unknownLocales
          .map(
            (locale) =>
              `  - ${locale}`,
          )
          .join("\n") +
        `\n\nNo locale files were changed.`,
    );
  }

  /**
   * =========================================================================
   * PRE-FLIGHT
   * =========================================================================
   *
   * No writes happen in this loop.
   */

  const preparedFiles = [];

  for (
    const localeFile of localeFiles
  ) {
    const {
      locale,
      filename,
      absolutePath,
    } = localeFile;

    const translationValue =
      translations[locale];

    /**
     * Value must be a string.
     */
    if (
      typeof translationValue !==
      "string"
    ) {
      throw new Error(
        `Translation for "${locale}" must be a string.\n\n` +
          `No locale files were changed.`,
      );
    }

    /**
     * Empty strings are rejected.
     */
    if (
      translationValue.trim() === ""
    ) {
      throw new Error(
        `Translation for "${locale}" is empty.\n\n` +
          `No locale files were changed.`,
      );
    }

    /**
     * Leading/trailing whitespace is rejected.
     *
     * This catches:
     *
     *   " These credits..."
     *
     * before anything gets written.
     */
    if (
      translationValue !==
      translationValue.trim()
    ) {
      throw new Error(
        `Translation for "${locale}" contains leading or trailing whitespace.\n\n` +
          `Value:\n` +
          `  ${JSON.stringify(translationValue)}\n\n` +
          `Correct the values file and run the command again.\n\n` +
          `No locale files were changed.`,
      );
    }

    const source =
      await fs.readFile(
        absolutePath,
        "utf8",
      );

    /**
     * Detect duplicate keys BEFORE JSON.parse().
     */
    const duplicates =
      findDuplicateTopLevelKeys(
        source,
      );

    if (duplicates.length > 0) {
      const details =
        duplicates
          .map(
            ({ key, count }) =>
              `  - ${key}: ${count} occurrences`,
          )
          .join("\n");

      throw new Error(
        `${filename} contains duplicate translation keys:\n\n` +
          `${details}\n\n` +
          `No locale files were changed.`,
      );
    }

    /**
     * Also verify that the complete file is valid JSON.
     */
    const parsed =
      parseJson(
        source,
        filename,
      );

    assertPlainObject(
      parsed,
      filename,
    );

    const targetExists =
      Object.hasOwn(
        parsed,
        translationKey,
      );

    const existingValue =
      targetExists
        ? parsed[translationKey]
        : undefined;

    /**
     * Existing target must itself be a string.
     */
    if (
      targetExists &&
      typeof existingValue !== "string"
    ) {
      throw new Error(
        `${filename} contains "${translationKey}", but its value is not a string.\n\n` +
          `No locale files were changed.`,
      );
    }

    /**
     * Ensure our surgical text matcher can locate the target.
     */
    if (targetExists) {
      const targetLine =
        findTranslationLine(
          source,
          translationKey,
        );

      if (!targetLine) {
        throw new Error(
          `${filename} contains "${translationKey}" in JSON, ` +
            `but the script could not safely locate its translation line.\n\n` +
            `No locale files were changed.`,
        );
      }
    }

    /**
     * Existing different value requires --force.
     */
    if (
      targetExists &&
      existingValue !== translationValue &&
      !force
    ) {
      throw new Error(
        `${filename} already contains "${translationKey}" with a different value.\n\n` +
          `Existing:\n` +
          `  ${JSON.stringify(existingValue)}\n\n` +
          `Requested:\n` +
          `  ${JSON.stringify(translationValue)}\n\n` +
          `Use --force only if this replacement is intentional.\n\n` +
          `No locale files were changed.`,
      );
    }

    /**
     * --after matters only for NEW target keys.
     */
    if (
      !targetExists &&
      afterKey
    ) {
      if (
        !Object.hasOwn(
          parsed,
          afterKey,
        )
      ) {
        throw new Error(
          `${filename} does not contain anchor key:\n\n` +
            `  ${afterKey}\n\n` +
            `No locale files were changed.`,
        );
      }

      const anchorLine =
        findTranslationLine(
          source,
          afterKey,
        );

      if (!anchorLine) {
        throw new Error(
          `${filename} contains anchor "${afterKey}" in JSON, ` +
            `but the script could not safely locate its line.\n\n` +
            `No locale files were changed.`,
        );
      }
    }

    preparedFiles.push({
      ...localeFile,
      source,
      translationValue,
      targetExists,
      existingValue,
    });
  }

  /**
   * =========================================================================
   * PRE-FLIGHT PASSED
   * =========================================================================
   */

  console.log(
    "Pre-flight validation: PASS",
  );

  console.log(
    `Validated ${preparedFiles.length} locale files.`,
  );

  console.log(
    "Duplicate keys         : NONE",
  );

  console.log(
    "Missing translations   : NONE",
  );

  console.log(
    "Unknown locales        : NONE",
  );

  console.log(
    "Whitespace violations  : NONE",
  );

  console.log("");

  /**
   * Show exactly what WOULD happen.
   */
  let previewUpdated = 0;
  let previewAdded = 0;
  let previewUnchanged = 0;

  for (
    const prepared of preparedFiles
  ) {
    const {
      filename,
      locale,
      targetExists,
      existingValue,
      translationValue,
    } = prepared;

    if (
      targetExists &&
      existingValue === translationValue
    ) {
      console.log(
        `UNCHANGED  ${filename} (${locale})`,
      );

      previewUnchanged++;
      continue;
    }

    if (targetExists) {
      console.log(
        `REPLACE    ${filename} (${locale})`,
      );

      console.log(
        `           OLD: ${JSON.stringify(existingValue)}`,
      );

      console.log(
        `           NEW: ${JSON.stringify(translationValue)}`,
      );

      previewUpdated++;
      continue;
    }

    console.log(
      `ADD        ${filename} (${locale})`,
    );

    console.log(
      `           NEW: ${JSON.stringify(translationValue)}`,
    );

    previewAdded++;
  }

  console.log("");

  if (checkOnly) {
    console.log(
      "=".repeat(78),
    );

    console.log(
      "CHECK COMPLETE — NO FILES MODIFIED",
    );

    console.log(
      "=".repeat(78),
    );

    console.log(
      `Would replace : ${previewUpdated}`,
    );

    console.log(
      `Would add     : ${previewAdded}`,
    );

    console.log(
      `Unchanged     : ${previewUnchanged}`,
    );

    console.log(
      `Total         : ${preparedFiles.length}`,
    );

    console.log("");

    return;
  }

  /**
   * =========================================================================
   * WRITE PHASE
   * =========================================================================
   */

  let replacedCount = 0;
  let addedCount = 0;
  let unchangedCount = 0;

  for (
    const prepared of preparedFiles
  ) {
    const {
      filename,
      locale,
      absolutePath,
      source,
      translationValue,
      targetExists,
      existingValue,
    } = prepared;

    /**
     * Already correct.
     */
    if (
      targetExists &&
      existingValue === translationValue
    ) {
      console.log(
        `UNCHANGED  ${filename} (${locale})`,
      );

      unchangedCount++;
      continue;
    }

    let output;

    /**
     * Existing target:
     *
     * Replace ONLY that value.
     *
     * The key does NOT move.
     *
     * No unrelated translation line is regenerated.
     */
    if (targetExists) {
      output =
        replaceTranslationValue(
          source,
          translationKey,
          translationValue,
        );

      console.log(
        `REPLACED   ${filename} (${locale})`,
      );

      console.log(
        `           OLD: ${JSON.stringify(existingValue)}`,
      );

      console.log(
        `           NEW: ${JSON.stringify(translationValue)}`,
      );

      replacedCount++;
    }

    /**
     * New target with --after.
     */
    else if (afterKey) {
      output =
        insertTranslationAfter(
          source,
          afterKey,
          translationKey,
          translationValue,
        );

      console.log(
        `ADDED      ${filename} (${locale})`,
      );

      console.log(
        `           AFTER: ${afterKey}`,
      );

      console.log(
        `           VALUE: ${JSON.stringify(translationValue)}`,
      );

      addedCount++;
    }

    /**
     * New target without --after:
     *
     * append before closing brace.
     */
    else {
      output =
        appendTranslation(
          source,
          translationKey,
          translationValue,
        );

      console.log(
        `ADDED      ${filename} (${locale})`,
      );

      console.log(
        `           VALUE: ${JSON.stringify(translationValue)}`,
      );

      addedCount++;
    }

    /**
     * Final safety check BEFORE writing.
     *
     * Confirm resulting text is valid JSON and contains exactly the value
     * requested.
     */
    const outputParsed =
      parseJson(
        output,
        `${filename} after modification`,
      );

    if (
      outputParsed[
        translationKey
      ] !== translationValue
    ) {
      throw new Error(
        `Safety verification failed for ${filename}.\n\n` +
          `No further files will be written.`,
      );
    }

    /**
     * Ensure we have not accidentally introduced duplicate keys.
     */
    const outputDuplicates =
      findDuplicateTopLevelKeys(
        output,
      );

    if (
      outputDuplicates.length > 0
    ) {
      throw new Error(
        `Safety verification detected duplicate keys in ${filename}.\n\n` +
          `The file was NOT written.`,
      );
    }

    /**
     * Write only after validation of the generated result.
     */
    await fs.writeFile(
      absolutePath,
      output,
      "utf8",
    );
  }

  console.log("");
  console.log(
    "=".repeat(78),
  );

  console.log(
    "COMPLETE",
  );

  console.log(
    "=".repeat(78),
  );

  console.log(
    `Key       : ${translationKey}`,
  );

  console.log(
    `Replaced  : ${replacedCount}`,
  );

  console.log(
    `Added     : ${addedCount}`,
  );

  console.log(
    `Unchanged : ${unchangedCount}`,
  );

  console.log(
    `Total     : ${preparedFiles.length}`,
  );

  console.log("");
}

/**
 * =============================================================================
 * TOP-LEVEL ERROR HANDLING
 * =============================================================================
 */

main().catch((error) => {
  console.error("");
  console.error(
    "=".repeat(78),
  );
  console.error(
    "FAILED",
  );
  console.error(
    "=".repeat(78),
  );
  console.error("");
  console.error(
    error.message,
  );
  console.error("");

  process.exitCode = 1;
});
