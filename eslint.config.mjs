// ESLint 9 flat config for VYRO.
//
// eslint-config-next@15.5 ships the classic eslintrc format (module.exports
// with `extends`), so the FlatCompat adapter translates it into flat-config
// entries. Node's ESM loader requires the explicit ".js" extension for the
// extensionless subpath -- that is the whole reason for the adapter instead
// of a direct import.
import { FlatCompat } from "@eslint/eslintrc";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

/** @type {import("eslint").Linter.Config[]} */
const eslintConfig = [...compat.extends("next/core-web-vitals")];

export default eslintConfig;
