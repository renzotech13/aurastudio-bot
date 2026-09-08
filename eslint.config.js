// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  {
    rules: {
      // `ignoreRestSiblings` es para el patrón de quitar una clave de un
      // objeto destructurando el resto (google.ts:58 reintenta el evento sin
      // `attendees` así). Sin esto `npm run lint` está en rojo en main.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
);
