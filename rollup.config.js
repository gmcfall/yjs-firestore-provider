import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import typescript from "@rollup/plugin-typescript";
import peerDepsExternal from 'rollup-plugin-peer-deps-external';

const config = {
  input: ["./src/index.ts"],
  output: [
    {
      file: "build/index.cjs.js",
      format: "cjs",
      sourcemap: true,
    },
    {
      file: "build/index.esm.js",
      format: "esm",
      sourcemap: true,
    }
  ],
  plugins: [
    peerDepsExternal(),
    resolve(),
    commonjs(),
    typescript({
      tsconfig: "./tsconfig.json",
      declaration: true,
      declarationDir: "build",
      exclude: ["**/*.test.*", "**/*.stories.*", "./src/test-utils/*"],
    })
  ]
};

export default config;