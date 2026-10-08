# Code quality and source layout

Research reviewed on 8 October 2026 against the official documentation and npm registry.

## Tool choices

- [ESLint flat configuration](https://eslint.org/docs/latest/use/configure/configuration-files): ESLint 10.12.0 with `eslint.config.mjs`; no legacy eslintrc configuration.
- [Type-aware TypeScript linting](https://typescript-eslint.io/getting-started/typed-linting/): typescript-eslint 8.71.1 with `recommendedTypeChecked` and `projectService`. This catches unsafe values, misused promises, and other problems that syntax-only linting cannot see. Application code, Storybook, and TypeScript build configs use their existing tsconfig. Test TypeScript uses the syntax preset because its Vue mocks deliberately do not belong to the application typecheck project.
- [Supported compiler versions](https://typescript-eslint.io/users/dependency-versions/): retain TypeScript 5.9.3. The registry's latest compiler, 7.0.2, is outside the installed linter's supported `>=4.8.4 <6.1.0` range. A compiler migration needs its own compatibility review.
- [Vue essential rules](https://eslint.vuejs.org/user-guide/): check the existing `defineComponent` render-function components. These rules do not inspect Vue expressions in raw HTML partials; receiver interaction and Storybook tests cover those templates.
- [Separate formatting and linting](https://prettier.io/docs/integrating-with-linters): Prettier 3.9.9 handles formatting; `eslint-config-prettier` prevents conflicting rules. Tabs, single quotes, LF, and a 120-column target retain the project's existing style.
- [Explicit type imports](https://www.typescriptlang.org/tsconfig/verbatimModuleSyntax.html): `verbatimModuleSyntax`, `isolatedModules`, and `noImplicitOverride` supplement the existing `strict` compiler setting. This keeps imports predictable under Vite and requires intentional inherited method overrides.
- [Cloudflare TypeScript guidance](https://developers.cloudflare.com/workers/languages/typescript/): reviewed before including the existing Worker in linting. Bindings and runtime behavior are unchanged.

Do not enable every strict option by reflex. In particular, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` need a deliberate migration of the DSP buffers and public interfaces. Avoid fixing resulting errors by adding blanket non-null assertions.

## Commands

```sh
npm ci
npm run check           # lint, formatting, folder size, TypeScript
npm test -- --run       # client, UI, and Cloudflare Worker tests
npm run build          # includes nested DSP and transcription workers
npm run test:storybook # requires Playwright Chromium or PLAYWRIGHT_CHANNEL=chrome
npm run build:storybook
```

Use `npm run lint:fix` for safe lint fixes and `npm run format` for formatting. CI runs the checks on pushes and pull requests to master. Node 22.13+ or 24+ is required by the current ESLint release; CI uses Node 22.

## Lint enforcement

`npm run lint` reports every finding in maintained source, tests, and configuration, including existing code. There is no suppression baseline or separate debt command. VS Code and the CLI use the same flat configuration. Run **ESLint: Restart ESLint Server** if the editor retains old diagnostics after this migration.

TypeScript files are limited to 600 nonblank, noncomment lines, functions to 100, and cyclomatic complexity to 20. Split by responsibility and state ownership.

## Folder map

```text
src/
  index.ts                    Cloudflare HTTP handler
  client/
    app/
      core/                   receiver state, types, computed values
      radio/                  connection, tuning, gain, settings
      display/                canvas and zoom orchestration
      audio/                  playback and media session
      decoders/               decoder UI behavior
      workspace/              multiple receivers, bookmarks, sharing
      templates/              receiver HTML partials and assembly
    devices/
      hackrf/                 device adapter, USB driver, receive level
      limesdr/                adapter, transport, clocks, RX logic, protocol
      rtlsdr/                 adapter, USB transport, protocol
        tuners/               independent hardware tuner implementations
    display/                  waterfall rendering and frame timing
    platform/                 browser capability and ambient declarations
    radio/                    device contracts and gain/frequency utilities
    remote/                   WebRTC and receiver transport
    transcription/            model backend, worker, text and progress
    ui/
      controls/               inputs, buttons and their stories
      layout/                 panels, rows, headers and their stories
      feedback/               notices, badges, snackbars and stories
      dialogs/                dialog component and stories
      indicators/             frequency, chevron and lock indicators
    worker/
      runtime/                backend, WASM lifecycle, shared types
      streams/                RX pipeline, channel plan, remote delivery
      decoders/               RDS, POCSAG, rtl_433, SSB, mbelib
        dsd/                  digital voice protocols and error correction
    styles/                   CSS grouped by feature and responsive layout
test/                         matching feature groups plus server/ and ui/
```

`npm run check:structure` enforces at most 14 direct files in each source, test, and script folder. Generated and vendored directories are outside this policy. Prefer descriptive feature groups with a few cohesive files over a new folder for every file. Import concrete modules directly; `ui/index.ts` remains the public component registry.

`app/templates/receiver.ts` concatenates the raw HTML partials before Vue compiles them. They share the receiver scope, including refs and slots. Preserve ordering and element boundaries; these are partials rather than standalone components. `style.css` imports the feature styles in their original cascade order. Worker URL construction and the Vite post-build entry paths must be updated together whenever workers move.

Receiver instances, worker messages, and external data boundaries now have explicit contracts. Future template migration should preserve their props, events, and refs.
